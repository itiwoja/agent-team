// 本番の停止から足した試験の題（Scenario.title）。止まり方と理由を平易な日本語にする（reasonCode の英語のコードは題に出さない）。
// 理由のコードは試験の行（rehearsal_cases.reason_code）と止まった書き込み（stopped_writes）にそのまま残る。
// 題に英語のコードが入った古い行（「本番で止まった：確認で却下した（approval_required）」）も、出すときに同じ訳に直す

import type { IncidentKind } from "@open-team/db";

/** 止まり方ごとの言い方 */
export const INCIDENT_KIND_LABEL: Readonly<Record<IncidentKind, string>> = {
  kernel_approve: "確認に回った",
  kernel_deny: "止められた",
  user_reject: "確認で却下した",
  kill_switch: "Kill Switch で止めた",
};

/** Kernel の理由（ReasonCode）と、止まった仕事の理由の平易な名前。知らないコードは「その他の理由」にする（題に英語を出さない） */
const REASON_LABEL: Readonly<Record<string, string>> = {
  kill_switch: "全部止めていた",
  task_terminated: "仕事が終わっていた",
  budget_exceeded: "費用の上限",
  breaker_tripped: "安全装置が働いた",
  unknown_action: "知らない操作",
  not_granted: "許されていない操作",
  tool_needs_review: "道具の確認待ち",
  connector_disabled: "接続先が無効",
  intent_limit: "送る数の上限",
  path_denied: "禁止の場所",
  path_not_allowed: "許可の外の場所",
  autonomy_deny: "任せ方の設定で禁止",
  approval_required: "人の確認が必要",
  unknown_outcome_pending: "届いたかわからない送信がある",
  guard_exceeded: "値の上限を超えた",
  certificate_missing: "安全チェックがまだ",
  autonomy_auto: "任せ方の設定で自動",
  rule_matched: "覚えた決まりに合った",
  not_gated: "確認のいらない操作",
  autonomy_handoff: "任せ方の設定で引き継ぎ",
};

/** 理由のコードの平易な名前 */
export function incidentReasonLabel(reasonCode: string): string {
  return Object.hasOwn(REASON_LABEL, reasonCode) ? REASON_LABEL[reasonCode]! : "その他の理由";
}

/** 題（60文字以内）：「本番で止まった：確認で却下した（人の確認が必要）」。止まり方と同じ理由（Kill Switch）は繰り返さない */
export function incidentTitle(kind: IncidentKind, reasonCode: string): string {
  const how = INCIDENT_KIND_LABEL[kind];
  const why = incidentReasonLabel(reasonCode);
  return (reasonCode === kind || why === how ? `本番で止まった：${how}` : `本番で止まった：${how}（${why}）`).slice(0, 60);
}

const LEGACY = /^(本番で止まった：[^（]*)（([a-z][a-z0-9_]*)）$/;

/** 古い題の末尾の（英語のコード）を訳に直す。当てはまらない題はそのまま */
export function plainIncidentTitle(title: string): string {
  const m = LEGACY.exec(title);
  if (m === null) return title;
  return m[2] === "kill_switch" ? m[1]! : `${m[1]}（${incidentReasonLabel(m[2]!)}）`;
}
