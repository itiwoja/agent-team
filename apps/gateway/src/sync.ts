// EP-51 POST /gw/v1/connectors/{connectorId}/tools/sync（ツールの取得と変化の検出。mcp-taint.md §3.12.4、api-surface.md §3.17）。
// 1 コネクタの行からワークスペースを引き直す（本文はない）→ 境界（外れたら 422 CONNECTOR_NOT_ALLOWED と監査ログ connector.rejected：MT §3.12.3）
// 2 initialize → tools/list（nextCursor を最後まで。リダイレクトは追わない）。名前の形が外れたツールは登録しない
// 3 新しいツール → unclassified・ok・役割なし（tool_hash = toolHashOf(説明, 入力スキーマ, {})）。監査ログ connector.tool.added
// 4 説明・入力スキーマが変わった → needs_review（確定の定義と tool_hash は書き換えず pending に）・失効・合格証を切る。注釈だけなら needs_review にしない
// 5 一覧から消えた → needs_review（pending = null）・失効・合格証を切る
// tool_hash は確定の役割の map で計算する（MT §3.2。判定に使う役割 effectiveArgRoles は edge が ToolInfo を作るときに計算する）

import type { GwToolsSyncResponse } from "@open-team/gateway-client";
import { appendAuditLog, lockWorkspace, type ConnectorToolRow, type Json, type WsCtx } from "@open-team/db";
import {
  getConnector,
  insertConnectorTool,
  listConnectorTools,
  locateConnector,
  markConnectorSynced,
  markToolNeedsReview,
  updateToolAnnotations,
} from "@open-team/db/gateway";
import { canonicalJson, toolHashOf, type ToolHash } from "@open-team/kernel";
import { AppError } from "@open-team/platform";
import { connectorBoundary, isOwnConnector } from "./boundary.ts";
import { ConnectorAuthRequired, ConnectorAuthUnsupported, ConnectorTokenUnavailable, targetFor, type GatewayContext } from "./context.ts";
import { isUuid } from "./ids.ts";
import { describeFailure, openMcpSession, type McpToolDef } from "./mcp.ts";
import { applyToolChange, sameDefinition } from "./tool-change.ts";

/** 登録するツールの名前（DB の CHECK と同じ。MT §2.1 の toolNamePattern は 128 文字だが、列の CHECK に合わせる） */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

type SyncItem = GwToolsSyncResponse["tools"][number];

function canonicalOrNull(v: unknown): string | null {
  try {
    return canonicalJson(v);
  } catch {
    return null;
  }
}

function samePending(a: ConnectorToolRow["pending"], b: { description: string; inputSchema: Json } | null): boolean {
  if (a === null || b === null) return a === null && b === null;
  return sameDefinition({ description: b.description, inputSchema: b.inputSchema }, { description: a.description, inputSchema: a.inputSchema });
}

export async function syncConnectorTools(g: GatewayContext, connectorId: string, requestId: string | null): Promise<GwToolsSyncResponse> {
  if (!isUuid(connectorId)) throw new AppError("NOT_FOUND");
  const loc = await locateConnector(g.db, connectorId);
  if (!loc) throw new AppError("NOT_FOUND");
  const ctx: WsCtx = loc.ctx;
  const log = g.log.child({ workspaceId: ctx.workspaceId });
  const connector = await getConnector(g.db, ctx, connectorId);
  if (!connector) throw new AppError("NOT_FOUND");

  const boundary = connectorBoundary({
    simWorldOrigin: g.simWorldOrigin,
    workspaceKind: ctx.kind,
    rehearsalRunId: null,
    shadow: false,
    connectorUrl: connector.url,
    ownOAuthConnector: isOwnConnector(g, connector),
  });
  if (!boundary.ok) {
    const now = g.clock.now();
    await g.db.transaction((tx) =>
      appendAuditLog(
        tx,
        ctx.workspaceId,
        {
          eventType: "connector.rejected",
          actorType: "system",
          actorId: "gateway",
          payload: { connectorId: connector.id, slug: connector.slug, reasonCode: boundary.reasonCode },
        },
        now,
      ),
    );
    log.warn("gateway.connector_denied", "境界の外のコネクタの同期を断った", { connectorId: connector.id, reasonCode: boundary.reasonCode });
    throw new AppError("CONNECTOR_NOT_ALLOWED", undefined, { details: [{ reasonCode: boundary.reasonCode }] });
  }

  // tools/list（sim-world はワークスペースの頭が要る。デモ店舗がまだなくても固定の説明を返す）
  let target;
  try {
    target = await targetFor(
      g,
      connector,
      { workspaceId: ctx.workspaceId, rehearsalRunId: null, simExecutionId: null, taskId: null, intentId: null, shadow: false },
      requestId,
      "list",
    );
  } catch (e) {
    // 同期は資格情報を使わない（list）。それでも投げられたら、つながらない扱いにする
    if (e instanceof ConnectorAuthUnsupported || e instanceof ConnectorAuthRequired || e instanceof ConnectorTokenUnavailable) {
      throw new AppError("SIM_WORLD_UNAVAILABLE", undefined, { details: { reason: e instanceof ConnectorAuthUnsupported ? "auth_unsupported" : e.reason } });
    }
    throw e;
  }
  const opened = await openMcpSession(target, { fetch: g.fetch, listTimeoutMs: g.listTimeoutMs });
  if (!opened.ok) throw new AppError("SIM_WORLD_UNAVAILABLE", undefined, { details: { reason: describeFailure(opened.failure) } });
  let listed: McpToolDef[];
  try {
    const r = await opened.session.listTools();
    if (!r.ok) throw new AppError("SIM_WORLD_UNAVAILABLE", undefined, { details: { reason: describeFailure(r.failure) } });
    listed = r.tools;
  } finally {
    await opened.session.close();
  }

  // 名前の形が外れたもの・同じ名前の2つ目は登録しない（MT §3.12.4 の2）
  const server = new Map<string, McpToolDef>();
  for (const t of listed) {
    if (!TOOL_NAME_PATTERN.test(t.name)) {
      log.warn("gateway.tool_name_rejected", "名前の形が外れたツールを登録しなかった", { connectorId: connector.id, length: t.name.length });
      continue;
    }
    if (!server.has(t.name)) server.set(t.name, t);
  }

  const now = g.clock.now();
  const tools = await g.db.transaction(async (tx): Promise<SyncItem[]> => {
    await lockWorkspace(tx, ctx);
    // ロックのあとで読み直す（同時の同期・読み取りの変化の検出と二重にしない）
    const stillThere = await getConnector(tx, ctx, connector.id);
    if (!stillThere) throw new AppError("NOT_FOUND");
    const existing = new Map((await listConnectorTools(tx, ctx, connector.id)).map((t) => [t.name, t]));
    const out: SyncItem[] = [];
    for (const [name, def] of server) {
      const cur = existing.get(name);
      if (!cur) {
        const toolHash: ToolHash = toolHashOf({ description: def.description, inputSchema: def.inputSchema, argRoles: {} });
        const id = await insertConnectorTool(tx, ctx, connector.id, def, toolHash, now);
        await appendAuditLog(
          tx,
          ctx.workspaceId,
          { eventType: "connector.tool.added", actorType: "system", actorId: "gateway", payload: { connectorId: connector.id, toolId: id, tool: name, toolHash } },
          now,
        );
        out.push({ name, toolHash, status: "ok" });
        continue;
      }
      if (sameDefinition(def, { description: cur.description, inputSchema: cur.input_schema })) {
        // 注釈だけの変化は needs_review にしない（ハッシュに入れないため：DR-04）
        if (canonicalOrNull(def.annotations) !== canonicalOrNull(cur.annotations)) await updateToolAnnotations(tx, ctx, cur.id, def.annotations, now);
        out.push({ name, toolHash: cur.tool_hash, status: cur.status });
        continue;
      }
      // 変わった（DR-01・DR-03）
      if (cur.status === "ok") {
        await applyToolChange(tx, ctx, connector, cur, { kind: "changed", def }, "sync", now, log);
      } else if (!samePending(cur.pending, def)) {
        // すでに needs_review で、さらに別の定義になった：pending だけ新しくする（失効は前の変化で済んでいる）
        await markToolNeedsReview(tx, ctx, cur.id, { description: def.description, inputSchema: def.inputSchema, annotations: def.annotations, detectedAt: now.toISOString() }, now);
        await appendAuditLog(
          tx,
          ctx.workspaceId,
          {
            eventType: "connector.tool.needs_review",
            actorType: "system",
            actorId: "gateway",
            payload: { connectorId: connector.id, toolId: cur.id, tool: name, action: `mcp.${connector.slug}.${name}`, change: "changed", detectedBy: "sync", toolHash: cur.tool_hash },
          },
          now,
        );
      }
      out.push({ name, toolHash: cur.tool_hash, status: "needs_review" });
    }
    // 一覧から消えた（DR-06）
    for (const cur of existing.values()) {
      if (server.has(cur.name)) continue;
      if (cur.status === "ok") {
        await applyToolChange(tx, ctx, connector, cur, { kind: "removed" }, "sync", now, log);
      } else if (cur.pending !== null) {
        await markToolNeedsReview(tx, ctx, cur.id, null, now);
        await appendAuditLog(
          tx,
          ctx.workspaceId,
          {
            eventType: "connector.tool.needs_review",
            actorType: "system",
            actorId: "gateway",
            payload: { connectorId: connector.id, toolId: cur.id, tool: cur.name, action: `mcp.${connector.slug}.${cur.name}`, change: "removed", detectedBy: "sync", toolHash: cur.tool_hash },
          },
          now,
        );
      }
      out.push({ name: cur.name, toolHash: cur.tool_hash, status: "removed" });
    }
    await markConnectorSynced(tx, ctx, connector.id, now);
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  });
  log.info("gateway.sync", "ツールを同期した", {
    connectorId: connector.id,
    ok: tools.filter((t) => t.status === "ok").length,
    needsReview: tools.filter((t) => t.status === "needs_review").length,
    removed: tools.filter((t) => t.status === "removed").length,
  });
  return { tools };
}
