// EP-49 POST /gw/v1/tools/call（読み取り。mcp-taint.md §3.12.5、api-surface.md §3.17、SO §3.10）。
// タスクは X-Task-Token から DB で引き直す（本文の workspaceId などは読まない：15:486・520、T-155）。
// 境界（ゲスト）→ 分類が read でなければ拒否（書き込みは EP-50 の Intent の実行だけ：MT D-15）→
// needs_review → tools/list を取り直して説明の変化（MT D-03）→ tools/call（60秒）→ 64KB で切ってマスク。
// 拒否は 200 { ok: false, reasonCode }（edge が判定の記録に使う：AS §3.17 の7）。拒否の文はこちらが作る固定の値だけ（汚染しない：MT D-27）

import type { GwRejectReason, GwToolsCallRequest, GwToolsCallResponse } from "@open-team/gateway-client";
import { lockWorkspace } from "@open-team/db";
import {
  getConnector,
  getConnectorTool,
  recordGatewayDecision,
  resolveTaskByToken,
  type GatewayTask,
} from "@open-team/db/gateway";
import { AppError } from "@open-team/platform";
import { connectorBoundary, isOwnConnector, originOf } from "./boundary.ts";
import { ConnectorAuthRequired, ConnectorAuthUnsupported, ConnectorTokenUnavailable, targetFor, type GatewayContext } from "./context.ts";
import { describeFailure, openMcpSession, type McpFailure } from "./mcp.ts";
import { maskAndLimit, toolResultText } from "./result-text.ts";
import { applyToolChange, checkToolDrift, sameDefinition } from "./tool-change.ts";

const reject = (reasonCode: GwRejectReason): GwToolsCallResponse => ({ ok: false, reasonCode });

function failureReason(f: McpFailure): GwRejectReason {
  return f.kind === "timeout" ? "timeout" : "upstream_error";
}

/** 読み取りの実行（EP-49）。トークンが不正なら 401、タスクが終わっている・Kill Switch なら 409 TASK_HALTED を投げる */
export async function callReadTool(
  g: GatewayContext,
  rawToken: string | undefined,
  body: GwToolsCallRequest,
): Promise<GwToolsCallResponse> {
  const now = g.clock.now();
  const auth = await resolveTaskByToken(g.db, rawToken, now);
  if (!auth.ok) {
    if (auth.error === "UNAUTHORIZED") throw new AppError("UNAUTHORIZED", "タスクのトークンが不正か期限切れです");
    throw new AppError("TASK_HALTED", undefined, { details: { haltReason: auth.haltReason } });
  }
  const task = auth.task;
  const ctx = task.ctx;
  const log = g.log.child({ workspaceId: ctx.workspaceId, taskId: task.taskId });
  const done = (res: GwToolsCallResponse, extra: Record<string, unknown> = {}): GwToolsCallResponse => {
    log.info("gateway.tool_call", res.ok ? "読み取りを返した" : `読み取りを拒否した：${res.reasonCode}`, {
      connectorId: body.connectorId,
      tool: body.tool,
      toolCallId: body.toolCallId,
      outcome: res.ok ? (res.isError ? "is_error" : "ok") : res.reasonCode,
      ...extra,
    });
    return res;
  };

  // 別のワークスペースのコネクタは無いのと同じ（09_api/common.md:95）
  const connector = await getConnector(g.db, ctx, body.connectorId);
  if (!connector) return done(reject("connector_not_found"));
  const action = `mcp.${connector.slug}.${body.tool}`;
  const subject = { action, connectorId: connector.id, tool: body.tool, toolCallId: body.toolCallId };

  const boundary = connectorBoundary({ workspaceKind: ctx.kind, ownOAuthConnector: isOwnConnector(g, connector) });
  if (!boundary.ok) {
    await g.db.transaction((tx) =>
      recordGatewayDecision(
        tx,
        ctx,
        {
          taskId: task.taskId,
          intentId: null,
          subjectKind: "tool_call",
          operation: "mcp_read",
          subject,
          inputs: boundaryInputsOf(task, connector.url),
          reasonCode: boundary.reasonCode,
          matchedRule: `boundary.${boundary.reasonCode}`,
          enforced: true,
        },
        now,
      ),
    );
    log.warn("gateway.connector_denied", "境界の外のコネクタを拒否した", { reasonCode: boundary.reasonCode, connectorId: connector.id });
    return done(reject(boundary.reasonCode));
  }

  if (!connector.enabled) return done(reject("connector_disabled"));
  const tool = await getConnectorTool(g.db, ctx, connector.id, body.tool);
  if (!tool) return done(reject("unknown_action"));
  if (tool.classification !== "read") return done(reject("tool_not_read"));
  if (tool.status === "needs_review") return done(reject("tool_needs_review"));

  let target;
  try {
    target = await targetFor(g, connector, null, "call");
  } catch (e) {
    if (e instanceof ConnectorAuthUnsupported) return done(reject("upstream_error"), { detail: e.message });
    if (e instanceof ConnectorAuthRequired) return done(reject("upstream_error"), { detail: `auth_${e.reason}` });
    if (e instanceof ConnectorTokenUnavailable) return done(reject("upstream_error"), { detail: `token_${e.reason}` });
    throw e;
  }
  const opened = await openMcpSession(target, { fetch: g.fetch, listTimeoutMs: g.listTimeoutMs });
  if (!opened.ok) return done(reject(failureReason(opened.failure)), { detail: describeFailure(opened.failure) });
  const session = opened.session;
  try {
    const drift = await checkToolDrift(session, tool);
    if (drift.kind === "error") return done(reject(failureReason(drift.failure)), { detail: describeFailure(drift.failure) });
    if (drift.kind === "changed" || drift.kind === "removed") {
      const code: GwRejectReason = drift.kind === "removed" ? "tool_removed" : "tool_needs_review";
      const decision = {
        taskId: task.taskId,
        intentId: null,
        subjectKind: "tool_call" as const,
        operation: "mcp_read" as const,
        subject,
        inputs: { change: drift.kind, toolHash: tool.tool_hash, detectedBy: "tools_call" },
        reasonCode: code,
        matchedRule: `gateway.tool_${drift.kind}`,
        enforced: true,
      };
      await g.db.transaction(async (tx) => {
        await lockWorkspace(tx, ctx);
        // ロックのあとで読み直し、まだ同じ確定の定義で ok のときだけ needs_review にする（同時の同期と二重にしない）
        const cur = await getConnectorTool(tx, ctx, connector.id, tool.name);
        if (cur && cur.status === "ok" && sameDefinition({ description: tool.description, inputSchema: tool.input_schema }, { description: cur.description, inputSchema: cur.input_schema })) {
          await applyToolChange(tx, ctx, connector, cur, drift.kind === "changed" ? { kind: "changed", def: drift.def } : { kind: "removed" }, "tools_call", now);
        }
        await recordGatewayDecision(tx, ctx, decision, now);
      });
      return done(reject(code), { change: drift.kind });
    }

    // 引数はそのまま渡す（BR-15。読み取りも書き換えない）
    const out = await session.callTool(tool.name, body.arguments, g.callTimeoutMs);
    switch (out.kind) {
      case "ok":
      case "is_error": {
        const { text, truncated } = maskAndLimit(toolResultText(out.result), [...g.knownSecrets, ...(target.secrets ?? [])]);
        return done({ ok: true, content: text, isError: out.kind === "is_error", truncated });
      }
      case "postsend_unknown":
        return done(reject(out.detail === "timeout" ? "timeout" : "upstream_error"), { detail: out.detail });
      default:
        return done(reject("upstream_error"), { detail: out.kind === "auth_error" ? `http_${out.status}` : out.detail });
    }
  } finally {
    await session.close();
  }
}

/** 境界の判定の入力（policy_decisions.flags に残す。URL は origin だけ） */
export function boundaryInputsOf(task: Pick<GatewayTask, "ctx">, connectorUrl: string): Record<string, string | null> {
  return { workspaceKind: task.ctx.kind, connectorOrigin: originOf(connectorUrl) };
}
