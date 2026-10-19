// sim-world とリハーサルの共通の列挙（sim-world-rehearsal.md §3.1、cross-check.md §4.3 の M-39〜M-51 を正とする）
// 定義だけ。I/O・時刻・乱数を使わない

/** 世界（M-39。コネクタの URL `/mcp/<world>/<service>` と同じ値）。Must は shop だけ（D-53） */
export const WORLD_IDS = ["shop", "brief", "repo"] as const;
export type WorldId = (typeof WORLD_IDS)[number];

/** 障害カタログの ID（固定。Gemini はここから選ぶだけ。15:87-102） */
export const FAULT_IDS = [
  "F-01",
  "F-02",
  "F-03",
  "F-04",
  "F-05",
  "F-06",
  "F-07",
  "F-08",
  "F-09",
  "F-10",
  "F-11",
  "F-12",
  "F-13",
  "F-14",
  "F-15",
  "F-16",
  "F-17",
] as const;
export type FaultId = (typeof FAULT_IDS)[number];

/** オラクル（15:106-116） */
export const ORACLE_IDS = ["O-01", "O-02", "O-03", "O-04", "O-05", "O-06", "O-07", "O-08"] as const;
export type OracleId = (typeof ORACLE_IDS)[number];

/** 試験の出どころ（15:220） */
export const CASE_SOURCES = ["generated", "user", "incident"] as const;
export type CaseSource = (typeof CASE_SOURCES)[number];

/** 合格証が切れた理由（15:221。M-49 で入れ替えの superseded を足す。画面では「切れた」と出さない） */
export const REVOKE_REASONS = ["widen", "tool_hash", "model", "case_added", "superseded"] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

/** 走行の種類（M-41）。live はデモ店舗（rehearsal_run_id が NULL）、governed はそのまま「却下した場合」の分岐 */
export const EXECUTION_VARIANTS = ["live", "governed", "governed_approve", "shadow"] as const;
export type ExecutionVariant = (typeof EXECUTION_VARIANTS)[number];

/** リハーサルの始まり方（M-46。DB の列挙を正とする） */
export const RUN_TRIGGERS = ["initial", "manual", "retest", "recertify", "user_case", "seed", "model_compare"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** リハーサルの走行の状態（M-46） */
export const RUN_STATUSES = ["queued", "generating", "running", "done", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** 状況1件の状態（M-46。合否は verdict、止めた理由は abort_reason に分ける） */
export const SCENARIO_STATUSES = ["queued", "running", "judging", "done", "cancelled", "error"] as const;
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number];
export const SCENARIO_ABORT_REASONS = ["budget", "kill_switch", "timeout", "user"] as const;
export type ScenarioAbortReason = (typeof SCENARIO_ABORT_REASONS)[number];

/** 誰が止めたか（15:122。キーは by：M-46） */
export type StoppedBy =
  | { by: "kernel"; decision: "approve" | "deny" | "halt"; reasonCode: string; matchedRule: string | null }
  | { by: "agent" }
  | { by: "none" };

/** 損害の名前（M-46）と DamageBreakdown のキーの対応 */
export const DAMAGE_KINDS = ["wrong_payee", "duplicate_order", "over_order", "overpriced"] as const;
export type DamageKind = (typeof DAMAGE_KINDS)[number];
export const DAMAGE_KIND_KEYS = {
  wrong_payee: "wrongPayee",
  duplicate_order: "duplicateOrder",
  over_order: "overOrder",
  overpriced: "overpriced",
} as const satisfies Record<DamageKind, string>;

/** 本番で止まった書き込みの止まり方（M-27 の user_reject） */
export const INCIDENT_KINDS = ["kernel_approve", "kernel_deny", "user_reject", "kill_switch"] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

/** 試験を外した理由（M-29） */
export const CASE_REMOVED_REASONS = ["user", "merged", "regenerated"] as const;
export type CaseRemovedReason = (typeof CASE_REMOVED_REASONS)[number];

/** gateway → sim-world のヘッダー（M-43）。世界は URL のパス。値は gateway がタスク・Intent の行から引き直す */
export const SIM_HEADERS = [
  "x-ot-workspace-id",
  "x-ot-rehearsal-run-id",
  "x-ot-sim-execution-id",
  "x-ot-task-id",
  "x-ot-intent-id",
  "x-ot-shadow",
] as const;
export type SimHeader = (typeof SIM_HEADERS)[number];

/** 商品の単位（SW §3.4） */
export const UNITS = ["kg", "本", "個", "ケース", "袋"] as const;
export type Unit = (typeof UNITS)[number];

/** sim の状態の場所（SW §3.5・C-02）。rehearsalRunId・executionId が NULL ならデモ店舗 */
export interface SimExecutionRef {
  workspaceId: string;
  world: WorldId;
  rehearsalRunId: string | null;
  executionId: string | null;
}
