// task-edge の各処理が共有する実行時の値（packages/edge/src/runtime.ts の WorkspaceDO 版）。WorkspaceDO が1つ持つ（メモリ）。
// Node 版との違い：
// - DB・LLM・gateway・時計・ログは持たない（DB は呼ぶ側が渡す WsDb、時刻は呼ぶ側が渡す now、LLM は Workflow の側が呼ぶ）
// - あとで呼ぶ処理（EdgeHooks：onIntentRecorded・onReportSubmitted・onTaskTerminal など）は持たない。呼ぶ側が戻り値を見てつなぐ
// - 作業場（SandboxProvider）は持たない（常に使えない：sandboxProvider: false）。信頼するスキルの表は空（skill-trust.ts）

import { DEFAULT_AGENT_MODEL, DEFAULT_PLANNER_MODEL } from "@open-team/llm";
import { EDGE_LIMITS, type EdgeLimits } from "./limits.ts";
import { SlidingWindowLimiter } from "./rate-limit.ts";
import { NO_TRUSTED_SKILLS, type TrustedSkillDigests } from "./skill-trust.ts";

export interface TaskEdgeRuntime {
  limits: EdgeLimits;
  /** Router のモデル（modelForPhase に渡す） */
  models: { agentModel: string; plannerModel: string };
  /** 1タスクの LLM の呼び出しの回数（1分あたり。DO のメモリ） */
  llmLimiter: SlidingWindowLimiter;
  /** 1タスクの postEvents の件数（1秒あたり。DO のメモリ） */
  eventLimiter: SlidingWindowLimiter;
  /** マスクする既知の値（環境変数の秘密など。platform の knownSecretsFromEnv） */
  knownSecrets: readonly string[];
  /** ツール呼び出しの ID を作り直すとき（モデルの ID が空・重なった） */
  newId: () => string;
  /** load_skill が信頼するスキル（4c は空。skill-trust.ts） */
  trustedSkills: TrustedSkillDigests;
}

export function createTaskEdgeRuntime(o: {
  models?: { agentModel: string; plannerModel: string };
  knownSecrets?: readonly string[];
  /** 試験で上限を差し替える */
  limits?: Partial<EdgeLimits>;
  /** 試験で ID を決まった値にする（既定 crypto.randomUUID） */
  newId?: () => string;
}): TaskEdgeRuntime {
  const limits: EdgeLimits = { ...EDGE_LIMITS, ...o.limits };
  return {
    limits,
    models: o.models ?? { agentModel: DEFAULT_AGENT_MODEL, plannerModel: DEFAULT_PLANNER_MODEL },
    llmLimiter: new SlidingWindowLimiter(limits.llmCallsPerMinute, 60_000),
    eventLimiter: new SlidingWindowLimiter(limits.eventsPerSecond, 1_000),
    knownSecrets: o.knownSecrets ?? [],
    newId: o.newId ?? (() => crypto.randomUUID()),
    trustedSkills: NO_TRUSTED_SKILLS,
  };
}

/** タスクが終わったとき：回数の数えを捨てる（Node 版の notifyTerminal のうち、メモリの片付けだけ） */
export function forgetTask(rt: TaskEdgeRuntime, taskId: string): void {
  rt.llmLimiter.forget(taskId);
  rt.eventLimiter.forget(taskId);
}
