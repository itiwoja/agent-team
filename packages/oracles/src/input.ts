// オラクルの入力（sim-world-rehearsal.md §4.3）。走行1本ぶんの「始めと終わりの状態・事象・判定の記録」
// 状況ごとに governed・governed_approve・shadow の走行それぞれで作る（§4.4.3 の8）。計測（D-54）は Kernel を通さない走行で作る

import type { Decision, EffectiveRule, Guard, StoppedWrite } from "@open-team/kernel";
import { EXECUTION_VARIANTS } from "@open-team/sim-core";
import type { Scenario, ShopState, SimEvent, WorldId } from "@open-team/sim-core";

/**
 * 走行の種類（M-41 の ExecutionVariant）に、計測（D-54・G-11：統制なし＝Kernel を通さない走行）を足したもの。
 * measure は DB の列挙にない（計測は保存しない）ので、オラクルの入力だけで使う
 */
export const ORACLE_VARIANTS = [...EXECUTION_VARIANTS, "measure"] as const;
export type OracleVariant = (typeof ORACLE_VARIANTS)[number];

/** その走行で記録された Intent（action_intents の行。SW §4.3） */
export interface OracleIntent {
  id: string;
  taskId: string;
  /** 'mcp.<connector>.<tool>' */
  action: string;
  /** 元の引数（Gateway に渡した値） */
  args: Record<string, unknown>;
  destinationKey: string;
  optionDigest: string;
  decision: Decision;
  reasonCode: string;
  matchedRule: string | null;
  /** 判定どおりに止めたか（影は false：BR-67 ③） */
  enforced: boolean;
  /** Intent の時点でタスクが汚染されていたか（BR-38・BR-71） */
  taintedAtProposal: boolean;
  /** 承認した分岐で、人が承認したことにして実行したもの（§4.4.3 の4、G-06） */
  humanApprovedInBranch: boolean;
  status: string;
}

/** その走行のタスクの判定（policy_decisions の行） */
export interface OracleDecision {
  taskId: string;
  subjectKind: "tool_call" | "llm_call" | "intent";
  decision: Decision;
  reasonCode: string;
  enforced: boolean;
}

/**
 * O-04 の★「カウンタが上限を超えたのに判定がない」を、判定の記録がないタスク（計測）で sim の事象から数え直すときの上限。
 * 値は仕事の実効ポリシーのもの（max_intents_per_task・breakers.same_action_repeat）。予算（費用）は事象に出ないので数えない
 */
export interface OracleLimits {
  /** 1タスクで実行した書き込みがこれを超えたら失敗（Kernel は超える Intent を deny(intent_limit) にする） */
  maxIntentsPerTask: number;
  /** 同じ呼び出し（ツールと引数が同じ）がこの回数続いたら失敗（Kernel はこの回数目で halt(breaker_tripped) にする） */
  sameActionRepeat: number;
}

/**
 * O-04 の★を数え直すときの、タスクのツール呼び出し1件（Kernel の判定に掛けるのと同じ並び：LLM の応答の順。sim-world に
 * 届かなかった呼び出しも入る）。Kernel の repeatKey は notify・submit_report・引数の誤った呼び出しでも切れるので、sim の事象だけで
 * 数えると多くなる（見直しで足した）。計測の EdgePort（measureEdge）が記録して渡す
 */
export interface OracleToolCall {
  taskId: string;
  /** LLM が呼んだツールの名前（mcp_call・submit_report・notify・finish など） */
  name: string;
  /** mcp_call のとき 'mcp.<コネクタ>.<ツール>'（Subject.action）。ほかは null */
  action: string | null;
  /** 判定に渡す引数（Subject.args。mcp_call は arguments の中身） */
  args: unknown;
  /** Intent になったか（引数が入力スキーマに合った MCP の書き込み。合わないものは Intent にしない：M-12） */
  intent: boolean;
}

export interface OracleInput {
  world: WorldId;
  variant: OracleVariant;
  scenario: Scenario;
  /** 走行の始めの状態（applyScenario のあと。incident はスナップショットから） */
  initial: ShopState;
  /** 走行の終わりの状態（2日目 23:59 まで進めたあと） */
  final: ShopState;
  events: readonly SimEvent[];
  intents: readonly OracleIntent[];
  decisions: readonly OracleDecision[];
  /** その走行で効いていたポリシー（候補のルールを含む。§4.4.1、G-03）。計測は空 */
  target: { rules: readonly EffectiveRule[]; guards: readonly Guard[] };
  /** incident の試験だけ（O-08。M-26 の rehearsal_cases.stopped_writes）。ほかは null */
  stoppedWrites: readonly StoppedWrite[] | null;
  /** O-04 の★（推奨）。省略・null なら数え直さない */
  limits?: OracleLimits | null;
  /** O-04 の★の材料（判定の記録がないタスクのツール呼び出しの並び）。省略・null なら sim の事象から数える */
  toolCalls?: readonly OracleToolCall[] | null;
}

/**
 * 計測（D-54。統制なし）の1回ぶんの入力。承認・ルール・判定の記録は空で、O-02・O-03 は正規の宛先（known）で補う（§4.9 の3）。
 * limits を渡すと O-04 を数え直す（Breaker・Intent の数の上限を超えた繰り返し）。toolCalls を渡すと、sim の事象の代わりに
 * Kernel と同じ並び（sim に届かなかった呼び出しを含む）で数える
 */
export function measurementOracleInput(run: {
  scenario: Scenario;
  initial: ShopState;
  final: ShopState;
  events: readonly SimEvent[];
  limits?: OracleLimits | null;
  toolCalls?: readonly OracleToolCall[] | null;
}): OracleInput {
  return {
    world: run.scenario.world,
    variant: "measure",
    scenario: run.scenario,
    initial: run.initial,
    final: run.final,
    events: run.events,
    intents: [],
    decisions: [],
    target: { rules: [], guards: [] },
    stoppedWrites: null,
    limits: run.limits ?? null,
    toolCalls: run.toolCalls ?? null,
  };
}
