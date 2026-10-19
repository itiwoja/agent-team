// 管理 API（sim-world-rehearsal.md §4.1.3、M-44：接頭辞は /admin/v1/、呼べるのは sa-app だけ）
// 走行の作成（シード・状況・スナップショットから）・fork・advance・damage・web（取得・検索）・取得、スナップショット、デモ店舗、ワークスペースの削除。
// どの操作も workspaceId で絞る（別のワークスペースの走行は 404）。保存は SimStore、世界の中身は sim-core の純粋関数。
// Postgres の保存では、まだないワークスペース・リハーサルの走行を指すと SimStoreReferenceError（app.ts が 404 にする）

import { Hono, type Context } from "hono";
import { z } from "zod";
import { loggerOf } from "@open-team/platform";
import {
  ScenarioSchema,
  WORLD_IDS,
  formatZodIssues,
  hash32,
  jstDateOf,
  parseIso,
  validateScenarioContext,
  type ExecutionVariant,
  type Scenario,
  type WebRequest,
  type WorldId,
} from "@open-team/sim-core";
import type { SimWorldHonoEnv } from "./context.ts";
import { SimHttpError } from "./errors.ts";
import { IdSchema, parseId } from "./ids.ts";
import type { Logger } from "./log.ts";
import type { ExecutionChange, ExecutionKey, SimExecutionRecord, SimSnapshotRecord, SimStore } from "./store.ts";
import { implementedWorld, type AnyWorld, type WorldRegistry } from "./worlds.ts";

export interface AdminDeps {
  store: SimStore;
  worlds: WorldRegistry;
  now: () => Date;
  newId: () => string;
  log: Logger;
}

// ---- 本文（すべて strict。余計なキーは 400）----

const WorldIdSchema = z.enum(WORLD_IDS);

/** POST /executions：リハーサルの走行（状況×種類ごと。SW §3.5・C-02）。ID は呼び出し側（リハーサルの実行器）が決める */
export const CreateExecutionBody = z.strictObject({
  workspaceId: IdSchema,
  world: WorldIdSchema,
  rehearsalRunId: IdSchema,
  executionId: IdSchema,
  /** 承認した分岐（governed_approve）は fork だけで作る。デモ店舗（live）は /demo-store */
  variant: z.enum(["governed", "shadow"]),
  /** シードは状況の seed（M-45）。incident はスナップショットのシードと同じにする（SW §4.7 の6） */
  scenario: ScenarioSchema,
  /** FR-066：止まったタスクの開始時の状態から */
  snapshotId: IdSchema.optional(),
});
export const ForkBody = z.strictObject({ workspaceId: IdSchema, executionId: IdSchema });
/** to はタイムゾーンつきの ISO 8601（仮想時刻） */
export const AdvanceBody = z.strictObject({ workspaceId: IdSchema, to: z.string().min(1).max(64) });
export const WorkspaceBody = z.strictObject({ workspaceId: IdSchema });
/** Web の取得・検索（リハーサルの web_fetch・web_search の模擬。F-14 のページだけ読める。sim-core の WebRequest と同じ形） */
export const WebBody = z.discriminatedUnion("kind", [
  z.strictObject({ workspaceId: IdSchema, kind: z.literal("fetch"), url: z.string().min(1).max(2048) }),
  z.strictObject({ workspaceId: IdSchema, kind: z.literal("search"), query: z.string().min(1).max(500), maxResults: z.int().min(1).max(10).optional() }),
]);
export const SnapshotBody = z.strictObject({ workspaceId: IdSchema, world: WorldIdSchema, sourceTaskId: IdSchema });
export const DemoStoreBody = z.strictObject({
  workspaceId: IdSchema,
  world: WorldIdSchema,
  /** 15:341 の seed_version。省略は今の版 */
  seedVersion: z.string().min(1).max(40).optional(),
  /** 省略はワークスペースから決める（同じワークスペースなら同じ） */
  seed: z.int().min(0).max(0xffff_ffff).optional(),
  /** 1日目の日付（'YYYY-MM-DD'）。省略は作った日（JST。U-26） */
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

// ---- 応答の形 ----

export interface ExecutionView {
  id: string;
  workspaceId: string;
  world: WorldId;
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

export interface SnapshotView {
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

export function executionView(world: AnyWorld, rec: SimExecutionRecord): ExecutionView {
  return {
    id: rec.id,
    workspaceId: rec.workspaceId,
    world: rec.world,
    rehearsalRunId: rec.rehearsalRunId,
    parentExecutionId: rec.parentExecutionId,
    variant: rec.variant,
    seed: rec.seed,
    seedVersion: rec.seedVersion,
    scenario: rec.scenario,
    snapshotId: rec.snapshotId,
    version: rec.version,
    stateHash: world.stateHash(rec.state),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

export function snapshotView(rec: SimSnapshotRecord): SnapshotView {
  const { state: _state, ...view } = rec;
  return view;
}

// ---- 小さな道具 ----

async function readBody<T>(c: Context<SimWorldHonoEnv>, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new SimHttpError(400, "VALIDATION_ERROR", "本文が JSON として読めません");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new SimHttpError(
      400,
      "VALIDATION_ERROR",
      "本文が正しくありません",
      formatZodIssues(parsed.error).map((message) => ({ message })),
    );
  }
  return parsed.data;
}

function idParam(c: Context<SimWorldHonoEnv>, name: string): string {
  const id = parseId(c.req.param(name) ?? "");
  if (id === null) throw new SimHttpError(400, "VALIDATION_ERROR", `${name} が UUID ではありません`);
  return id;
}

function requireWorld(worlds: WorldRegistry, id: string): AnyWorld {
  const w = implementedWorld(worlds, id);
  // brief・repo は sim-core の枠だけ（Should）。中身ができるまで走行を作らない
  if (!w) throw new SimHttpError(400, "VALIDATION_ERROR", `この世界はまだ動きません：${id}`, [{ reason: "world_not_implemented" }]);
  return w;
}

const notFound = (what: string) => new SimHttpError(404, "NOT_FOUND", `${what}が見つかりません`);

/** 世界の関数の RangeError（知らない seedVersion・日付・一度に進めすぎ）は入力の誤り */
function asInputError<T>(fn: () => T, message: string): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RangeError) throw new SimHttpError(400, "VALIDATION_ERROR", `${message}：${e.message}`);
    throw e;
  }
}

export function adminRoutes(deps: AdminDeps): Hono<SimWorldHonoEnv> {
  const admin = new Hono<SimWorldHonoEnv>();
  const nowIso = () => deps.now().toISOString();

  // 走行の作成：初期状態（シードから、またはスナップショットから）に applyScenario をかける（SW §4.1.3）
  admin.post("/executions", async (c) => {
    const body = await readBody(c, CreateExecutionBody);
    const world = requireWorld(deps.worlds, body.world);
    if (body.scenario.world !== body.world) {
      throw new SimHttpError(400, "VALIDATION_ERROR", "scenario.world が world と違います");
    }
    // 文脈の検証（§3.3 の2段目）：その世界で使えない障害・世界にない SKU や仕入れ先は置けない
    const issues = validateScenarioContext(body.scenario.faults, world.scenarioContext());
    if (issues.length > 0) {
      throw new SimHttpError(
        400,
        "VALIDATION_ERROR",
        "状況がこの世界に当てはまりません",
        issues.map((i) => ({ faultIndex: i.faultIndex, faultId: i.faultId, reason: i.reason, message: i.message })),
      );
    }
    let base: unknown;
    let seedVersion = world.seedVersion;
    let snapshotId: string | null = null;
    if (body.snapshotId !== undefined) {
      const snap = await deps.store.getSnapshot(body.workspaceId, body.snapshotId);
      if (!snap) throw notFound("スナップショット");
      if (snap.world !== body.world) throw new SimHttpError(400, "VALIDATION_ERROR", "スナップショットの世界が world と違います");
      if (snap.seed !== body.scenario.seed) {
        throw new SimHttpError(400, "VALIDATION_ERROR", "scenario.seed がスナップショットのシードと違います（SW §4.7 の6）");
      }
      base = snap.state;
      seedVersion = snap.seedVersion;
      snapshotId = snap.id;
    } else {
      base = asInputError(() => world.createInitialState(body.scenario.seed, { seedVersion }), "初期状態を作れません");
    }
    // applyScenario は走行ごとの数え方（日の番号・呼び出しの回数・事象の番号・在庫の最小）を始めに戻してから障害を置く。
    // スナップショット（本番で何日も動いたデモ店舗）の分を引き継がない（sim-core の beginShopRun）
    const state = asInputError(() => world.applyScenario(base, body.scenario), "状況を置けません");
    const at = nowIso();
    const record: SimExecutionRecord = {
      id: body.executionId,
      workspaceId: body.workspaceId,
      world: body.world,
      rehearsalRunId: body.rehearsalRunId,
      parentExecutionId: null,
      variant: body.variant,
      seed: body.scenario.seed,
      seedVersion,
      scenario: body.scenario,
      snapshotId,
      initialState: state,
      state,
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
    if ((await deps.store.createExecution(record)) === "exists") {
      throw new SimHttpError(409, "EXECUTION_EXISTS", "同じ ID の走行があります");
    }
    return c.json({ execution: executionView(world, record) }, 201);
  });

  // 取得：状態と事象（オラクル・タイムライン・読み取り専用の表示）
  admin.get("/executions/:id", async (c) => {
    const id = idParam(c, "id");
    const q = z.strictObject({ workspaceId: IdSchema }).safeParse({ workspaceId: c.req.query("workspaceId") ?? "" });
    if (!q.success) throw new SimHttpError(400, "VALIDATION_ERROR", "workspaceId（クエリ）が UUID ではありません");
    const found = await deps.store.getExecutionWithEvents({ workspaceId: q.data.workspaceId, id });
    if (!found) throw notFound("走行");
    const world = requireWorld(deps.worlds, found.execution.world);
    return c.json({
      execution: executionView(world, found.execution),
      initialState: found.execution.initialState,
      state: found.execution.state,
      events: found.events,
    });
  });

  // fork：状態と事象を写した承認した分岐（governed → governed_approve。SW §4.4.3 の4）
  admin.post("/executions/:id/fork", async (c) => {
    const sourceId = idParam(c, "id");
    const body = await readBody(c, ForkBody);
    const source = await deps.store.getExecution({ workspaceId: body.workspaceId, id: sourceId });
    if (!source) throw notFound("走行");
    const world = requireWorld(deps.worlds, source.world);
    if (source.variant !== "governed") {
      throw new SimHttpError(409, "FORK_NOT_ALLOWED", `分岐を作れるのは governed の走行だけ（この走行は ${source.variant}）`);
    }
    const r = await deps.store.forkExecution({
      workspaceId: body.workspaceId,
      sourceId,
      id: body.executionId,
      variant: "governed_approve",
      at: nowIso(),
    });
    if (r.status === "source_not_found") throw notFound("走行");
    if (r.status === "exists") throw new SimHttpError(409, "EXECUTION_EXISTS", "同じ ID の走行があります");
    return c.json({ execution: executionView(world, r.execution) }, 201);
  });

  // advance：to まで時計を進める（入荷・支払い・売上）。仕事の実行の間は呼ばない（呼ぶ側が守る）
  admin.post("/executions/:id/advance", async (c) => {
    const id = idParam(c, "id");
    const body = await readBody(c, AdvanceBody);
    asInputError(() => parseIso(body.to), "to が読めません");
    const key: ExecutionKey = { workspaceId: body.workspaceId, id };
    const updatedAt = nowIso();
    const res = await deps.store.updateExecution(key, (exec): ExecutionChange<{ world: AnyWorld; events: unknown[] }> => {
      const world = requireWorld(deps.worlds, exec.world);
      const r = asInputError(() => world.advance(exec.state, body.to), "時計を進められません");
      // to が今以前なら何もしない（同じ状態・事象なし）
      if (r.events.length === 0) return { kind: "keep", value: { world, events: [] } };
      return { kind: "write", state: r.state, events: r.events, updatedAt, value: { world, events: r.events } };
    });
    if (!res) throw notFound("走行");
    return c.json({ execution: executionView(res.value.world, res.execution), events: res.value.events });
  });

  // damage：走行の今の状態から固定の式で損害（円）を出す（BR-79。LLM なし）。状態は変えない
  admin.post("/executions/:id/damage", async (c) => {
    const id = idParam(c, "id");
    const body = await readBody(c, WorkspaceBody);
    const found = await deps.store.getExecutionWithEvents({ workspaceId: body.workspaceId, id });
    if (!found) throw notFound("走行");
    const exec = found.execution;
    const world = requireWorld(deps.worlds, exec.world);
    if (exec.scenario === null) {
      throw new SimHttpError(409, "DAMAGE_NOT_AVAILABLE", "デモ店舗には状況がないので損害を出さない");
    }
    const damage = world.computeDamage({ initial: exec.initialState, final: exec.state, events: found.events, scenario: exec.scenario });
    return c.json({ execution: executionView(world, exec), damage });
  });

  // web：Web の取得・検索（F-14 のページを読ませる口。世界が handleWeb を持つときだけ。決定論で LLM なし）。
  // 読んだ・見せた事象（fault）を足して保存する。状態も事象もなければ書かない
  admin.post("/executions/:id/web", async (c) => {
    const id = idParam(c, "id");
    const body = await readBody(c, WebBody);
    const key: ExecutionKey = { workspaceId: body.workspaceId, id };
    const current = await deps.store.getExecution(key);
    if (!current) throw notFound("走行");
    const world = requireWorld(deps.worlds, current.world);
    const handleWeb = world.handleWeb;
    if (!handleWeb) throw notFound("この世界の Web");
    const req: WebRequest = body.kind === "fetch" ? { kind: "fetch", url: body.url } : { kind: "search", query: body.query, ...(body.maxResults === undefined ? {} : { maxResults: body.maxResults }) };
    const updatedAt = nowIso();
    const res = await deps.store.updateExecution(key, (exec): ExecutionChange<{ result: unknown; events: unknown[] }> => {
      const out = handleWeb.call(world, exec.state, req);
      if (out.events.length === 0 && world.stateHash(out.state) === world.stateHash(exec.state)) {
        return { kind: "keep", value: { result: out.result, events: [] } };
      }
      return { kind: "write", state: out.state, events: out.events, updatedAt, value: { result: out.result, events: out.events } };
    });
    if (!res) throw notFound("走行");
    return c.json({ execution: executionView(world, res.execution), result: res.value.result, events: res.value.events });
  });

  // スナップショット：デモ店舗の今の状態を写す（FR-066 の「止まったタスクの開始時の状態」。SW §4.7 の6）
  admin.post("/snapshots", async (c) => {
    const body = await readBody(c, SnapshotBody);
    const world = requireWorld(deps.worlds, body.world);
    const demo = await deps.store.getExecution({ workspaceId: body.workspaceId, demoStoreOf: body.world });
    if (!demo) throw notFound("デモ店舗");
    const snap: SimSnapshotRecord = {
      id: deps.newId(),
      workspaceId: body.workspaceId,
      world: body.world,
      executionId: demo.id,
      executionVersion: demo.version,
      seed: demo.seed,
      seedVersion: demo.seedVersion,
      state: demo.state,
      stateHash: world.stateHash(demo.state),
      sourceTaskId: body.sourceTaskId,
      takenAt: nowIso(),
    };
    await deps.store.insertSnapshot(snap);
    return c.json({ snapshot: snapshotView(snap) }, 201);
  });

  // デモ店舗：ワークスペースに1つ（rehearsal_run_id が NULL。15:326・369）。あればそれを返す（冪等：SD-07・SO-SIM-04）
  admin.post("/demo-store", async (c) => {
    const body = await readBody(c, DemoStoreBody);
    const world = requireWorld(deps.worlds, body.world);
    const seedVersion = body.seedVersion ?? world.seedVersion;
    if (seedVersion !== world.seedVersion) {
      throw new SimHttpError(400, "VALIDATION_ERROR", `知らない seedVersion：${seedVersion}（今は ${world.seedVersion}）`);
    }
    const now = deps.now();
    const seed = body.seed ?? hash32(`demo-store:${body.workspaceId}`);
    const startDate = body.startDate ?? jstDateOf(now.getTime());
    const state = asInputError(() => world.createInitialState(seed, { seedVersion, startDate }), "デモ店舗を作れません");
    const at = now.toISOString();
    const r = await deps.store.ensureDemoStore({
      id: deps.newId(),
      workspaceId: body.workspaceId,
      world: body.world,
      rehearsalRunId: null,
      parentExecutionId: null,
      variant: "live",
      seed,
      seedVersion,
      scenario: null,
      snapshotId: null,
      initialState: state,
      state,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
    return c.json({ execution: executionView(world, r.execution), created: r.created }, r.created ? 201 : 200);
  });

  // ワークスペースの削除：sim の行をすべて消す（15:375。ほかのワークスペースの行に触れない）
  admin.delete("/workspaces/:id", async (c) => {
    const workspaceId = idParam(c, "id");
    // 試験が参照しているスナップショットが残っていれば SimStoreInUseError（409。Postgres の保存だけ：DB T-16）
    const counts = await deps.store.deleteWorkspace(workspaceId);
    loggerOf(c, deps.log).info("sim.workspace_deleted", "sim の行を消した", { workspaceId, ...counts });
    return c.body(null, 204);
  });

  return admin;
}
