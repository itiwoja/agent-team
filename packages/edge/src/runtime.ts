// createEdge の依存と、各処理が共有する実行時の値（上限・時計・ログ・回数の数え・あとで呼ぶ処理）

import { randomUUID } from "node:crypto";
import type { GatewayClient } from "@open-team/gateway-client";
import { DEFAULT_AGENT_MODEL, DEFAULT_PLANNER_MODEL, type LlmClient, type SleepFn } from "@open-team/llm";
import { silentLogger, systemClock, type Clock, type Logger } from "@open-team/platform";
import type { Db, IntentStatus, TaskStatus, Uuid, WsCtx } from "@open-team/db";
import { closeSandboxSessionsOfTask } from "@open-team/db/sandbox";
import { EDGE_LIMITS, SPEND_LIMITS, type EdgeLimits, type SpendLimits } from "./limits.ts";
import { SlidingWindowLimiter } from "./rate-limit.ts";
import { fetchPage, type PageFetcher } from "./web-page.ts";
import { NO_TRUSTED_SKILLS, type TrustedSkillDigests } from "./skill-trust.ts";
import { errorMessage } from "./util.ts";

/**
 * コミットのあとに呼ぶ処理（app の intents・formation が受け取る。edge は中身を知らない）。
 * 失敗してもエージェントの処理は止めない（ログに残すだけ）
 */
export interface EdgeHooks {
  /**
   * MCP の書き込みを Intent にした（LLM Proxy のコミットのあと）。status が approved（ルールの allow）なら、
   * app の intents が gateway の実行（EP-50）を起こす。pending_approval なら確認の行（SSE）
   */
  onIntentRecorded?(ctx: WsCtx, e: { taskId: Uuid; intentId: Uuid; status: IntentStatus }): Promise<void> | void;
  /** submit_report を受け付けた（formation-runtime.md §3.12 の onReportSubmitted） */
  onReportSubmitted?(ctx: WsCtx, e: { taskId: Uuid; status: TaskStatus }): Promise<void> | void;
  /**
   * 連絡板に連絡が載った（team_post のコミットのあと。FR-064）。app が SSE（ask.message.posted）を流し、
   * 終わった担当への question なら追いのターンを起こす。edge は担当を新しく動かさない
   */
  onTeamMessagePosted?(
    ctx: WsCtx,
    e: { askId: Uuid; messageId: Uuid; kind: "share" | "question" | "reply" | "revise"; fromTaskId: Uuid; toMemberId: Uuid | null },
  ): Promise<void> | void;
  /** 担当が利用者に質問を出した（posted）・待ちを終えた（expired）。app が SSE で依頼の画面に知らせる */
  onAgentQuestion?(ctx: WsCtx, e: { askId: Uuid; questionId: Uuid; taskId: Uuid; status: "posted" | "expired" }): Promise<void> | void;
  /** タスクが終了状態になった（halt・finish・LLM の失敗・報告で終わったとき。§3.5 の onMemberTaskTerminal） */
  onTaskTerminal?(ctx: WsCtx, e: { taskId: Uuid; status: TaskStatus }): Promise<void> | void;
}

/**
 * 作業場（サンドボックス）を起こす口（D-116）。app が手元（Docker）・試験（同じプロセス）の実装を渡す。
 * start は作業場の実行役を起こすだけで、待たない。実行役は sandbox-edge にトークンで来て、コマンドを取りに来る
 */
export interface SandboxProvider {
  readonly name: string;
  start(input: { ctx: WsCtx; sessionId: Uuid; taskId: Uuid; token: string }): Promise<{ ref: string }>;
}

export interface EdgeDeps {
  db: Db;
  /** 1回だけ呼ぶ LLM のクライアント（本番は createEdgeGeminiClient。やり直しは edge がする） */
  llm: LlmClient;
  gateway: GatewayClient;
  /** Router のモデル（llm の readGeminiEnv の agentModel・plannerModel） */
  models?: { agentModel: string; plannerModel: string };
  clock?: Clock;
  log?: Logger;
  /** LLM のやり直しの待ち（試験で差し替える。既定 1・4・16秒） */
  retry?: { delaysMs?: readonly number[]; sleep?: SleepFn };
  limits?: Partial<EdgeLimits>;
  spendLimits?: Partial<SpendLimits>;
  /** マスクする既知の値（環境変数の秘密など。platform の knownSecretsFromEnv） */
  knownSecrets?: readonly string[];
  /** ツール呼び出しの ID を作り直すとき（モデルの ID が空・重なった）。既定 crypto.randomUUID */
  newId?: () => string;
  /** タスクを止める合図（Kill Switch の RunningTaskRegistry：SO §3.15）。LLM の呼び出しを中断する */
  signalFor?: (taskId: Uuid) => AbortSignal | undefined;
  hooks?: EdgeHooks;
  /** web_fetch の取得（試験で差し替える。既定 fetchPage：付与したドメインだけ・内部のアドレスに繋がない） */
  fetchPage?: PageFetcher;
  /** 作業場（D-116）。省略なら作業場の道具は渡さない */
  sandbox?: SandboxProvider;
  /**
   * 運営のパックのスキルの本文の SHA-256（SG-05。app の packs/catalog.ts の TRUSTED_SKILLS）。load_skill はこれと一致するスキルだけを
   * 信頼された手順書として渡し、それ以外は <untrusted> で包んでタスクを汚染する。省略ならどのスキルも信頼しない
   */
  trustedSkills?: TrustedSkillDigests;
}

export interface EdgeRuntime {
  db: Db;
  llm: LlmClient;
  gateway: GatewayClient;
  models: { agentModel: string; plannerModel: string };
  clock: Clock;
  log: Logger;
  retry: { delaysMs?: readonly number[]; sleep?: SleepFn };
  limits: EdgeLimits;
  spendLimits: SpendLimits;
  knownSecrets: readonly string[];
  newId: () => string;
  signalFor: EdgeDeps["signalFor"];
  hooks: EdgeHooks;
  fetchPage: PageFetcher;
  sandbox: SandboxProvider | null;
  trustedSkills: TrustedSkillDigests;
  llmLimiter: SlidingWindowLimiter;
  eventLimiter: SlidingWindowLimiter;
}

export function createRuntime(deps: EdgeDeps): EdgeRuntime {
  const limits: EdgeLimits = { ...EDGE_LIMITS, ...deps.limits };
  return {
    db: deps.db,
    llm: deps.llm,
    gateway: deps.gateway,
    models: deps.models ?? { agentModel: DEFAULT_AGENT_MODEL, plannerModel: DEFAULT_PLANNER_MODEL },
    clock: deps.clock ?? systemClock,
    log: deps.log ?? silentLogger,
    retry: deps.retry ?? {},
    limits,
    spendLimits: { ...SPEND_LIMITS, ...deps.spendLimits },
    knownSecrets: deps.knownSecrets ?? [],
    newId: deps.newId ?? (() => randomUUID()),
    signalFor: deps.signalFor,
    hooks: deps.hooks ?? {},
    fetchPage: deps.fetchPage ?? fetchPage,
    sandbox: deps.sandbox ?? null,
    trustedSkills: deps.trustedSkills ?? NO_TRUSTED_SKILLS,
    llmLimiter: new SlidingWindowLimiter(limits.llmCallsPerMinute, 60_000),
    eventLimiter: new SlidingWindowLimiter(limits.eventsPerSecond, 1_000),
  };
}

/** あとで呼ぶ処理（コミットのあと）。失敗はログだけ */
export async function runHook(rt: EdgeRuntime, name: string, taskId: Uuid, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (e) {
    rt.log.error("edge.hook_failed", `edge のあとの処理 ${name} が失敗しました`, { taskId, error: errorMessage(e) });
  }
}

/** タスクが終わったときに呼ぶ（回数の数えも捨てる） */
export async function notifyTerminal(rt: EdgeRuntime, ctx: WsCtx, taskId: Uuid, status: TaskStatus): Promise<void> {
  rt.llmLimiter.forget(taskId);
  rt.eventLimiter.forget(taskId);
  // 作業場を閉じる（実行役は次の next で done を受け取り、最後の控えを送って終える：D-116）
  if (rt.sandbox !== null) await runHook(rt, "closeSandbox", taskId, () => closeSandboxSessionsOfTask(rt.db, ctx, taskId, "task_ended", rt.clock.now()).then(() => undefined));
  const hook = rt.hooks.onTaskTerminal;
  if (hook) await runHook(rt, "onTaskTerminal", taskId, () => hook(ctx, { taskId, status }));
}
