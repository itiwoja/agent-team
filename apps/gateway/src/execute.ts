// EP-50 POST /gw/v1/intents/{intentId}/execute（書き込みの実行。FR-012 の MCP 版：intents-approvals.md §3.12、mcp-taint.md §3.12.6、
// api-surface.md §3.17、D-18・BR-59、M-20・M-21）。
// 1 Intent の行からワークスペース・タスクを引き直す（タスクのトークン・本文は使わない：IA §8-23）
// 2 ワークスペース → タスク → Intent の順にロックして前提を確かめる（状態が approved・Kill Switch・タスクの終了・境界・intentHash の再計算・
//   無効なコネクタ・needs_review・tool_hash の一致）。外れたら終わりの状態を書いて返す
// 3 tools/list を取り直して説明の変化（トランザクションの外で）→ もう一度ロックして確かめ直し、executing をコミット
// 4 tools/call（引数はそのまま、60秒）→ 結果の表（IA §3.12 の4）。送信前の失敗だけ approved に戻して最大3回（1・4・16秒の待ち。
//   この1回の要求の中で：G-02）、送信後のタイムアウト・接続断・5xx は unknown_outcome で再試行しない
// 5 タスクの状態を決め直す（IA §3.18）
// Gateway は decide を呼ばない（M-20。policyHash の再判定は app が gateway を呼ぶ前に行う）。
// 承認の出どころ（SG-03）：本番のタスクの Intent は、Kernel の判定の行・人の承認の行（と approval.decided）・ルールの allow ならルールの記録を
// 照合し、欠けていれば failed(precondition_failed)・reasonCode approval_provenance にする（provenance.ts の冒頭）

import type { GwExecuteResponse } from "@open-team/gateway-client";
import { appendAuditLog, lockWorkspace, type ActionIntentRow, type ConnectorRow, type ConnectorToolRow, type Json, type Tx, type WsCtx } from "@open-team/db";
import {
  completeIntent,
  getConnector,
  getConnectorTool,
  getIntent,
  lockIntent,
  lockTask,
  locateIntent,
  markIntentExecuting,
  recomputeTaskStatus,
  recordGatewayDecision,
  recordPresendFailure,
  type GatewayTaskRow,
  type IntentCompletion,
} from "@open-team/db/gateway";
import { computeMcpIntentHash, type JsonObject } from "@open-team/kernel";
import { AppError } from "@open-team/platform";
import { connectorBoundary, isOwnConnector, originOf } from "./boundary.ts";
import { ConnectorAuthRequired, ConnectorAuthUnsupported, ConnectorTokenUnavailable, targetFor, type GatewayContext } from "./context.ts";
import { isUuid } from "./ids.ts";
import { describeFailure, openMcpSession, type CallOutcome, type McpFailure, type McpSession } from "./mcp.ts";
import { PROVENANCE_REASON, checkProvenance } from "./provenance.ts";
import { maskAndLimit, toolResultText } from "./result-text.ts";
import { applyToolChange, checkToolDrift, type DriftResult } from "./tool-change.ts";

const TERMINAL = new Set(["succeeded", "completed", "rejected", "failed", "cancelled", "halted"]);

/** Intent の今の状態を応答にする（approved でないものを2回目の実行で返す。返せない状態は null → 409） */
export function responseOf(i: Pick<ActionIntentRow, "id" | "status" | "fail_reason" | "expire_reason">): GwExecuteResponse | null {
  switch (i.status) {
    case "executed":
    case "verified":
      return { intentId: i.id, status: "executed", failReason: null, expiredReason: null };
    case "failed":
      return { intentId: i.id, status: "failed", failReason: i.fail_reason, expiredReason: null };
    case "unknown_outcome":
      return { intentId: i.id, status: "unknown_outcome", failReason: null, expiredReason: null };
    case "expired":
      return { intentId: i.id, status: "expired", failReason: null, expiredReason: i.expire_reason };
    case "approved":
      return { intentId: i.id, status: "approved", failReason: null, expiredReason: null };
    default:
      return null;
  }
}

function finalResponse(i: Pick<ActionIntentRow, "id" | "status" | "fail_reason" | "expire_reason">): GwExecuteResponse {
  const r = responseOf(i);
  // proposed・pending_approval・denied・rejected・simulated・executing（別の処理が実行中）は実行できない
  if (r === null) throw new AppError("INTENT_CHANGED", "Intent は実行できる状態ではありません", { details: { status: i.status } });
  return r;
}

type Prepared =
  | { kind: "final"; response: GwExecuteResponse }
  | {
      kind: "ready";
      task: GatewayTaskRow;
      intent: ActionIntentRow;
      connector: ConnectorRow;
      tool: ConnectorToolRow;
    };

interface ExecCtx {
  g: GatewayContext;
  ctx: WsCtx;
  taskId: string;
  intentId: string;
}

function payloadOf(intent: ActionIntentRow): { connectorId: string; tool: string; arguments: JsonObject; toolHash: string } {
  return intent.payload as unknown as { connectorId: string; tool: string; arguments: JsonObject; toolHash: string };
}

/** 保存した値から intentHash を計算し直す（ADR-005、BR-15、AS:1142）。列と payload の食い違いも改ざんとみなす */
export function intentIntegrityOk(intent: ActionIntentRow, connector: Pick<ConnectorRow, "id" | "slug">): boolean {
  const p = payloadOf(intent);
  if (p === null || typeof p !== "object" || typeof p.tool !== "string" || typeof p.toolHash !== "string") return false;
  if (p.arguments === null || typeof p.arguments !== "object" || Array.isArray(p.arguments)) return false;
  if (p.connectorId !== intent.connector_id || connector.id !== intent.connector_id) return false;
  if (p.toolHash !== intent.tool_hash) return false;
  if (intent.action !== `mcp.${connector.slug}.${p.tool}`) return false;
  try {
    const recomputed = computeMcpIntentHash({
      connectorId: p.connectorId,
      tool: p.tool,
      arguments: p.arguments,
      toolHash: p.toolHash as `sha256:${string}`,
      effectivePolicyHash: intent.policy_hash,
    });
    return recomputed === intent.intent_hash;
  } catch {
    return false;
  }
}

async function audit(tx: Tx, e: ExecCtx, eventType: string, payload: JsonObject, now: Date): Promise<void> {
  await appendAuditLog(tx, e.ctx.workspaceId, { eventType, actorType: "system", actorId: "gateway", taskId: e.taskId, payload: { taskId: e.taskId, intentId: e.intentId, ...payload } }, now);
}

/** Intent を終わりの状態にして、監査ログとタスクの決め直しまで（同じトランザクション） */
async function finish(
  tx: Tx,
  e: ExecCtx,
  intent: Pick<ActionIntentRow, "action" | "status">,
  from: "approved" | "executing",
  c: IntentCompletion,
  event: { type: string; payload: JsonObject },
  now: Date,
): Promise<GwExecuteResponse> {
  const ok = await completeIntent(tx, e.ctx, e.intentId, [from], c, now);
  if (ok) {
    await audit(tx, e, event.type, { action: intent.action, ...event.payload }, now);
    await recomputeTaskStatus(tx, e.ctx, e.taskId, now);
  }
  const cur = await getIntent(tx, e.ctx, e.intentId);
  if (!cur) throw new AppError("NOT_FOUND");
  return finalResponse(cur);
}

function failedEvent(failReason: string, payload: JsonObject = {}): { type: string; payload: JsonObject } {
  return { type: "action.failed", payload: { failReason, ...payload } };
}
function expiredEvent(reason: string, payload: JsonObject = {}): { type: string; payload: JsonObject } {
  return { type: "intent.expired", payload: { reason, ...payload } };
}

/**
 * 前提の確認（IA §3.12 の2、AS §3.17 EP-50 の1〜5）。drift が null なら確かめるだけ（1回目）、drift があれば
 * 説明の変化を反映し、通れば executing にしてコミットする（2回目）
 */
async function prepare(tx: Tx, e: ExecCtx, drift: DriftResult | null, now: Date): Promise<Prepared> {
  const { g, ctx } = e;
  const ws = await lockWorkspace(tx, ctx);
  const task = await lockTask(tx, ctx, e.taskId);
  const intent = await lockIntent(tx, ctx, e.intentId);
  if (!ws || !task || !intent) throw new AppError("NOT_FOUND");
  // 2-1：approved でなければ何もしない（二重のジョブ・期限切れ・Kill Switch で無効になったもの：G-2・G-3）
  if (intent.status !== "approved") return { kind: "final", response: finalResponse(intent) };
  const fail = async (reasonCode: string, extra: JsonObject = {}): Promise<Prepared> => ({
    kind: "final",
    response: await finish(
      tx,
      e,
      intent,
      "approved",
      { status: "failed", failReason: "precondition_failed", result: { reasonCode, ...extra } },
      failedEvent("precondition_failed", { reasonCode, ...extra }),
      now,
    ),
  });
  const expire = async (reason: "task_ended" | "tool_changed", detail: string): Promise<Prepared> => ({
    kind: "final",
    response: await finish(
      tx,
      e,
      intent,
      "approved",
      { status: "expired", expireReason: reason, result: { reasonCode: reason, detail } },
      expiredEvent(reason, { detail }),
      now,
    ),
  });

  // 2-2：Kill Switch（ワークスペースの行をロックしたあとに読む：発動と直列）
  if (ws.kill_switch_engaged) return fail("kill_switch");
  // 2-3：タスクが終了状態（IA §8-7 の推奨：expired(task_ended)）
  if (TERMINAL.has(task.status)) return expire("task_ended", task.status);

  const connector = await getConnector(tx, ctx, intent.connector_id);
  if (!connector) return fail("connector_not_found");
  // 2-4：境界（BR-64）
  const boundary = connectorBoundary({ workspaceKind: ctx.kind, ownOAuthConnector: isOwnConnector(g, connector) });
  if (!boundary.ok) {
    await recordGatewayDecision(
      tx,
      ctx,
      {
        taskId: e.taskId,
        intentId: e.intentId,
        subjectKind: "intent",
        operation: "mcp_write",
        subject: { action: intent.action, connectorId: connector.id, tool: payloadOf(intent).tool },
        inputs: { workspaceKind: ctx.kind, connectorOrigin: originOf(connector.url) },
        reasonCode: boundary.reasonCode,
        matchedRule: `boundary.${boundary.reasonCode}`,
        enforced: true,
      },
      now,
    );
    g.log.warn("gateway.connector_denied", "境界の外のコネクタへの書き込みを止めた", {
      workspaceId: ctx.workspaceId,
      taskId: e.taskId,
      intentId: e.intentId,
      reasonCode: boundary.reasonCode,
    });
    return fail(boundary.reasonCode);
  }
  // 保存した値から intentHash を計算し直す（ADR-005。外れたら failed(precondition_failed)：AS §3.17 EP-50 の4・T-158）
  if (!intentIntegrityOk(intent, connector)) return fail("intent_hash_mismatch");
  // SG-03：判定が実際に行われた証拠（Kernel の判定の行と監査ログ・人の承認・ルールの記録・実行の履歴）を照合する。decide は呼ばない（存在と一致だけ）
  const provenance = await checkProvenance(tx, ctx, { task, intent });
  if (!provenance.ok) {
    await recordGatewayDecision(
      tx,
      ctx,
      {
        taskId: e.taskId,
        intentId: e.intentId,
        subjectKind: "intent",
        operation: "mcp_write",
        subject: { action: intent.action, connectorId: connector.id, tool: payloadOf(intent).tool },
        inputs: { decision: intent.decision, reasonCode: intent.reason_code, matchedRule: intent.matched_rule, detail: provenance.detail },
        reasonCode: PROVENANCE_REASON,
        matchedRule: `provenance.${provenance.detail}`,
        enforced: true,
      },
      now,
    );
    // 証拠の欠け・食い違いは app（ot_app）の乗っ取りの兆候なので、境界の拒否（warn）より強い error で出す（tool-change.ts の権限の欠けと同じ段）
    g.log.error("gateway.approval_provenance", "判定・承認の証拠が欠けた Intent の実行を止めた（app の乗っ取りの兆候）", {
      workspaceId: ctx.workspaceId,
      taskId: e.taskId,
      intentId: e.intentId,
      detail: provenance.detail,
    });
    return fail(PROVENANCE_REASON, { detail: provenance.detail });
  }
  // 無効にしたコネクタへは書かない（decide の手順5 と同じ条件。承認のあとに無効にした場合）
  if (!connector.enabled) return fail("connector_disabled");

  const p = payloadOf(intent);
  const tool = await getConnectorTool(tx, ctx, connector.id, p.tool);
  // MT §3.12.6 の4・5：needs_review・tool_hash の違い → expired(tool_changed)、tools/call しない（owner の arg_roles の変更もここで止まる）
  if (!tool) return expire("tool_changed", "tool_missing");
  if (tool.status === "needs_review") return expire("tool_changed", "needs_review");
  if (tool.tool_hash !== p.toolHash) return expire("tool_changed", "tool_hash");

  if (drift === null) return { kind: "ready", task, intent, connector, tool };

  if (drift.kind === "changed" || drift.kind === "removed") {
    const decision = {
      taskId: e.taskId,
      intentId: e.intentId,
      subjectKind: "intent" as const,
      operation: "mcp_write" as const,
      subject: { action: intent.action, connectorId: connector.id, tool: p.tool },
      inputs: { change: drift.kind, toolHash: tool.tool_hash, detectedBy: "execute" },
      reasonCode: drift.kind === "removed" ? "tool_removed" : "tool_needs_review",
      matchedRule: `gateway.tool_${drift.kind}`,
      enforced: true,
    };
    await recordGatewayDecision(tx, ctx, decision, now);
    // ワークスペースのツールを needs_review にし、承認待ち・未実行の Intent（この Intent も）を失効させる（DR-02）
    await applyToolChange(tx, ctx, connector, tool, drift.kind === "changed" ? { kind: "changed", def: drift.def } : { kind: "removed" }, "execute", now);
    const cur = await getIntent(tx, ctx, e.intentId);
    if (cur && cur.status !== "approved") return { kind: "final", response: finalResponse(cur) };
    return expire("tool_changed", `drift_${drift.kind}`);
  }

  // 2-7：executing をコミット（このトランザクションの終わりで）
  if (!(await markIntentExecuting(tx, ctx, e.intentId, now))) {
    const cur = await getIntent(tx, ctx, e.intentId);
    if (!cur) throw new AppError("NOT_FOUND");
    return { kind: "final", response: finalResponse(cur) };
  }
  // SG-03：送り始めたことを追記だけの監査ログに残す（同じトランザクション）。approved に戻すのは送信前の失敗（action.presend_retry）だけなので、
  // 開始と戻しの数が合わない Intent は「実行済みを approved に書き戻した」ものとして provenance.ts が止める
  await audit(tx, e, "action.started", { action: intent.action, attempt: intent.presend_attempts + 1 }, now);
  await recomputeTaskStatus(tx, ctx, e.taskId, now);
  return { kind: "ready", task, intent, connector, tool };
}

type AttemptResult = { kind: "done"; response: GwExecuteResponse } | { kind: "retry"; waitMs: number };

/** 送信前の失敗を数える（D-18）。from は今の状態 */
async function presendFailure(e: ExecCtx, from: "approved" | "executing", detail: string): Promise<AttemptResult> {
  const { g, ctx } = e;
  const now = g.clock.now();
  return g.db.transaction(
    async (tx): Promise<AttemptResult> => {
      await lockWorkspace(tx, ctx);
      await lockTask(tx, ctx, e.taskId);
      const intent = await lockIntent(tx, ctx, e.intentId);
      if (!intent) throw new AppError("NOT_FOUND");
      const r = await recordPresendFailure(tx, ctx, e.intentId, from, { reasonCode: "unreachable", detail, attempts: intent.presend_attempts + 1 }, now);
      if ("skipped" in r) return { kind: "done", response: finalResponse(intent) };
      if (r.retry) {
        // SG-03：approved に戻したことを残す（from = executing の戻しは action.started と1対1。provenance.ts の再実行の照合）
        await audit(tx, e, "action.presend_retry", { action: intent.action, from, attempts: r.attempts, detail }, now);
        await recomputeTaskStatus(tx, ctx, e.taskId, now);
        g.log.warn("gateway.presend_retry", "送信前の失敗。approved に戻して再試行する", {
          workspaceId: ctx.workspaceId,
          taskId: e.taskId,
          intentId: e.intentId,
          attempts: r.attempts,
          detail,
        });
        return { kind: "retry", waitMs: g.presendBackoffMs[r.attempts - 1] ?? g.presendBackoffMs.at(-1) ?? 0 };
      }
      await audit(tx, e, "action.failed", { action: intent.action, failReason: "unreachable", detail, attempts: r.attempts + 1 }, now);
      await recomputeTaskStatus(tx, ctx, e.taskId, now);
      const cur = await getIntent(tx, ctx, e.intentId);
      return { kind: "done", response: finalResponse(cur ?? intent) };
    },
    { retryOnce: true },
  );
}

/** 認証の失敗（401・403、0-H で証明できない認証）→ failed(auth_required)。再試行しない（IA §3.12 の表） */
async function authFailure(e: ExecCtx, from: "approved" | "executing", detail: JsonObject): Promise<GwExecuteResponse> {
  const { g, ctx } = e;
  const now = g.clock.now();
  return g.db.transaction(async (tx) => {
    await lockWorkspace(tx, ctx);
    await lockTask(tx, ctx, e.taskId);
    const intent = await lockIntent(tx, ctx, e.intentId);
    if (!intent) throw new AppError("NOT_FOUND");
    if (intent.status !== from) return finalResponse(intent);
    return finish(tx, e, intent, from, { status: "failed", failReason: "auth_required", result: detail }, failedEvent("auth_required", detail), now);
  });
}

/** tools/call の結果を書く（IA §3.12 の4 の表）。executing のときだけ */
async function finalize(e: ExecCtx, out: Exclude<CallOutcome, { kind: "presend_failure" }>, callSecrets: readonly string[]): Promise<GwExecuteResponse> {
  const { g, ctx } = e;
  const now = g.clock.now();
  return g.db.transaction(async (tx) => {
    await lockWorkspace(tx, ctx);
    await lockTask(tx, ctx, e.taskId);
    const intent = await lockIntent(tx, ctx, e.intentId);
    if (!intent) throw new AppError("NOT_FOUND");
    if (intent.status !== "executing") {
      // 掃除（EXECUTING_STUCK_AFTER_MS）が先に unknown_outcome にしたなど。上書きしない
      g.log.warn("gateway.execute_state_changed", "実行中に Intent の状態が変わった", { intentId: e.intentId, status: intent.status });
      return finalResponse(intent);
    }
    const base: JsonObject = { decision: intent.decision, reasonCode: intent.reason_code, presendAttempts: intent.presend_attempts };
    switch (out.kind) {
      case "ok":
      case "is_error": {
        const { text, truncated } = maskAndLimit(toolResultText(out.result), [...g.knownSecrets, ...callSecrets]);
        const result: Json = { content: text, isError: out.kind === "is_error", truncated };
        return out.kind === "ok"
          ? finish(tx, e, intent, "executing", { status: "executed", result }, { type: "action.executed", payload: { ...base, truncated } }, now)
          : finish(tx, e, intent, "executing", { status: "failed", failReason: "tool_error", result }, failedEvent("tool_error", { ...base, isError: true }), now);
      }
      case "auth_error":
        return finish(
          tx,
          e,
          intent,
          "executing",
          { status: "failed", failReason: "auth_required", result: { status: out.status } },
          failedEvent("auth_required", { ...base, status: out.status }),
          now,
        );
      case "tool_error":
        return finish(
          tx,
          e,
          intent,
          "executing",
          { status: "failed", failReason: "tool_error", result: { detail: out.detail } },
          failedEvent("tool_error", { ...base, detail: out.detail }),
          now,
        );
      case "postsend_unknown":
        // 送信後に分からない：再試行しない（BR-59）。以後この宛先は承認へ（BR-68。edge の unknownOutcomeKeys）
        return finish(
          tx,
          e,
          intent,
          "executing",
          { status: "unknown_outcome", result: { outcome: "unknown", detail: out.detail } },
          { type: "action.unknown_outcome", payload: { ...base, detail: out.detail } },
          now,
        );
    }
  });
}

/** MCP の失敗（つなぐ・tools/list）を実行の結果に直す：401・403 は認証の失敗、それ以外は送信前の失敗（書き込みはまだ送っていない） */
async function preCallFailure(e: ExecCtx, f: McpFailure): Promise<AttemptResult> {
  if (f.kind === "auth") return { kind: "done", response: await authFailure(e, "approved", { status: f.status }) };
  return presendFailure(e, "approved", describeFailure(f));
}

/** 1回の試み（つなぐ → 説明の変化 → executing → tools/call → 結果） */
async function attempt(e: ExecCtx): Promise<AttemptResult> {
  const { g, ctx } = e;
  const pre = await g.db.transaction((tx) => prepare(tx, e, null, g.clock.now()), { retryOnce: true });
  if (pre.kind === "final") return { kind: "done", response: pre.response };

  const p = payloadOf(pre.intent);
  let target;
  try {
    target = await targetFor(g, pre.connector, e.intentId, "call");
  } catch (err) {
    // 資格情報がない・取り消された・Google が拒んだ → auth_required（送っていない・再試行しない）
    if (err instanceof ConnectorAuthUnsupported) return { kind: "done", response: await authFailure(e, "approved", { detail: "auth_unsupported" }) };
    if (err instanceof ConnectorAuthRequired) return { kind: "done", response: await authFailure(e, "approved", { detail: err.reason }) };
    // Google の token が取れない（届かない・5xx）→ 送信前の失敗として数える（再試行してよい：D-18）
    if (err instanceof ConnectorTokenUnavailable) return presendFailure(e, "approved", `token_${err.reason}`);
    throw err;
  }
  const opened = await openMcpSession(target, { fetch: g.fetch, listTimeoutMs: g.listTimeoutMs });
  if (!opened.ok) return preCallFailure(e, opened.failure);
  const session: McpSession = opened.session;
  try {
    // 説明の変化
    const drift: DriftResult = await checkToolDrift(session, pre.tool);
    if (drift.kind === "error") return preCallFailure(e, drift.failure);
    const go = await g.db.transaction((tx) => prepare(tx, e, drift, g.clock.now()), { retryOnce: true });
    if (go.kind === "final") return { kind: "done", response: go.response };

    // 引数はそのまま渡す（BR-15。承認カードに出したものと同じ）
    const out = await session.callTool(p.tool, p.arguments, g.callTimeoutMs);
    if (out.kind === "presend_failure") return presendFailure(e, "executing", out.detail);
    const response = await finalize(e, out, target.secrets ?? []);
    g.log.info("gateway.execute", `書き込みを実行した：${response.status}`, {
      workspaceId: ctx.workspaceId,
      taskId: e.taskId,
      intentId: e.intentId,
      outcome: out.kind,
      status: response.status,
    });
    return { kind: "done", response };
  } finally {
    await session.close();
  }
}

/**
 * Intent の実行（EP-50）。送信前の失敗は approved に戻して最大3回まで、この要求の中で待って再試行する（D-18、G-02）。
 * 待っている間に呼び出し元が切れた（signal）ら、approved のまま返す（毎分の起こしが拾い直す）
 */
export async function executeIntent(g: GatewayContext, intentId: string, opts: { signal?: AbortSignal } = {}): Promise<GwExecuteResponse> {
  if (!isUuid(intentId)) throw new AppError("NOT_FOUND");
  const loc = await locateIntent(g.db, intentId);
  if (!loc) throw new AppError("NOT_FOUND");
  const e: ExecCtx = { g, ctx: loc.ctx, taskId: loc.taskId, intentId };
  for (;;) {
    const r = await attempt(e);
    if (r.kind === "done") return r.response;
    await g.sleep(r.waitMs, opts.signal);
    if (opts.signal?.aborted) return { intentId, status: "approved", failReason: null, expiredReason: null };
  }
}
