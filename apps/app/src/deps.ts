// app の依存（AppDeps）。ルート・処理はこれだけを受け取り、試験は差し替える（偽の gateway・sim-world・LLM・時計）。
// 本番の組み立ては createAppDeps（server.ts から）。足りない環境変数があっても作れる（準備中：D-47）：
// DB・gateway・sim-world・Gemini は「使うと失敗する」代わりを入れ、準備中の確認が処理まで通さない

import { randomUUID } from "node:crypto";
import { createDb, type Db, type Tx, type WsCtx } from "@open-team/db";
import type { HaltedTask } from "@open-team/db/app";
import { createGatewayClient, GatewayClientError, type GatewayClient } from "@open-team/gateway-client";
import { createEdgeGeminiClient, createRuntime, sandboxEdgeOf, type SandboxEdge, type SandboxProvider } from "@open-team/edge";
import { createSandboxProvider } from "./sandbox/providers.ts";
import { LlmError, createLlmClient, PROVIDER_KEY_NAMES, findPrice, profilePrice, type LlmClient, type LlmConfig } from "@open-team/llm";
import { createLogger, createServiceAuth, systemClock, type Clock, type Logger, type ServiceAuth } from "@open-team/platform";
import { createSimClient, unavailableSimClient, type SimClient } from "@open-team/sim-client";
import type { GoogleFetch } from "./connectors/google.ts";
import type { AppEnv } from "./env.ts";
import { asksOnTaskSettled, asksOnTasksTerminated, asksTickStep } from "./asks/hooks.ts";
import { incidentOnTasksTerminated } from "./rehearsal/incident-hook.ts";
import { approvalsTickStep } from "./check/tick-step.ts";
import { reRehearsalStep } from "./rehearsal/re-rehearse.ts";
import { createWorkspaceEventHub, type WorkspaceEventHub } from "./events.ts";
import { createRunningTaskRegistry, type RunningTaskRegistry } from "./registry.ts";
import { DEFAULT_SSE_OPTIONS, type SseOptions } from "./sse.ts";

/** タスクが終了状態になったときの処理（BR-80 の回帰の試験・順番の進め方の入口。次の担当が足す） */
export interface TasksTerminatedEvent {
  tasks: readonly HaltedTask[];
  cause: "kill_switch";
  now: Date;
}
/** 同じトランザクションの中で呼ぶ。外部（Gemini・gateway・sim-world）を呼ばない（G-14） */
export type TasksTerminatedHook = (tx: Tx, ctx: WsCtx, e: TasksTerminatedEvent) => Promise<void>;

/** 承認の API（却下）・タスクの取り消しでタスクが終了状態になった（依頼の回答・順番の次の段の進め方の入口） */
export interface TaskSettledEvent {
  taskId: string;
  status: string;
  now: Date;
}
/** 同じトランザクションの中で呼ぶ。外部を呼ばない（G-14） */
export type TaskSettledHook = (tx: Tx, ctx: WsCtx, e: TaskSettledEvent) => Promise<void>;

export interface AppHooks {
  tasksTerminated: TasksTerminatedHook[];
  /** 省略は空（承認の API が却下でタスクを終えたときに呼ぶ） */
  taskSettled?: TaskSettledHook[];
}

/** トランザクションの中の処理の結果と、コミットのあとにすること（登録簿の中断・ログなど。外部を呼ぶのもここ：G-14） */
export interface InTxResult<T> {
  body: T;
  afterCommit?: () => void;
}

/** EP-47 の応答（AS §2.12.1） */
export interface CronTickCounts {
  dispatched: number;
  expiredApprovals: number;
  scheduled: number;
  reRehearsals: number;
}

/** 毎分の tick の1つの手順（G-02：取りこぼしの拾い直しだけ。次の担当が足す） */
export interface TickStep {
  name: string;
  run(deps: AppDeps, now: Date): Promise<Partial<CronTickCounts>>;
}

export interface AppDeps {
  env: AppEnv;
  /** 足りない・不正な環境変数の名前（D-47。空なら準備完了） */
  missing: readonly string[];
  db: Db;
  /** 掃除専用（ot_retention。EP-48。接続は1本） */
  maintDb: Db;
  log: Logger;
  clock: Clock;
  ids: { newId(): string };
  gatewayClient: GatewayClient;
  simClient: SimClient;
  llm: LlmClient;
  /** Google の呼び出し（token・カレンダー・revoke。試験で差し替える：16 §3.6） */
  googleFetch: GoogleFetch;
  /** GitHub の呼び出し（認可コードの交換・利用者とインストールの確認。試験で差し替える：18 §3.6） */
  githubFetch: typeof fetch;
  /** サービス間の認証（/internal/* の受け口と、gateway・sim-world を呼ぶときのヘッダー） */
  serviceAuth: ServiceAuth;
  registry: RunningTaskRegistry;
  eventHub: WorkspaceEventHub;
  hooks: AppHooks;
  tickSteps: TickStep[];
  sse: SseOptions;
  /** 入口の失敗が続く IP の待ち（試験で差し替える） */
  sleep(ms: number): Promise<void>;
  /** 作業場の起こし方（D-116）。null なら作業場の道具を渡さない */
  sandbox: SandboxProvider | null;
  /** sandbox-edge（作業場が /sandbox/v1 で呼ぶ処理） */
  sandboxEdge: SandboxEdge;
}

/** DB の接続の本数（SO §4.6：各サービス2本。LISTEN は別の接続。10/8 の計測で見直す：G-14） */
export const APP_DB_POOL_MAX = 2;

/** DATABASE_URL がないとき（準備中）。使うと失敗する */
export function unavailableDb(): Db {
  const fail = async (): Promise<never> => {
    throw new Error("DATABASE_URL が設定されていない（準備中）");
  };
  return { inTransaction: false, query: fail, transaction: fail, listen: fail, notify: fail, close: async () => {} };
}

/** GATEWAY_URL がないとき。どれも GatewayClientError(503, NOT_CONFIGURED) */
export function unavailableGatewayClient(): GatewayClient {
  const fail = async (): Promise<never> => {
    throw new GatewayClientError(503, "NOT_CONFIGURED");
  };
  return { callReadTool: fail, executeIntent: fail, syncTools: fail, revokeCredential: fail };
}

/** GEMINI_API_KEY がないとき。呼ぶ前に断る（status null・やり直さない） */
export function unavailableLlm(keyName = "GEMINI_API_KEY", config?: LlmConfig): LlmClient {
  const unavailable = (): never => { throw new LlmError(`${keyName} が設定されていないので LLM を呼べない`, null, false); };
  return {
    ...(config ? {
      priceFor: (model: string) => config.provider === "gemini" ? findPrice(model) : (Object.hasOwn(config.profiles, model) ? profilePrice(model, config.profiles[model]!) : null),
      preflight: unavailable,
    } : {}),
    async generate() {
      return unavailable();
    },
  };
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 本番の組み立て（server.ts）。overrides で一部を差し替えられる */
export function createAppDeps(env: AppEnv, missing: readonly string[], overrides: Partial<AppDeps> = {}): AppDeps {
  const log = overrides.log ?? createLogger({ service: "app", ...(env.commitSha ? { commit: env.commitSha } : {}) });
  const db = overrides.db ?? (env.databaseUrl ? createDb(env.databaseUrl, { max: APP_DB_POOL_MAX, applicationName: "open-team-app" }) : unavailableDb());
  const maintDb = overrides.maintDb ?? (env.databaseUrlMaint ? createDb(env.databaseUrlMaint, { max: 1, applicationName: "open-team-maint" }) : unavailableDb());
  const serviceAuth = overrides.serviceAuth ?? createServiceAuth(env.serviceAuth, { log });
  const authHeaders = (aud: string) => serviceAuth.serviceAuthHeaders("sa-app", aud);
  const gatewayClient =
    overrides.gatewayClient ?? (env.gatewayUrl ? createGatewayClient({ baseUrl: env.gatewayUrl, authHeaders }) : unavailableGatewayClient());
  const simClient = overrides.simClient ?? (env.simWorldUrl ? createSimClient({ baseUrl: env.simWorldUrl, authHeaders }) : unavailableSimClient());
  const llm =
    overrides.llm ??
    // 1回だけ呼ぶクライアント。やり直しは edge の callGemini の1か所でする（中でもやり直すと二重になり、504 の待ちが最大 約8分に伸びて見えない）
    (env.llm
      ? (env.llm.apiKey ? createLlmClient(env.llm) : unavailableLlm(PROVIDER_KEY_NAMES[env.llm.provider], env.llm))
      : (env.gemini.apiKey ? createEdgeGeminiClient({ apiKey: env.gemini.apiKey }) : unavailableLlm()));
  const clock = overrides.clock ?? systemClock;
  // sandbox-edge は作業場からのトークンで動く（LLM・gateway は使わない）
  const sandboxEdge = overrides.sandboxEdge ?? sandboxEdgeOf(createRuntime({ db, llm, gateway: gatewayClient, clock, log }));
  const sandbox = overrides.sandbox !== undefined ? overrides.sandbox : createSandboxProvider(env.sandbox, { edge: () => sandboxEdge, log });
  return {
    env,
    missing,
    db,
    maintDb,
    log,
    clock,
    ids: overrides.ids ?? { newId: () => randomUUID() },
    gatewayClient,
    simClient,
    llm,
    googleFetch: overrides.googleFetch ?? fetch,
    githubFetch: overrides.githubFetch ?? fetch,
    serviceAuth,
    registry: overrides.registry ?? createRunningTaskRegistry(),
    eventHub: overrides.eventHub ?? createWorkspaceEventHub({ db, log }),
    hooks: overrides.hooks ?? { tasksTerminated: [incidentOnTasksTerminated, asksOnTasksTerminated], taskSettled: [asksOnTaskSettled] },
    tickSteps: overrides.tickSteps ?? [approvalsTickStep, reRehearsalStep, asksTickStep],
    sse: overrides.sse ?? DEFAULT_SSE_OPTIONS,
    sleep: overrides.sleep ?? defaultSleep,
    sandbox,
    sandboxEdge,
  };
}
