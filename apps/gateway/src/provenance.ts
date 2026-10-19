// 承認の出どころの照合（SG-03：docs/design/17_security_governance.md「SG-03 gateway が承認の出どころを照合する」）。
// いまの前提（execute.ts の prepare）は `status = 'approved'` と、同じ行から計算し直した intentHash しか見ない。app のロール（ot_app）は
// action_intents を UPDATE できるので、app が破られると「列を1つ書き換えるだけ」で任意の書き込みが gateway を通る。
// ここでは実行の前に「判定が実際に行われた証拠」を DB の別の行で確かめ、欠けていれば実行しない（理由コード approval_provenance）。
//
// 証拠の重み：ot_app は action_intents・approvals・policy_decisions・rehearsal_certificates の列と時刻を UPDATE・DELETE できるので、
// それらは「一致しているか」を見るだけで、偽れる。audit_logs は ot_app でも追記しかできず（UPDATE・DELETE・TRUNCATE はロールとトリガーで拒否）、
// seq はワークスペースごとの詰まった連番で前に割り込めない。そこで「すでに起きたこと（失効・却下・実行）」と「起きた順番（合格証の発行 →
// 判定 → 承認）」は監査ログで確かめる。「無い」ことの証明（却下・失効・実行が無い）は監査ログが消せないので偽れない。
// ただし ot_app は監査ログを足せるので、「有る」ことの証明（判定・承認の記録）は追記で偽れる。足した行は seq が後ろになるので、順番の
// 照合（発行 < 判定 < 承認）と、元からある記録との食い違い（全部が一致すること）で止まる範囲が広がるが、完全ではない。根本は SG-02
// （状態遷移を DB の関数に閉じる）と SG-01（人の承認の署名）。
//
// 照合の規則（本番のタスクの Intent。どれかが欠けたら拒否。detail は PROVENANCE_FAILURES）
//   P-0 入口：試し実行（リハーサルでない）の Intent は simulated にしかならない（BR-24）→ dry_run_intent。enforced = false は影だけ
//       （BR-67③）→ not_enforced。allow・approve 以外の decision → decision_not_executable
//   P-H 履歴（監査ログ）：その Intent の終わりを示す記録（action.executed・action.failed・action.unknown_outcome・intent.expired・
//       intent.resolved・approval.expired・approval.invalidated、task.cancelled の expiredIntentIds）→ already_finished。
//       タスクが終了状態になった記録（task.status_changed の to）→ task_ended。送り始めた記録 action.started の数が、送信前の失敗で
//       executing から approved に戻した記録 action.presend_retry（from = executing）の数と違う → execution_replayed（実行済み・
//       送信中に止まったものを approved に書き戻した）。判定のあとの Kill Switch の発動（そのとき executing でなかった）→ kill_switch_expired
//   P-1 Kernel の判定：policy_decisions に Intent と一致する行（decision・reason_code・matched_rule・mcp_write・action・引数・
//       subject.call.intentId・enforced）→ decision_missing / decision_mismatch。edge が同じトランザクションで追記する decision.made
//       （intentId つき。gateway の記録 source = gateway は除く）がすべてその行と一致（decision・reasonCode・matchedRule・inputsHash・
//       subjectKind・enforced）→ decision_audit_missing / decision_audit_mismatch。intent.proposed がすべて Intent と一致（decision・
//       reasonCode・matchedRule・intentHash・policyHash・action・enforced）→ proposal_audit_missing / proposal_audit_mismatch
//   P-2 approve：承認の行（同じ Intent・タスク、approved、decided_by ∈ approver_ids、created_at ≤ decided_at < expires_at）。
//       approval.decided はその承認にちょうど1件で approve（reject があれば approval_rejected）、行為者が decided_by、intentHash が
//       Intent と一致。approval.requested があり期限が承認の行と同じで、決定の時刻がその期限より前。順番は
//       判定（decision.made）< 承認の要求 < 承認の決定（seq）→ approval_order_invalid
//   P-3 allow：判定が rule_matched（rules.items[n]）で flags.certificateValid。合格証の行（この仕事・この action と tool_hash を含む）の
//       発行の監査ログ（audit_seq の行が rehearsal.certificate_issued で jobId・certificateHash が一致）が判定より前にあり、
//       発行から判定までの間に、その合格証の失効（rehearsal.certificate_revoked）も同じ仕事の次の発行（superseded）もない
//
// 照合しないもの（既存の振る舞いを変えない。理由）
//   - リハーサルの走行のタスク（rehearsal_run_id がある：影・governed・承認した分岐 governed_approve）。
//     影は Kernel の判定（deny・approve）を無視して実行する仕様（BR-67③、SW §4.5-3）で、承認した分岐は「人が承認したことにした」写しを
//     承認の行も判定の行も作らずに実行する（DB §4.6、SW §4.4.3 の4、apps/app/src/rehearsal/run.ts の runApproveBranch）。
//     どちらも書き込み先は境界（connectorBoundary の rehearsal_real_connector・shadow_real_connector。影でも必ず効かせる：SH-06）が
//     sim-world に閉じるので、出どころを偽っても本物の外へは書けない。照合を足すと影・リハーサルの比較が成り立たなくなる。
//     影でも効かせる intentHash の再計算・境界・Kill Switch・二重の実行の防止は今までどおり（execute.ts）
//   - ゲストのワークスペースで sim-world へ書く approve の Intent に限り、判定の行・decision.made・intent.proposed・approval.requested が
//     1件もないときは P-1 と、P-2 の要求・判定との順番だけを求めない。ゲストのデモのデータ（apps/app/src/guest-seed.ts）は承認待ちの
//     Intent をこれらなしで入れるため。人の承認（行と approval.decided）と P-H は求める。どれか1件でもあれば例外にせず全部を照合する。
//     ゲストの書き込み先は境界（guest_workspace：BR-64）が sim-world に閉じる。guest-seed が判定の記録を残すようになったらこの例外は外す
//
// gateway は decide を呼ばない（M-20、execute.ts:10）。ここで確かめるのは証拠の「存在と一致と順番」だけで、判定のやり直しはしない。

import type { ActionIntentRow, ApprovalRow, PolicyDecisionRow, RehearsalCertificateRow, Tx, WsCtx } from "@open-team/db";
import {
  getApprovalOfIntent,
  listCertificateAuditEvents,
  listJobCertificates,
  listKernelDecisionsOfIntent,
  listKillSwitchEngagedSeqs,
  listTaskAuditEvents,
  type GatewayTaskRow,
  type ProvenanceAuditEvent,
} from "@open-team/db/gateway";
import { canonicalJson } from "@open-team/kernel";

/** 拒否の理由コード（Intent の result.reasonCode・判定の記録の reason_code） */
export const PROVENANCE_REASON = "approval_provenance";

/** 何が欠けていたか（result.detail・監査ログ・判定の記録の matched_rule `provenance.<detail>` に入れる） */
export const PROVENANCE_FAILURES = [
  "dry_run_intent",
  "not_enforced",
  "decision_not_executable",
  "already_finished",
  "task_ended",
  "execution_replayed",
  "kill_switch_expired",
  "decision_missing",
  "decision_mismatch",
  "decision_audit_missing",
  "decision_audit_mismatch",
  "proposal_audit_missing",
  "proposal_audit_mismatch",
  "approval_missing",
  "approval_mismatch",
  "approval_not_approved",
  "approver_not_allowed",
  "approval_time_invalid",
  "approval_after_expiry",
  "approval_rejected",
  "approval_audit_missing",
  "approval_audit_conflict",
  "approval_hash_mismatch",
  "approval_request_missing",
  "approval_request_mismatch",
  "approval_order_invalid",
  "rule_not_matched",
  "certificate_flag_missing",
  "certificate_missing",
] as const;
export type ProvenanceFailure = (typeof PROVENANCE_FAILURES)[number];

export type ProvenanceResult =
  /** checked = false は照合の対象外（リハーサルの走行のタスク） */
  | { ok: true; checked: boolean }
  | { ok: false; detail: ProvenanceFailure };

/** 照合に使う証拠（DB から読んだもの） */
export interface ProvenanceEvidence {
  decisions: readonly PolicyDecisionRow[];
  approval: ApprovalRow | null;
  /** その Intent のタスクの監査ログ（seq の順） */
  taskAudits: readonly ProvenanceAuditEvent[];
  /** ワークスペースの killswitch.engaged の seq */
  killSwitchSeqs: readonly number[];
  certificates: readonly RehearsalCertificateRow[];
  /** その仕事の合格証の発行・失効の監査ログ（seq の順） */
  certificateAudits: readonly ProvenanceAuditEvent[];
}

export type ProvenanceIntent = Pick<
  ActionIntentRow,
  "id" | "task_id" | "job_id" | "action" | "payload" | "tool_hash" | "decision" | "reason_code" | "matched_rule" | "enforced" | "intent_hash" | "policy_hash"
>;

export interface ProvenanceInput {
  task: Pick<GatewayTaskRow, "is_dry_run" | "rehearsal_run_id" | "shadow">;
  intent: ProvenanceIntent;
  /** ゲストのワークスペースで、書き込み先が sim-world（境界で確かめた URL）か */
  guestSimWrite: boolean;
}

type Fail = { ok: false; detail: ProvenanceFailure };
const fail = (detail: ProvenanceFailure): Fail => ({ ok: false, detail });

/** 照合の対象か（本番のタスクだけ。リハーサル・影は対象外：冒頭の「照合しないもの」） */
export function provenanceApplies(task: Pick<GatewayTaskRow, "rehearsal_run_id" | "shadow">): boolean {
  return task.rehearsal_run_id === null && !task.shadow;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 正規形 JSON で同じか（読めない値は一致しないとみなす：閉じた側） */
function sameJson(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

const nullable = (v: unknown): unknown => (v === undefined ? null : v);

/** この Intent についての監査ログ（payload.intentId） */
function aboutIntent(audits: readonly ProvenanceAuditEvent[], intentId: string): ProvenanceAuditEvent[] {
  return audits.filter((a) => isObject(a.payload) && a.payload.intentId === intentId);
}

/** edge の LLM Proxy が書く判定の監査ログ（gateway 自身の拒否の記録 source = gateway は除く） */
function kernelDecisionAudits(audits: readonly ProvenanceAuditEvent[], intentId: string): ProvenanceAuditEvent[] {
  return aboutIntent(audits, intentId).filter((a) => a.event_type === "decision.made" && a.payload.source !== "gateway");
}

function proposalAudits(audits: readonly ProvenanceAuditEvent[], intentId: string): ProvenanceAuditEvent[] {
  return aboutIntent(audits, intentId).filter((a) => a.event_type === "intent.proposed");
}

/** P-1：判定の行が、この Intent を判定したものか（決定・理由・規則・操作・宛先・引数・Intent の ID） */
export function decisionRowMatches(d: PolicyDecisionRow, intent: ProvenanceIntent): boolean {
  if (d.decision !== intent.decision || d.reason_code !== intent.reason_code) return false;
  if ((d.matched_rule ?? null) !== (intent.matched_rule ?? null)) return false;
  if (d.enforced !== true || d.action_type !== "mcp_write") return false;
  const subject: unknown = d.subject;
  if (!isObject(subject) || subject.action !== intent.action) return false;
  const payload: unknown = intent.payload;
  if (!isObject(payload) || !sameJson(subject.args, payload.arguments)) return false;
  // ツール呼び出しの判定は、作った Intent の ID を subject.call.intentId に残す（edge の judgeToolCalls）
  if (d.subject_kind === "tool_call") {
    const call = subject.call;
    if (!isObject(call) || call.intentId !== intent.id) return false;
  }
  return true;
}

/** decision.made（edge の recordDecision）が判定の行と同じ判定を記録しているか */
function decisionAuditMatches(a: ProvenanceAuditEvent, d: PolicyDecisionRow): boolean {
  const p = a.payload;
  return (
    p.decision === d.decision &&
    p.reasonCode === d.reason_code &&
    nullable(p.matchedRule) === (d.matched_rule ?? null) &&
    p.inputsHash === d.inputs_hash &&
    p.subjectKind === d.subject_kind &&
    p.enforced === true
  );
}

/** intent.proposed（edge の recordMcpIntent）が今の Intent と同じ中身・同じ判定を記録しているか */
function proposalAuditMatches(a: ProvenanceAuditEvent, intent: ProvenanceIntent): boolean {
  const p = a.payload;
  return (
    p.decision === intent.decision &&
    p.reasonCode === intent.reason_code &&
    nullable(p.matchedRule) === (intent.matched_rule ?? null) &&
    p.intentHash === intent.intent_hash &&
    p.policyHash === intent.policy_hash &&
    p.action === intent.action &&
    p.enforced === true
  );
}

/**
 * P-1 の監査ログの部分（判定の行と、edge が同じトランザクションで追記する decision.made・intent.proposed の一致）。
 * 一致すれば判定の seq（最初の decision.made）を返す。apps/app の試験で edge の本物の記録に当てて形の食い違いを見つけるために出す
 */
export function judgeKernelEvidence(
  intent: ProvenanceIntent,
  decisions: readonly PolicyDecisionRow[],
  taskAudits: readonly ProvenanceAuditEvent[],
): { ok: true; row: PolicyDecisionRow; decisionSeq: number } | Fail {
  const row = decisions.find((d) => decisionRowMatches(d, intent)) ?? null;
  if (row === null) return fail(decisions.length === 0 ? "decision_missing" : "decision_mismatch");
  const made = kernelDecisionAudits(taskAudits, intent.id);
  if (made.length === 0) return fail("decision_audit_missing");
  // 全部が一致すること：元の判定の記録は消せないので、後から足した記録で判定を差し替えられない
  if (!made.every((a) => decisionAuditMatches(a, row))) return fail("decision_audit_mismatch");
  const proposed = proposalAudits(taskAudits, intent.id);
  if (proposed.length === 0) return fail("proposal_audit_missing");
  if (!proposed.every((a) => proposalAuditMatches(a, intent))) return fail("proposal_audit_mismatch");
  return { ok: true, row, decisionSeq: made[0]!.seq };
}

const TASK_TERMINAL = new Set(["succeeded", "completed", "rejected", "failed", "cancelled", "halted"]);
/** その Intent が終わったことを示す監査ログ（payload.intentId つき） */
const FINISHED_EVENTS = new Set([
  "action.executed",
  "action.failed",
  "action.unknown_outcome",
  "intent.expired",
  "intent.resolved",
  "approval.expired",
  "approval.invalidated",
]);

/** P-H：履歴。anchorSeq は判定の seq（ゲストのデモの例外は 0：Intent はワークスペースを作ったときからある） */
function checkHistory(intent: ProvenanceIntent, ev: ProvenanceEvidence, anchorSeq: number): Fail | null {
  const mine = aboutIntent(ev.taskAudits, intent.id);
  if (mine.some((a) => FINISHED_EVENTS.has(a.event_type))) return fail("already_finished");
  if (ev.approval !== null && ev.taskAudits.some((a) => (a.event_type === "approval.expired" || a.event_type === "approval.invalidated") && a.payload.approvalId === ev.approval!.id)) {
    return fail("already_finished");
  }
  const cancelledWith = ev.taskAudits.some(
    (a) => a.event_type === "task.cancelled" && Array.isArray(a.payload.expiredIntentIds) && a.payload.expiredIntentIds.includes(intent.id),
  );
  if (cancelledWith) return fail("already_finished");
  // タスクは終了状態から戻らない。終わったタスクの未実行の Intent は一括で失効している（edge の haltTask・failTask、app の取り消し）
  const taskEnded = ev.taskAudits.some(
    (a) => a.event_type === "task.cancelled" || (a.event_type === "task.status_changed" && TASK_TERMINAL.has(String(a.payload.to))),
  );
  if (taskEnded) return fail("task_ended");
  // 送り始め（action.started）と、送信前の失敗で executing から approved に戻した記録（action.presend_retry、from = executing）は1対1
  const marks = mine.filter((a) => a.event_type === "action.started" || (a.event_type === "action.presend_retry" && a.payload.from === "executing"));
  const started = marks.filter((a) => a.event_type === "action.started").length;
  if (started !== marks.length - started) return fail("execution_replayed");
  // 判定のあとの Kill Switch の発動：そのとき executing でなければ（approved・承認待ち）一括で失効している（repo/app.ts の発動）
  for (const k of ev.killSwitchSeqs) {
    if (k <= anchorSeq) continue;
    const last = marks.filter((a) => a.seq < k).at(-1);
    if (last?.event_type !== "action.started") return fail("kill_switch_expired");
  }
  return null;
}

/** P-2：人の承認 */
function checkApproval(intent: ProvenanceIntent, ev: ProvenanceEvidence, decisionSeq: number | null): Fail | null {
  const approval = ev.approval;
  if (approval === null) return fail("approval_missing");
  if (approval.intent_id !== intent.id || approval.task_id !== intent.task_id) return fail("approval_mismatch");
  if (approval.status !== "approved") return fail("approval_not_approved");
  const by = approval.decided_by;
  if (by === null || !Array.isArray(approval.approver_ids) || !approval.approver_ids.includes(by)) return fail("approver_not_allowed");
  const at = approval.decided_at;
  if (at === null || at.getTime() < approval.created_at.getTime()) return fail("approval_time_invalid");
  // 期限ちょうどはもう決められない（app の API-019：now >= expires_at は期限切れ）
  if (at.getTime() >= approval.expires_at.getTime()) return fail("approval_after_expiry");

  const ofApproval = ev.taskAudits.filter((a) => a.payload.approvalId === approval.id);
  const decided = ofApproval.filter((a) => a.event_type === "approval.decided");
  // 却下の記録は消せない：あとから approve の記録を足しても通さない
  if (decided.some((a) => a.payload.decision !== "approve")) return fail("approval_rejected");
  if (decided.length === 0) return fail("approval_audit_missing");
  if (decided.length > 1) return fail("approval_audit_conflict");
  const d = decided[0]!;
  if (d.actor_type !== "user" || d.actor_id !== by || d.payload.intentId !== intent.id) return fail("approval_audit_missing");
  // 人が画面で見て承認した intentHash（ADR-005）と、いま実行しようとしている Intent が同じ
  if (d.payload.intentHash !== intent.intent_hash) return fail("approval_hash_mismatch");

  // ゲストのデモの例外（decisionSeq = null）は承認の要求の記録もない
  if (decisionSeq === null) return null;
  const requested = ofApproval.filter((a) => a.event_type === "approval.requested");
  if (requested.length === 0) return fail("approval_request_missing");
  const req = requested[0]!;
  const expiresAt = typeof req.payload.expiresAt === "string" ? Date.parse(req.payload.expiresAt) : Number.NaN;
  if (requested.length > 1 || req.payload.intentId !== intent.id || expiresAt !== approval.expires_at.getTime()) return fail("approval_request_mismatch");
  if (d.occurred_at.getTime() >= expiresAt) return fail("approval_after_expiry");
  // 判定 → 承認の要求（どちらも edge の同じトランザクション）→ 人の決定 の順（seq）
  if (!(req.seq < d.seq && decisionSeq < d.seq)) return fail("approval_order_invalid");
  return null;
}

/** P-3：ルールで allow。判定より前に発行され、判定の時点で切れていなかった合格証が、この action と tool_hash を含んでいた */
function checkRuleAllow(intent: ProvenanceIntent, d: PolicyDecisionRow, decisionSeq: number, ev: ProvenanceEvidence): Fail | null {
  if (d.reason_code !== "rule_matched" || typeof d.matched_rule !== "string" || !/^rules\.items\[\d+\]$/.test(d.matched_rule)) {
    return fail("rule_not_matched");
  }
  const flags: unknown = d.flags;
  if (!isObject(flags) || flags.certificateValid !== true) return fail("certificate_flag_missing");
  const valid = ev.certificates.some((c) => {
    if (c.job_id !== intent.job_id) return false;
    if (!Array.isArray(c.tool_hashes) || !c.tool_hashes.some((e) => isObject(e) && e.action === intent.action && e.toolHash === intent.tool_hash)) return false;
    // 発行の記録（行の audit_seq が指す監査ログ）。列は書けても、指す先の監査ログは前に割り込めない
    const issued = ev.certificateAudits.find(
      (a) => a.seq === c.audit_seq && a.event_type === "rehearsal.certificate_issued" && a.payload.jobId === c.job_id && a.payload.certificateHash === c.certificate_hash,
    );
    if (issued === undefined || issued.seq >= decisionSeq) return false;
    // 発行から判定までの間の失効：この合格証の取り消し、同じ仕事の次の発行（superseded。行ごとの監査ログはない）
    return !ev.certificateAudits.some(
      (a) =>
        a.seq > issued.seq &&
        a.seq < decisionSeq &&
        ((a.event_type === "rehearsal.certificate_revoked" && Array.isArray(a.payload.certificateIds) && a.payload.certificateIds.includes(c.id)) ||
          (a.event_type === "rehearsal.certificate_issued" && a.payload.jobId === c.job_id)),
    );
  });
  return valid ? null : fail("certificate_missing");
}

/** 照合（純粋な関数。DB は読まない） */
export function judgeProvenance(i: ProvenanceInput, ev: ProvenanceEvidence): ProvenanceResult {
  if (!provenanceApplies(i.task)) return { ok: true, checked: false };
  const { intent } = i;
  // P-0
  if (i.task.is_dry_run) return fail("dry_run_intent");
  if (intent.enforced !== true) return fail("not_enforced");
  if (intent.decision !== "allow" && intent.decision !== "approve") return fail("decision_not_executable");

  // ゲストのデモのデータ（判定の記録が何もない承認待ちの Intent）だけの例外（冒頭の「照合しないもの」）。1件でもあれば全部を照合する
  const noKernelTrace =
    ev.decisions.length === 0 &&
    kernelDecisionAudits(ev.taskAudits, intent.id).length === 0 &&
    proposalAudits(ev.taskAudits, intent.id).length === 0 &&
    !ev.taskAudits.some((a) => a.event_type === "approval.requested" && a.payload.intentId === intent.id);
  const guestSeed = noKernelTrace && i.guestSimWrite && intent.decision === "approve";

  let kernel: { row: PolicyDecisionRow; decisionSeq: number } | null = null;
  if (!guestSeed) {
    const k = judgeKernelEvidence(intent, ev.decisions, ev.taskAudits);
    if (!k.ok) return k;
    kernel = k;
  }

  const history = checkHistory(intent, ev, kernel?.decisionSeq ?? 0);
  if (history !== null) return history;

  if (intent.decision === "approve") return checkApproval(intent, ev, kernel?.decisionSeq ?? null) ?? { ok: true, checked: true };
  // allow の Intent は kernel がある（ゲストの例外は approve だけ）
  return checkRuleAllow(intent, kernel!.row, kernel!.decisionSeq, ev) ?? { ok: true, checked: true };
}

/** 証拠を読んで照合する（prepare のトランザクションの中。読むだけで、行はロックしない） */
export async function checkProvenance(tx: Tx, ctx: WsCtx, i: ProvenanceInput): Promise<ProvenanceResult> {
  if (!provenanceApplies(i.task)) return { ok: true, checked: false };
  const decisions = await listKernelDecisionsOfIntent(tx, ctx, i.intent);
  const taskAudits = await listTaskAuditEvents(tx, ctx, i.intent.task_id);
  const killSwitchSeqs = await listKillSwitchEngagedSeqs(tx, ctx);
  const approval = i.intent.decision === "approve" ? await getApprovalOfIntent(tx, ctx, i.intent.id) : null;
  const allow = i.intent.decision === "allow";
  const certificates = allow ? await listJobCertificates(tx, ctx, i.intent.job_id) : [];
  const certificateAudits = allow ? await listCertificateAuditEvents(tx, ctx, i.intent.job_id) : [];
  return judgeProvenance(i, { decisions, approval, taskAudits, killSwitchSeqs, certificates, certificateAudits });
}
