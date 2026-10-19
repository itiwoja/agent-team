// ツールの実行（edge の callTool。formation-runtime.md §3.11・§3.12、M-30）
// runner は toolCallId だけを渡し、edge は LLM Proxy が判定のときに記録した引数で実行する（判定と違う引数で実行させない）。
// 判定の記録がない・allow でない・Intent にした書き込み・実行済み → 403 TOOL_CALL_NOT_ALLOWED。
// 読み取りは gateway の EP-49 → 汚染を記録（コミット）してから wrapUntrusted で返す（BR-38、MT §3.10-8d）。submit_report は報告を保存（API-056）

import { addTaintSource, sha256Hex, wrapUntrusted, type JsonObject, type TaintState } from "@open-team/kernel";
import { EdgeError, toolErrorText, type ToolCallResult } from "@open-team/runner";
import { GatewayClientError, type GwRejectReason } from "@open-team/gateway-client";
import { maskSecrets } from "@open-team/platform";
import { appendAuditLog, lockWorkspace, type PolicyDecisionRow, type ReportSource, type TaskRow, type WsCtx } from "@open-team/db";
import {
  claimToolCallExecution,
  findConnectorTool,
  findToolCallDecision,
  insertTaskEvent,
  listAskMembers,
  lockTask,
  revokeTaskToken,
  saveTaskReport,
  setTaskTaint,
} from "@open-team/db/edge";
import { finalizeTaskAfterLoop } from "./halt.ts";
import { notifyTerminal, runHook, type EdgeRuntime } from "./runtime.ts";
import { argsErrorText, checkToolArguments } from "./schema-check.ts";
import { teamPost, teamWait } from "./team.ts";
import { askUser } from "./ask-user.ts";
import { SANDBOX_TOOL_SET, loadSkill, sandboxTool } from "./sandbox.ts";
import type { SandboxTool } from "@open-team/db";
import { haltedDetails, resolveTaskByToken } from "./tokens.ts";
import { capBytes, charCount, isPlainObject, toJsonObject, truncateChars } from "./util.ts";
import { parseNotifyArgs, parseReportArgs } from "./validate.ts";
import { webFetch, webSearch } from "./web.ts";
import { nextActionsForReport } from "./web-seen.ts";

/** notify の結果（アプリ内に残したことだけを返す。scripts/measure の NOTIFY_ACCEPTED_TEXT と同じ文） */
export const NOTIFY_ACCEPTED_TEXT = "通知を送りました。";

/** 判定の記録に残したツール呼び出し（proxy.ts の callRecord） */
interface CallRecord {
  toolCallId: string;
  name: string;
  effective: string;
  intentId: string | null;
  invalidArgs: string[] | null;
}

function callRecordOf(row: PolicyDecisionRow): CallRecord | null {
  const call = isPlainObject(row.subject) ? row.subject.call : undefined;
  if (!isPlainObject(call) || typeof call.toolCallId !== "string" || typeof call.name !== "string" || typeof call.effective !== "string") return null;
  return {
    toolCallId: call.toolCallId,
    name: call.name,
    effective: call.effective,
    intentId: typeof call.intentId === "string" ? call.intentId : null,
    invalidArgs: Array.isArray(call.invalidArgs) ? call.invalidArgs.filter((x): x is string => typeof x === "string") : null,
  };
}

/** gateway の拒否のうち、タスクの停止に当たるもの（Kill Switch・終了したタスク） */
const HALT_REASONS: ReadonlySet<string> = new Set(["kill_switch", "task_terminated"]);
/** 拒否ではなく、届かなかった・答えがなかったもの（ツールのエラーの文で返す。自分の文だけなので汚染しない：MT §3.12.5-8） */
const ERROR_REASONS: ReadonlySet<string> = new Set(["timeout", "upstream_error"]);

/** mcp_call の読み取り（MT §3.10-8）。結果は秘密情報をマスクし 64KB で切ってから囲む */
async function readTool(rt: EdgeRuntime, token: string, ctx: WsCtx, task: TaskRow, row: PolicyDecisionRow, call: CallRecord): Promise<ToolCallResult> {
  const action = typeof row.subject.action === "string" ? row.subject.action : "";
  const rest = action.startsWith("mcp.") ? action.slice(4) : "";
  const dot = rest.indexOf(".");
  if (dot <= 0) return { kind: "text", text: toolErrorText("TOOL_NOT_FOUND") };
  const slug = rest.slice(0, dot);
  const toolName = rest.slice(dot + 1);
  const hit = await findConnectorTool(rt.db, ctx, slug, toolName);
  if (hit === null) return { kind: "text", text: toolErrorText("TOOL_NOT_FOUND") };
  if (hit.tool.classification !== "read") return { kind: "denied", reasonCode: "tool_not_read" };
  const args = toJsonObject(row.subject.args) ?? {};
  // 入力スキーマに合わない呼び出しは送らない（M-12。edge の決まった文なので汚染しない：計測の measureEdge と同じ）
  const check = checkToolArguments(hit.tool.input_schema, args, rt.limits.mcpArgsMaxBytes);
  if (!check.ok) return { kind: "text", text: argsErrorText(`${slug}.${toolName}`, check.issues) };

  let res;
  try {
    const signal = rt.signalFor?.(task.id);
    res = await rt.gateway.callReadTool(
      token,
      { connectorId: hit.connector.id, tool: hit.tool.name, arguments: args, toolCallId: call.toolCallId },
      signal !== undefined ? { signal } : {},
    );
  } catch (e) {
    if (e instanceof GatewayClientError) {
      // トークンが gateway で通らない・タスクが止まった → 停止として返す
      if (e.status === 401 || e.status === 409) return { kind: "halted", reasonCode: "task_terminated" };
      if (e.status === 404) return { kind: "denied", reasonCode: "connector_not_found" };
      return { kind: "text", text: toolErrorText(`GATEWAY_${e.status}`) };
    }
    return { kind: "text", text: toolErrorText("GATEWAY_UNREACHABLE") };
  }
  if (!res.ok) {
    const reason: GwRejectReason = res.reasonCode;
    if (HALT_REASONS.has(reason)) return { kind: "halted", reasonCode: reason };
    if (ERROR_REASONS.has(reason)) return { kind: "text", text: toolErrorText(reason) };
    // 境界・needs_review・ツールが消えた（汚染は変えない：外部の文字列を受け取っていない）
    return { kind: "denied", reasonCode: reason };
  }

  // 受け取った時点でタスクを汚染する（BR-38）。isError の本文もサーバーの文字列なので汚染する（MT D-27）。
  // 1トランザクションでコミットしてから返す（コミットできなければ結果を返さない：MT §3.10-8d）
  const content = capBytes(maskSecrets(res.content, rt.knownSecrets), rt.limits.mcpResultMaxBytes).text;
  const after = await rt.db.transaction(
    async (tx) => {
      const now = rt.clock.now();
      await lockWorkspace(tx, ctx);
      const t = await lockTask(tx, ctx, task.id);
      if (t === null) return null;
      const current: TaintState = { tainted: t.tainted, sources: Array.isArray(t.taint_sources) ? t.taint_sources : [] };
      const next = addTaintSource(current, {
        kind: "mcp_read",
        connectorId: hit.connector.id,
        connectorSlug: hit.connector.slug,
        connectorName: hit.connector.display_name,
        tool: hit.tool.name,
        at: now.toISOString(),
      });
      await setTaskTaint(tx, ctx, t.id, next, now);
      return t;
    },
    { retryOnce: true },
  );
  if (after === null) throw new EdgeError("UNAUTHORIZED");
  if (after.status !== "running") return { kind: "halted", reasonCode: haltedDetails(after).haltReason };
  return { kind: "text", text: wrapUntrusted(`mcp:${slug}.${toolName}`, content) };
}

/** 出典の文字列もマスクする（BR-32） */
function maskSources(sources: ReportSource[], secrets: readonly string[]): ReportSource[] {
  const m = (s: string) => maskSecrets(s, secrets);
  return sources.map((s) => {
    switch (s.kind) {
      case "url":
        return { kind: "url", url: m(s.url), ...(s.title !== undefined ? { title: m(s.title) } : {}) };
      case "mcp":
        return { kind: "mcp", connector: m(s.connector), tool: m(s.tool), ...(s.label !== undefined ? { label: m(s.label) } : {}) };
      case "agent":
        return { kind: "agent", agentName: m(s.agentName) };
    }
  });
}

/**
 * submit_report（API-056。formation-runtime.md §3.12 submitReport）：検証 → マスク → 保存（kind は窓口なら answer：§8-13）→
 * トークンを失効 → 監査ログ task.report_submitted → タスクの状態（finalizeTaskAfterLoop）。コミットのあと onReportSubmitted
 */
async function submitReport(rt: EdgeRuntime, ctx: WsCtx, task: TaskRow, row: PolicyDecisionRow): Promise<ToolCallResult> {
  const args = parseReportArgs(row.subject.args, rt.limits);
  const secrets = rt.knownSecrets;
  const title = maskSecrets(args.title, secrets);
  const body = maskSecrets(args.body, secrets);
  const sources = maskSources(args.sources, secrets);
  const outcome = await rt.db.transaction(
    async (tx) => {
      const now = rt.clock.now();
      await lockWorkspace(tx, ctx);
      const t = await lockTask(tx, ctx, task.id);
      if (t === null) throw new EdgeError("UNAUTHORIZED");
      if (t.status !== "running") throw new EdgeError("TASK_HALTED", haltedDetails(t));
      if (t.report !== null) throw new EdgeError("REPORT_ALREADY_SUBMITTED");
      // 窓口かどうかは ask_members で決める（LLM の kind は使わない：付け忘れ・付け間違いで回答が出ない／二重に出るのを防ぐ）
      let kind: "normal" | "answer" = "normal";
      if (t.ask_id !== null) {
        const members = await listAskMembers(tx, ctx, t.ask_id);
        const me = members.find((m) => m.id === t.ask_member_id) ?? members.find((m) => m.job_id === t.job_id);
        if (me?.is_spokesperson === true) kind = "answer";
      }
      // 次の手の提案は回答になる報告（窓口）のときだけ残す。見張りの変化の有無はどの担当でも残す。
      // 汚染されたタスクの提案からは URL を含むものを落とす（SG-04：押すと利用者の返事として送られるので、
      // 読んだ秘密を載せた URL を「利用者の文の URL」として見た URL の集合に入れさせない。汚染はロックした行のいまの値で見る）
      const nextActions = kind === "answer" ? nextActionsForReport(args.nextActions, t.tainted).map((a) => maskSecrets(a, secrets)) : [];
      const meta = { ...(nextActions.length > 0 ? { nextActions } : {}), ...(args.changed === undefined ? {} : { changed: args.changed }) };
      const saved = await saveTaskReport(tx, ctx, t.id, { title, body, kind, sources, meta }, now);
      if (!saved) throw new EdgeError("REPORT_ALREADY_SUBMITTED");
      await revokeTaskToken(tx, ctx, t.id, now);
      await appendAuditLog(
        tx,
        ctx.workspaceId,
        {
          eventType: "task.report_submitted",
          actorType: "agent",
          actorId: t.agent_id,
          taskId: t.id,
          // 本文は入れない（ハッシュと大きさだけ）
          payload: {
            taskId: t.id,
            kind,
            titleHash: sha256Hex(title),
            bodyHash: sha256Hex(body),
            bodyChars: charCount(body),
            sourcesCount: sources.length,
          },
        },
        now,
      );
      const fin = await finalizeTaskAfterLoop(tx, ctx, { ...t, report: body }, now);
      return fin;
    },
    { retryOnce: true },
  );
  const onReport = rt.hooks.onReportSubmitted;
  if (onReport) await runHook(rt, "onReportSubmitted", task.id, () => onReport(ctx, { taskId: task.id, status: outcome.status }));
  if (outcome.terminal) await notifyTerminal(rt, ctx, task.id, outcome.status);
  else {
    rt.llmLimiter.forget(task.id);
    rt.eventLimiter.forget(task.id);
  }
  return { kind: "report_accepted", taskId: task.id };
}

/** notify（cat:86）：アプリ内に残す（task_events の message。Web Push は Should）。窓口でない担当も Push しない（§8-14） */
async function notify(rt: EdgeRuntime, ctx: WsCtx, task: TaskRow, row: PolicyDecisionRow): Promise<ToolCallResult> {
  const args = parseNotifyArgs(row.subject.args);
  if (args === null) throw new EdgeError("VALIDATION_ERROR", { issues: [{ field: "arguments", reason: "title・body は文字列（1文字以上）" }] });
  const payload: JsonObject = {
    via: "notify",
    title: truncateChars(maskSecrets(args.title, rt.knownSecrets), rt.limits.notifyTitleMax),
    body: truncateChars(maskSecrets(args.body, rt.knownSecrets), rt.limits.notifyBodyMax),
    priority: args.priority,
  };
  await insertTaskEvent(rt.db, ctx, task.id, "message", payload, rt.clock.now());
  return { kind: "text", text: NOTIFY_ACCEPTED_TEXT };
}

/** API-038 とは別の、edge の callTool（formation-runtime.md §3.11） */
export async function callTool(rt: EdgeRuntime, token: string, toolCallId: string): Promise<ToolCallResult> {
  const { ctx, task } = await resolveTaskByToken(rt.db, token, rt.clock.now());
  if (typeof toolCallId !== "string" || toolCallId === "") throw new EdgeError("TOOL_CALL_NOT_ALLOWED");
  // このタスクの判定の記録だけを引く（別のタスクの toolCallId は見つからない）
  const row = await findToolCallDecision(rt.db, ctx, task.id, toolCallId);
  const call = row === null ? null : callRecordOf(row);
  // finish は postEvents の finished で終える（ツールとして実行するものはない）
  if (row === null || call === null || call.effective !== "allow" || call.intentId !== null || call.name === "finish") {
    throw new EdgeError("TOOL_CALL_NOT_ALLOWED");
  }

  // 実行を1回だけ受け付ける（同じタスクの行のロックで直列にする）
  await rt.db.transaction(
    async (tx) => {
      const now = rt.clock.now();
      const ws = await lockWorkspace(tx, ctx);
      const t = await lockTask(tx, ctx, task.id);
      if (t === null) throw new EdgeError("UNAUTHORIZED");
      if (t.status !== "running" || ws?.kill_switch_engaged === true) throw new EdgeError("TASK_HALTED", haltedDetails(t, ws ?? undefined));
      const claimed = await claimToolCallExecution(tx, ctx, t.id, { toolCallId, name: call.name }, now);
      if (!claimed) throw new EdgeError("TOOL_CALL_NOT_ALLOWED", { reason: "already_executed" });
    },
    { retryOnce: true },
  );

  // 入力スキーマに合わなかった書き込み（Intent にしていない：M-12）
  if (call.invalidArgs !== null) {
    const action = typeof row.subject.action === "string" ? row.subject.action.replace(/^mcp\./, "") : call.name;
    return { kind: "text", text: argsErrorText(action, call.invalidArgs) };
  }
  switch (call.name) {
    case "mcp_call":
      return readTool(rt, token, ctx, task, row, call);
    case "submit_report":
      return submitReport(rt, ctx, task, row);
    case "notify":
      return notify(rt, ctx, task, row);
    // Web の検索・取得（web.ts。ゲストの web_search は判定で guest_workspace）
    case "web_search":
      return webSearch(rt, ctx, task, row);
    case "web_fetch":
      return webFetch(rt, ctx, task, row);
    // 連絡板（FR-064）
    case "team_post":
      return teamPost(rt, ctx, task, row);
    case "team_wait":
      return teamWait(rt, ctx, task, row);
    // 利用者への質問（ask-user.ts）
    case "ask_user":
      return askUser(rt, ctx, task, row);
    // スキル（sandbox.ts。パックの手順書）
    case "load_skill":
      return loadSkill(rt, ctx, task, row);
    default:
      // 作業場の道具（sandbox.ts。D-116）
      if (SANDBOX_TOOL_SET.has(call.name)) return sandboxTool(rt, ctx, task, row, call.name as SandboxTool);
      return { kind: "text", text: toolErrorText("TOOL_NOT_AVAILABLE") };
  }
}
