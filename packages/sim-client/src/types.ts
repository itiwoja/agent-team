// sim-world の管理 API（/admin/v1/*）の入出力の型（apps/sim-world/src/admin.ts の本文と応答に合わせる。M-44、SW §4.1.3）
// 呼べるのは sa-app だけ（15:484）。どの操作も workspaceId で絞られる（別のワークスペースの走行は 404）。
// 応答の形は zod で軽く確かめる（状態・事象・状況の中身は sim-core の型で受け、ここでは形を作り直さない）

import { z } from "zod";
import { EXECUTION_VARIANTS, WORLD_IDS, type DamageBreakdown, type ExecutionVariant, type Scenario, type ScenarioSchema, type SimEvent, type WorldId } from "@open-team/sim-core";

/** 走行（デモ店舗・リハーサルの状況×種類・承認した分岐）の見え方（admin.ts の ExecutionView） */
export interface SimExecutionView {
  id: string;
  workspaceId: string;
  world: WorldId;
  /** null＝デモ店舗（15:369） */
  rehearsalRunId: string | null;
  parentExecutionId: string | null;
  variant: ExecutionVariant;
  seed: number;
  seedVersion: string;
  scenario: Scenario | null;
  snapshotId: string | null;
  version: number;
  /** 状態の正規形 JSON の SHA-256（SW §4.4.9） */
  stateHash: string;
  createdAt: string;
  updatedAt: string;
}

/** スナップショット（admin.ts の SnapshotView。状態の中身は返さない） */
export interface SimSnapshotView {
  id: string;
  workspaceId: string;
  world: WorldId;
  executionId: string;
  executionVersion: number;
  seed: number;
  seedVersion: string;
  stateHash: string;
  sourceTaskId: string;
  takenAt: string;
}

/** GET /executions/:id（オラクル・タイムライン・読み取り専用の表示の材料） */
export interface SimExecutionDetail {
  execution: SimExecutionView;
  initialState: unknown;
  state: unknown;
  events: SimEvent[];
}

// ---- 本文（admin.ts の strictObject と同じキーだけ） ----

/** POST /demo-store（ワークスペースに1つ。あればそれを返す：SO-SIM-04） */
export interface EnsureDemoStoreRequest {
  workspaceId: string;
  world: WorldId;
  /** 15:341 の seed_version。省略は sim-world の今の版 */
  seedVersion?: string;
  /** 省略はワークスペースから決める */
  seed?: number;
  /** 1日目の日付（'YYYY-MM-DD'）。省略は作った日（JST） */
  startDate?: string;
}

/** POST /executions（リハーサルの走行。承認した分岐は fork だけで作る） */
export interface CreateExecutionRequest {
  workspaceId: string;
  world: WorldId;
  rehearsalRunId: string;
  /** 呼び出し側（リハーサルの実行器）が決める */
  executionId: string;
  variant: "governed" | "shadow";
  /** 既定値は sim-world が埋める（ScenarioSchema の入力の形） */
  scenario: z.input<typeof ScenarioSchema>;
  /** FR-066：止まったタスクの開始時の状態から */
  snapshotId?: string;
}

export interface ForkExecutionRequest {
  workspaceId: string;
  /** 元（governed の走行） */
  sourceExecutionId: string;
  /** 新しい承認した分岐（governed_approve）の ID */
  executionId: string;
}

export interface AdvanceExecutionRequest {
  workspaceId: string;
  executionId: string;
  /** タイムゾーンつきの ISO 8601（仮想時刻） */
  to: string;
}

export interface ExecutionRef {
  workspaceId: string;
  executionId: string;
}

/** Web の検索結果の1件（sim-world の web の応答。F-14 のページだけが並ぶ） */
export interface SimWebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Web の応答の中身（admin.ts の web。fetch は F-14 のページなら 200、それ以外は 404。search は一覧） */
export type SimWebResult =
  | { kind: "fetch"; status: 200; title: string; body: string }
  | { kind: "fetch"; status: 404; message: string }
  | { kind: "search"; status: 200; results: SimWebSearchHit[] };

/** POST /executions/:id/web の応答。events は読んだ・見せた事象（F-14。保存された分） */
export interface SimWebResponse {
  execution: SimExecutionView;
  result: SimWebResult;
  events: SimEvent[];
}

/** POST /snapshots（デモ店舗の今の状態を写す。FR-066・G-07） */
export interface CreateSnapshotRequest {
  workspaceId: string;
  world: WorldId;
  sourceTaskId: string;
}

export interface SimCallOptions {
  signal?: AbortSignal;
  /** x-request-id（sim-world のログとつなぐ） */
  requestId?: string;
}

export interface SimClient {
  ensureDemoStore(req: EnsureDemoStoreRequest, opts?: SimCallOptions): Promise<{ execution: SimExecutionView; created: boolean }>;
  createExecution(req: CreateExecutionRequest, opts?: SimCallOptions): Promise<{ execution: SimExecutionView }>;
  getExecution(ref: ExecutionRef, opts?: SimCallOptions): Promise<SimExecutionDetail>;
  forkExecution(req: ForkExecutionRequest, opts?: SimCallOptions): Promise<{ execution: SimExecutionView }>;
  advanceExecution(req: AdvanceExecutionRequest, opts?: SimCallOptions): Promise<{ execution: SimExecutionView; events: SimEvent[] }>;
  computeDamage(ref: ExecutionRef, opts?: SimCallOptions): Promise<{ execution: SimExecutionView; damage: DamageBreakdown }>;
  createSnapshot(req: CreateSnapshotRequest, opts?: SimCallOptions): Promise<{ snapshot: SimSnapshotView }>;
  /** Web のページを取得する（リハーサル。F-14 のページを読ませる口）。url は sim-world が F-14 のページと照らす */
  webFetch(ref: ExecutionRef, url: string, opts?: SimCallOptions): Promise<SimWebResponse>;
  /** Web を検索する（リハーサル。F-14 のページの一覧）。Gemini は呼ばない */
  webSearch(ref: ExecutionRef, query: string, opts?: SimCallOptions, maxResults?: number): Promise<SimWebResponse>;
  /** sim の行をすべて消す（EP-55 の掃除。冪等） */
  deleteWorkspace(workspaceId: string, opts?: SimCallOptions): Promise<void>;
}

/**
 * sim-world の失敗。status は HTTP の状態（届かない・時間切れは 0）。
 * code はサーバーの error.code（NOT_FOUND・EXECUTION_EXISTS・FORK_NOT_ALLOWED など）か、
 * NETWORK_ERROR・TIMEOUT・BAD_RESPONSE（応答の形が違う）・NOT_CONFIGURED（SIM_WORLD_URL がない）
 */
export class SimClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;
  constructor(status: number, code: string, message?: string, opts: { details?: unknown; requestId?: string | null; cause?: unknown } = {}) {
    super(message ?? `sim-world ${status} ${code}`, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "SimClientError";
    this.status = status;
    this.code = code;
    this.details = opts.details;
    this.requestId = opts.requestId ?? null;
  }
}

export function isSimClientError(e: unknown): e is SimClientError {
  return e instanceof SimClientError;
}

// ---- 応答の形の確かめ（キーが増えても壊れないよう looseObject。足りない・型が違えば BAD_RESPONSE） ----

const WorldIdSchema = z.enum(WORLD_IDS);
const VariantSchema = z.enum(EXECUTION_VARIANTS);

/** sim-core の SimEvent の必須項目と省略可能項目を検証する。 */
export const SimEventSchema = z.looseObject({
  seq: z.number().int().positive(),
  at: z.string().min(1),
  kind: z.enum(["tool_call", "clock", "delivery", "payment", "sales", "fault"]),
  tool: z.string().optional(),
  args: z.unknown().optional(),
  result: z.unknown().optional(),
  outcome: z.enum(["ok", "tool_error", "http_429", "http_503", "timeout_after_commit", "not_committed"]).optional(),
  committed: z.boolean().optional(),
  intentId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  caller: z.enum(["sa-gateway", "sa-app", "clock"]),
});

export const ExecutionViewSchema = z.looseObject({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  world: WorldIdSchema,
  rehearsalRunId: z.string().nullable(),
  parentExecutionId: z.string().nullable(),
  variant: VariantSchema,
  seed: z.number().int().nonnegative(),
  seedVersion: z.string().min(1),
  scenario: z.unknown(),
  snapshotId: z.string().nullable(),
  version: z.number().int().positive(),
  stateHash: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const SnapshotViewSchema = z.looseObject({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  world: WorldIdSchema,
  executionId: z.string().min(1),
  executionVersion: z.number().int().positive(),
  seed: z.number().int().nonnegative(),
  seedVersion: z.string().min(1),
  stateHash: z.string().min(1),
  sourceTaskId: z.string().min(1),
  takenAt: z.string().min(1),
});

export const ExecutionResponseSchema = z.looseObject({ execution: ExecutionViewSchema });
export const DemoStoreResponseSchema = z.looseObject({ execution: ExecutionViewSchema, created: z.boolean() });
export const ExecutionDetailResponseSchema = z.looseObject({
  execution: ExecutionViewSchema,
  initialState: z.unknown(),
  state: z.unknown(),
  events: z.array(SimEventSchema),
});
export const AdvanceResponseSchema = z.looseObject({ execution: ExecutionViewSchema, events: z.array(SimEventSchema) });
export const DamageResponseSchema = z.looseObject({
  execution: ExecutionViewSchema,
  damage: z.looseObject({ totalJpy: z.number() }),
});
export const SnapshotResponseSchema = z.looseObject({ snapshot: SnapshotViewSchema });
const WebSearchHitSchema = z.looseObject({ title: z.string(), url: z.string(), snippet: z.string() });
export const WebResultSchema = z.union([
  z.looseObject({ kind: z.literal("fetch"), status: z.literal(200), title: z.string(), body: z.string() }),
  z.looseObject({ kind: z.literal("fetch"), status: z.literal(404), message: z.string() }),
  z.looseObject({ kind: z.literal("search"), status: z.literal(200), results: z.array(WebSearchHitSchema) }),
]);
export const WebResponseSchema = z.looseObject({ execution: ExecutionViewSchema, result: WebResultSchema, events: z.array(SimEventSchema) });
