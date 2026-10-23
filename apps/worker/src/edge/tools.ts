// ツールの実行（packages/edge/src/tools.ts の callTool の WorkspaceDO 版。formation-runtime.md §3.11・§3.12、M-30）
// runner は toolCallId だけを渡し、edge は LLM Proxy が判定のときに記録した引数で実行する（判定と違う引数で実行させない）。
// 判定の記録がない・allow でない・Intent にした書き込み・実行済み → 403 TOOL_CALL_NOT_ALLOWED。submit_report は報告を保存（API-056）。
// 4c で動かす道具：submit_report・notify・load_skill（finish は postEvents の finished で終える）。Node 版と同じふるまい。
// Node 版との違い：
// - 同期。トークンの代わりに taskId。あとで呼ぶ処理（onReportSubmitted・onTaskTerminal）はない（DO の側が TaskWorkflow の終わりで後始末する）
// - mcp_call の読み取り（gateway の EP-49）は 4e。いまは実行を受け付けたうえで「まだ使えない」と分かるツールのエラーの文を返す（汚染しない）
// - Web・連絡板・利用者への質問・作業場の道具（context.ts の DEFERRED_TOOLS）は TOOL_CALL_NOT_ALLOWED（TaskContext にも出していない）
// - 報告の受け付けでトークンを失効させない（トークンを使わない）。報告が保存済みのタスクは resolveTask が UNAUTHORIZED にする

import { addTaintSource, sha256Hex, wrapUntrusted, type JsonObject, type TaintState } from "@open-team/kernel";
import { EdgeError, toolErrorText, type ToolCallResult } from "@open-team/runner";
import { maskSecrets } from "@open-team/platform";
import { appendAuditLog } from "../db/audit.ts";
import { claimToolCallExecution, findToolCallDecision, getTask, insertTaskEvent, listAskMembers, saveTaskReport, setTaskTaint } from "../db/repo/edge.ts";
import { touchSkillUsed } from "../db/repo/evolution.ts";
import { listAgentSkills } from "../db/repo/sandbox.ts";
import type { WsDb } from "../db/sqlite.ts";
import type { PolicyDecisionRow, ReportSource, TaskRow } from "../db/types.ts";
import { getWorkspace } from "../db/workspace.ts";
import { DEFERRED_TOOLS } from "./context.ts";
import { finalizeTaskAfterLoop } from "./halt.ts";
import { forgetTask, type TaskEdgeRuntime } from "./runtime.ts";
import { argsErrorText } from "./schema-check.ts";
import { isTrustedSkill } from "./skill-trust.ts";
import { haltedDetails, resolveTask } from "./tokens.ts";
import { charCount, isPlainObject, truncateChars } from "./util.ts";
import { parseNotifyArgs, parseReportArgs } from "./validate.ts";
import { nextActionsForReport } from "./web-seen.ts";

/** notify の結果（アプリ内に残したことだけを返す。scripts/measure の NOTIFY_ACCEPTED_TEXT と同じ文） */
export const NOTIFY_ACCEPTED_TEXT = "通知を送りました。";

/** mcp_call の読み取りがまだ使えないときの文（4e で gateway につなぐまで） */
export const MCP_READ_NOT_AVAILABLE_TEXT = toolErrorText("MCP_READ_NOT_AVAILABLE_YET");

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
 * 監査ログ task.report_submitted → タスクの状態（finalizeTaskAfterLoop）
 */
function submitReport(db: WsDb, rt: TaskEdgeRuntime, task: TaskRow, row: PolicyDecisionRow, now: Date): ToolCallResult {
  const args = parseReportArgs(row.subject.args, rt.limits);
  const secrets = rt.knownSecrets;
  const title = maskSecrets(args.title, secrets);
  const body = maskSecrets(args.body, secrets);
  const sources = maskSources(args.sources, secrets);
  db.transaction(() => {
    const t = getTask(db, task.id);
    if (t === null) throw new EdgeError("UNAUTHORIZED");
    if (t.status !== "running") throw new EdgeError("TASK_HALTED", haltedDetails(t));
    if (t.report !== null) throw new EdgeError("REPORT_ALREADY_SUBMITTED");
    // 窓口かどうかは ask_members で決める（LLM の kind は使わない：付け忘れ・付け間違いで回答が出ない／二重に出るのを防ぐ）
    let kind: "normal" | "answer" = "normal";
    if (t.ask_id !== null) {
      const members = listAskMembers(db, t.ask_id);
      const me = members.find((m) => m.id === t.ask_member_id) ?? members.find((m) => m.job_id === t.job_id);
      if (me?.is_spokesperson === true) kind = "answer";
    }
    // 次の手の提案は回答になる報告（窓口）のときだけ残す。見張りの変化の有無はどの担当でも残す。
    // 汚染されたタスクの提案からは URL を含むものを落とす（SG-04：押すと利用者の返事として送られるので、
    // 読んだ秘密を載せた URL を「利用者の文の URL」として見た URL の集合に入れさせない。汚染はいまの行の値で見る）
    const nextActions = kind === "answer" ? nextActionsForReport(args.nextActions, t.tainted).map((a) => maskSecrets(a, secrets)) : [];
    const meta = { ...(nextActions.length > 0 ? { nextActions } : {}), ...(args.changed === undefined ? {} : { changed: args.changed }) };
    if (!saveTaskReport(db, t.id, { title, body, kind, sources, meta }, now)) throw new EdgeError("REPORT_ALREADY_SUBMITTED");
    appendAuditLog(
      db,
      {
        eventType: "task.report_submitted",
        actorType: "agent",
        actorId: t.agent_id,
        taskId: t.id,
        // 本文は入れない（ハッシュと大きさだけ）
        payload: { taskId: t.id, kind, titleHash: sha256Hex(title), bodyHash: sha256Hex(body), bodyChars: charCount(body), sourcesCount: sources.length },
      },
      now,
    );
    finalizeTaskAfterLoop(db, { ...t, report: body }, now);
  });
  // 報告のあとはこのタスクの LLM・進捗を受け付けない（終了状態でも承認待ちでも）
  forgetTask(rt, task.id);
  return { kind: "report_accepted", taskId: task.id };
}

/** notify（cat:86）：アプリ内に残す（task_events の message。Web Push は Should）。窓口でない担当も Push しない（§8-14） */
function notify(db: WsDb, rt: TaskEdgeRuntime, task: TaskRow, row: PolicyDecisionRow, now: Date): ToolCallResult {
  const args = parseNotifyArgs(row.subject.args);
  if (args === null) throw new EdgeError("VALIDATION_ERROR", { issues: [{ field: "arguments", reason: "title・body は文字列（1文字以上）" }] });
  const payload: JsonObject = {
    via: "notify",
    title: truncateChars(maskSecrets(args.title, rt.knownSecrets), rt.limits.notifyTitleMax),
    body: truncateChars(maskSecrets(args.body, rt.knownSecrets), rt.limits.notifyBodyMax),
    priority: args.priority,
  };
  insertTaskEvent(db, task.id, "message", payload, now);
  return { kind: "text", text: NOTIFY_ACCEPTED_TEXT };
}

/**
 * load_skill（packages/edge/src/sandbox.ts の loadSkill の写し）：担当自身のスキルを名前で読む（パックで入った手順書・承認した育ったスキル。外へは出ない）。
 * 運営のパックの定数または承認した中身と同じ（(名前, 説明, 本文) の SHA-256 が一致：skill-trust.ts）なら信頼された手順書として渡す。
 * それ以外（カタログにない・書き換えられた）は <untrusted> で包み、読んだタスクを skill で汚染する（コミットしてから返す：SG-05）。
 * 4c は信頼の表が空なので、パックのスキルは包まれる側に倒れる
 */
function loadSkill(db: WsDb, rt: TaskEdgeRuntime, task: TaskRow, row: PolicyDecisionRow, now: Date): ToolCallResult {
  const raw = isPlainObject(row.subject.args) ? row.subject.args : {};
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const skills = listAgentSkills(db, task.agent_id);
  const hit = skills.find((s) => s.name === name) ?? skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (hit === undefined) {
    // 一覧に出すのは信頼できるスキルの名前だけ（DB の名前を包まずに返さない：SG-05）。探した名前は担当が書いたもの
    const names = skills.filter((s) => isTrustedSkill(rt.trustedSkills, s)).map((s) => s.name);
    return { kind: "text", text: `スキル「${name}」はありません。使えるスキル：${names.join("、") || "（なし）"}` };
  }
  // 本番のタスクで読んだら使った時刻を残す（信頼されたかどうかは問わない。記録の失敗でタスクは止めない）
  if (!task.is_dry_run) {
    try {
      touchSkillUsed(db, hit.id, now);
    } catch (e) {
      console.warn("skill.touch_failed", { taskId: task.id, skillId: hit.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const body = maskSecrets(hit.body, rt.knownSecrets);
  if (isTrustedSkill(rt.trustedSkills, hit)) return { kind: "text", text: `# スキル「${hit.name}」\n\n${body}` };

  const before = db.transaction(() => {
    const t = getTask(db, task.id);
    if (t === null) return null;
    const current: TaintState = { tainted: t.tainted, sources: Array.isArray(t.taint_sources) ? t.taint_sources : [] };
    setTaskTaint(db, t.id, addTaintSource(current, { kind: "skill", name: hit.name, packId: hit.pack_id, at: now.toISOString() }), now);
    return t;
  });
  if (before === null) return { kind: "halted", reasonCode: "task_terminated" };
  if (before.status !== "running") return { kind: "halted", reasonCode: haltedDetails(before).haltReason };
  return { kind: "text", text: wrapUntrusted(`skill:${hit.name}`, body) };
}

/** edge の callTool（formation-runtime.md §3.11） */
export function edgeCallTool(db: WsDb, rt: TaskEdgeRuntime, taskId: string, toolCallId: string, now: Date): ToolCallResult {
  const { task } = resolveTask(db, taskId, now);
  if (typeof toolCallId !== "string" || toolCallId === "") throw new EdgeError("TOOL_CALL_NOT_ALLOWED");
  // このタスクの判定の記録だけを引く（別のタスクの toolCallId は見つからない）
  const row = findToolCallDecision(db, task.id, toolCallId);
  const call = row === null ? null : callRecordOf(row);
  // finish は postEvents の finished で終える（ツールとして実行するものはない）。4c で動かさない道具も実行しない
  if (row === null || call === null || call.effective !== "allow" || call.intentId !== null || call.name === "finish" || DEFERRED_TOOLS.has(call.name)) {
    throw new EdgeError("TOOL_CALL_NOT_ALLOWED");
  }

  // 実行を1回だけ受け付ける（DO の中は1本の流れなので、確かめて記録するまでに同じ呼び出しが割り込まない）
  db.transaction(() => {
    const ws = getWorkspace(db);
    const t = getTask(db, task.id);
    if (t === null) throw new EdgeError("UNAUTHORIZED");
    if (t.status !== "running" || ws?.kill_switch_engaged === true) throw new EdgeError("TASK_HALTED", haltedDetails(t, ws ?? undefined));
    if (!claimToolCallExecution(db, t.id, { toolCallId, name: call.name }, now)) throw new EdgeError("TOOL_CALL_NOT_ALLOWED", { reason: "already_executed" });
  });

  // 入力スキーマに合わなかった書き込み（Intent にしていない：M-12）
  if (call.invalidArgs !== null) {
    const action = typeof row.subject.action === "string" ? row.subject.action.replace(/^mcp\./, "") : call.name;
    return { kind: "text", text: argsErrorText(action, call.invalidArgs) };
  }
  switch (call.name) {
    case "mcp_call":
      // 読み取りの実行（gateway の EP-49）は 4e。外の内容を受け取らないので汚染しない
      return { kind: "text", text: MCP_READ_NOT_AVAILABLE_TEXT };
    case "submit_report":
      return submitReport(db, rt, task, row, now);
    case "notify":
      return notify(db, rt, task, row, now);
    case "load_skill":
      return loadSkill(db, rt, task, row, now);
    default:
      return { kind: "text", text: toolErrorText("TOOL_NOT_AVAILABLE") };
  }
}
