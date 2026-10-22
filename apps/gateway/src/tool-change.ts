// ツールの説明・入力スキーマの変化の検出（mcp-taint.md §3.12.4 checkToolDrift・§3.12.7、IA §3.17、BR-42）。
// 比べるのは description（取得したまま。trim しない）と inputSchema（正規形 JSON）だけ。注釈・title は比べない（MT D-04・DR-04）。
// ワークスペースのツールが変わったら：needs_review（確定の定義と tool_hash は書き換えず pending に新しい定義）、
// そのツールの承認待ちと未実行の approved を expired（tool_changed）、監査ログ

import {
  expireIntentsForTool,
  markToolNeedsReview,
  type ExpiredIntent,
} from "@open-team/db/gateway";
import { appendAuditLog, type ConnectorRow, type ConnectorToolRow, type Json, type Tx, type WsCtx } from "@open-team/db";
import { canonicalJson } from "@open-team/kernel";
import type { McpFailure, McpSession, McpToolDef } from "./mcp.ts";

export type DriftResult =
  | { kind: "same"; def: McpToolDef }
  | { kind: "changed"; def: McpToolDef }
  | { kind: "removed" }
  | { kind: "error"; failure: McpFailure };

function canonicalOrNull(v: unknown): string | null {
  try {
    return canonicalJson(v);
  } catch {
    return null;
  }
}

/** サーバーの定義が保存した確定の定義と同じか（description と inputSchema だけ） */
export function sameDefinition(def: Pick<McpToolDef, "description" | "inputSchema">, stored: { description: string; inputSchema: Json }): boolean {
  if (def.description !== stored.description) return false;
  const a = canonicalOrNull(def.inputSchema);
  return a !== null && a === canonicalOrNull(stored.inputSchema);
}

/** tools/list を取り直して、そのツールが変わったか（MT D-03：tools/call の直前に毎回） */
export async function checkToolDrift(session: McpSession, tool: Pick<ConnectorToolRow, "name" | "description" | "input_schema">): Promise<DriftResult> {
  const listed = await session.listTools();
  if (!listed.ok) return { kind: "error", failure: listed.failure };
  const def = listed.tools.find((t) => t.name === tool.name);
  if (!def) return { kind: "removed" };
  return sameDefinition(def, { description: tool.description, inputSchema: tool.input_schema }) ? { kind: "same", def } : { kind: "changed", def };
}

export type ToolChangeKind = "changed" | "removed";
export type ToolChangeDetectedBy = "sync" | "tools_call" | "execute";

export interface AppliedToolChange {
  expired: ExpiredIntent[];
}

/**
 * ワークスペースのツールを needs_review にし、失効までを1つのトランザクションで行う（MT §3.12.4 の4・5、§3.12.7）。
 * ワークスペースの行は呼び出し側がロック済み（M-21）
 */
export async function applyToolChange(
  tx: Tx,
  ctx: WsCtx,
  connector: Pick<ConnectorRow, "id" | "slug">,
  tool: Pick<ConnectorToolRow, "id" | "name" | "tool_hash">,
  change: { kind: "changed"; def: McpToolDef } | { kind: "removed" },
  detectedBy: ToolChangeDetectedBy,
  now: Date,
): Promise<AppliedToolChange> {
  const action = `mcp.${connector.slug}.${tool.name}`;
  await markToolNeedsReview(
    tx,
    ctx,
    tool.id,
    change.kind === "changed"
      ? { description: change.def.description, inputSchema: change.def.inputSchema, annotations: change.def.annotations, detectedAt: now.toISOString() }
      : null,
    now,
  );
  const expired = await expireIntentsForTool(tx, ctx, { connectorId: connector.id, name: tool.name }, now);
  await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "connector.tool.needs_review",
      actorType: "system",
      actorId: "gateway",
      payload: {
        connectorId: connector.id,
        toolId: tool.id,
        tool: tool.name,
        action,
        change: change.kind,
        detectedBy,
        toolHash: tool.tool_hash,
        expiredIntentIds: expired.map((e) => e.intentId),
      },
    },
    now,
  );
  return { expired };
}
