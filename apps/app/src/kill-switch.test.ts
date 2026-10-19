// Kill Switch（EP-27・28。AS §6.5 の T-100〜T-105、SO §7.9 の SO-KS-01〜12、BR-17）
import { issueSession, verifyAuditChain, type Db } from "@open-team/db";
import {
  fxAgent,
  fxApproval,
  fxConnector,
  fxIntent,
  fxRehearsalCase,
  fxRehearsalRun,
  fxRehearsalScenario,
  fxSimExecution,
  fxTask,
  fxWorkspace,
  useTestDb,
  type FxWorkspace,
} from "@open-team/db/testing";
import { describe, expect, it } from "vitest";
import type { TasksTerminatedEvent } from "./deps.ts";
import { createRunningTaskRegistry, startKillWatch, StopRequested } from "./registry.ts";
import { T0, makeTestApp, send, signInOwner, waitFor, type SignedIn, type TestApp } from "./test-helpers.ts";

const T = useTestDb();

const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const asFx = (a: SignedIn): FxWorkspace => ({
  workspaceId: a.workspaceId,
  userId: a.userId,
  kind: "owner",
  ctx: { workspaceId: a.workspaceId, kind: "owner", userId: a.userId },
});

/** ワークスペースに別の役割の利用者を足し、そのセッション（Cookie・CSRF）を返す */
async function memberSession(db: Db, workspaceId: string, role: "maintainer" | "viewer") {
  const u = await db.query<{ id: string }>("INSERT INTO users (login) VALUES ($1) RETURNING id", [`${role}-${Math.random().toString(36).slice(2, 8)}`]);
  const userId = u.rows[0]!.id;
  await db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)", [workspaceId, userId, role]);
  const s = await issueSession(db, { workspaceId, userId, ipHash: null, userAgent: null, now: T0 });
  return { cookie: s.cookieValue, csrf: s.csrfToken, userId };
}

/** 動いているタスク・承認待ち・実行中の Intent・走っているリハーサルを用意する */
async function seedActivity(db: Db, ws: FxWorkspace) {
  const conn = await fxConnector(db, ws);
  const agent = await fxAgent(db, ws);
  const running = await fxTask(db, ws, agent, { status: "running" });
  const awaiting = await fxTask(db, ws, agent, { status: "awaiting_approval" });
  const queued = await fxTask(db, ws, agent, { status: "queued" });
  const done = await fxTask(db, ws, agent, { status: "succeeded" });
  const pending = await fxIntent(db, ws, { taskId: awaiting.taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "pending_approval" });
  const approval = await fxApproval(db, ws, { taskId: awaiting.taskId, intentId: pending.intentId });
  const approved = await fxIntent(db, ws, { taskId: running.taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "approved" });
  const executing = await fxIntent(db, ws, { taskId: running.taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "executing" });
  const run = await fxRehearsalRun(db, ws, { jobId: agent.jobId, status: "running" });
  const kase = await fxRehearsalCase(db, ws, { jobId: agent.jobId });
  const scenario = await fxRehearsalScenario(db, ws, { runId: run.runId, caseId: kase.caseId });
  const exec = await fxSimExecution(db, ws, { rehearsalRunId: run.runId });
  const rehearsalTask = await fxTask(db, ws, agent, {
    status: "running",
    rehearsalRunId: run.runId,
    rehearsalScenarioId: scenario.scenarioId,
    simExecutionId: exec.executionId,
  });
  return { agent, running, awaiting, queued, done, pending, approval, approved, executing, run, scenario, rehearsalTask };
}

async function engage(t: TestApp, a: { cookie: string; csrf: string }, workspaceId: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return send(t, "POST", `/api/v1/workspaces/${workspaceId}/kill-switch`, { cookie: a.cookie, csrf: a.csrf, body, headers });
}

describe("EP-27 発動", () => {
  it("T-100・SO-KS-01 動いているタスク（リハーサルも）を halted(kill_switch)・トークン失効、承認待ちと未実行の Intent を expired、executing は触らない、走行を cancelled、監査ログ・SSE の事象", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const ws = asFx(a);
    const x = await seedActivity(db, ws);
    await db.query("UPDATE tasks SET task_token_hash = $2, task_token_expires_at = $3 WHERE id = $1", [x.running.taskId, Buffer.alloc(32, 1), T0]);

    const res = await engage(t, a, a.workspaceId, { reason: "様子がおかしい" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { engaged: boolean; engagedAt: string; affectedTaskIds: string[] };
    expect(body.engaged).toBe(true);
    expect(body.engagedAt).toBe(T0.toISOString());
    expect(body.affectedTaskIds).toEqual([x.running.taskId, x.awaiting.taskId, x.queued.taskId, x.rehearsalTask.taskId].sort());

    const tasks = await db.query<{ id: string; status: string; halt_reason: string | null; task_token_hash: Buffer | null; finished_at: Date | null }>(
      "SELECT id, status, halt_reason, task_token_hash, finished_at FROM tasks WHERE workspace_id = $1",
      [a.workspaceId],
    );
    for (const row of tasks.rows) {
      if (row.id === x.done.taskId) {
        expect(row.status).toBe("succeeded");
      } else {
        expect(row).toMatchObject({ status: "halted", halt_reason: "kill_switch", task_token_hash: null, finished_at: T0 });
      }
    }
    const intents = await db.query<{ id: string; status: string; expire_reason: string | null }>(
      "SELECT id, status, expire_reason FROM action_intents WHERE workspace_id = $1",
      [a.workspaceId],
    );
    const byId = new Map(intents.rows.map((r) => [r.id, r]));
    expect(byId.get(x.pending.intentId)).toMatchObject({ status: "expired", expire_reason: "kill_switch" });
    expect(byId.get(x.approved.intentId)).toMatchObject({ status: "expired", expire_reason: "kill_switch" });
    expect(byId.get(x.executing.intentId)).toMatchObject({ status: "executing", expire_reason: null });
    expect((await db.query<{ status: string }>("SELECT status FROM approvals WHERE id = $1", [x.approval.approvalId])).rows[0]?.status).toBe("expired");
    expect((await db.query<{ status: string }>("SELECT status FROM rehearsal_runs WHERE id = $1", [x.run.runId])).rows[0]?.status).toBe("cancelled");
    expect(
      (await db.query<{ status: string; abort_reason: string }>("SELECT status, abort_reason FROM rehearsal_scenarios WHERE id = $1", [x.scenario.scenarioId])).rows[0],
    ).toEqual({ status: "cancelled", abort_reason: "kill_switch" });

    const ws2 = await db.query<{ kill_switch_engaged: boolean; kill_switch_engaged_by: string; kill_switch_reason: string }>(
      "SELECT kill_switch_engaged, kill_switch_engaged_by, kill_switch_reason FROM workspaces WHERE id = $1",
      [a.workspaceId],
    );
    expect(ws2.rows[0]).toEqual({ kill_switch_engaged: true, kill_switch_engaged_by: a.userId, kill_switch_reason: "様子がおかしい" });

    const audit = await db.query<{ event_type: string; actor_type: string; actor_id: string; payload: Record<string, unknown> }>(
      "SELECT event_type, actor_type, actor_id, payload FROM audit_logs WHERE workspace_id = $1 AND event_type = 'killswitch.engaged'",
      [a.workspaceId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_type: "user", actor_id: a.userId });
    expect(audit.rows[0]?.payload).toMatchObject({ reason: "様子がおかしい", affectedTaskIds: body.affectedTaskIds });
    expect((await verifyAuditChain(db, a.workspaceId)).ok).toBe(true);

    const events = await db.query<{ type: string; data: unknown }>("SELECT type, data FROM workspace_events WHERE workspace_id = $1", [a.workspaceId]);
    expect(events.rows).toEqual([{ type: "killswitch", data: { engaged: true, engagedAt: T0.toISOString() } }]);

    const me = (await (await send(t, "GET", "/api/v1/me", { cookie: a.cookie })).json()) as { workspace: { killSwitch: unknown } };
    expect(me.workspace.killSwitch).toEqual({ engaged: true, engagedAt: T0.toISOString(), engagedBy: a.userId, reason: "様子がおかしい" });
  });

  it("T-101・SO-KS-02 発動中にもう一度 → 200 同じ engagedAt、affectedTaskIds は空、監査ログ・事象は増えない", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    await seedActivity(db, asFx(a));
    await engage(t, a, a.workspaceId);
    t.clock.advance(5_000);
    const again = await engage(t, a, a.workspaceId, { reason: "2回目" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ engaged: true, engagedAt: T0.toISOString(), affectedTaskIds: [] });
    expect((await db.query<{ n: number }>("SELECT count(*) AS n FROM audit_logs WHERE event_type = 'killswitch.engaged'")).rows[0]?.n).toBe(1);
    expect((await db.query<{ n: number }>("SELECT count(*) AS n FROM workspace_events")).rows[0]?.n).toBe(1);
  });

  it("理由なし・本文なしでも発動できる（理由は null）", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const res = await send(t, "POST", `/api/v1/workspaces/${a.workspaceId}/kill-switch`, { cookie: a.cookie, csrf: a.csrf });
    expect(res.status).toBe(200);
    const row = await db.query<{ kill_switch_reason: string | null }>("SELECT kill_switch_reason FROM workspaces WHERE id = $1", [a.workspaceId]);
    expect(row.rows[0]?.kill_switch_reason).toBeNull();
  });

  it("T-102 理由 501文字 → 400、500文字 → 200", async () => {
    const t = makeTestApp(T().db);
    const a = await signInOwner(t);
    expect((await engage(t, a, a.workspaceId, { reason: "あ".repeat(501) })).status).toBe(400);
    expect((await engage(t, a, a.workspaceId, { reason: "あ".repeat(500) })).status).toBe(200);
  });

  it("知らないキー → 400、別のワークスペースの ID → 404、CSRF なし → 403", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    expect((await engage(t, a, a.workspaceId, { reason: "x", shadow: true })).status).toBe(400);
    const other = await fxWorkspace(db, { kind: "guest" });
    expect((await engage(t, a, other.workspaceId)).status).toBe(404);
    const noCsrf = await send(t, "POST", `/api/v1/workspaces/${a.workspaceId}/kill-switch`, { cookie: a.cookie, body: {} });
    expect(noCsrf.status).toBe(403);
    expect((await db.query<{ e: boolean }>("SELECT kill_switch_engaged AS e FROM workspaces WHERE id = $1", [other.workspaceId])).rows[0]?.e).toBe(false);
  });

  it("SO-KS-03 viewer は発動できない（403）、maintainer はできる", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const viewer = await memberSession(db, a.workspaceId, "viewer");
    const v = await engage(t, viewer, a.workspaceId);
    expect(v.status).toBe(403);
    expect(await errCode(v)).toBe("FORBIDDEN");
    const maintainer = await memberSession(db, a.workspaceId, "maintainer");
    expect((await engage(t, maintainer, a.workspaceId)).status).toBe(200);
  });

  it("SO-KS-11 ワークスペース A の発動で B の Kill Switch・タスク・承認は変わらない", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const b = await fxWorkspace(db, { kind: "guest" });
    const bx = await seedActivity(db, b);
    await engage(t, a, a.workspaceId);
    expect((await db.query<{ e: boolean }>("SELECT kill_switch_engaged AS e FROM workspaces WHERE id = $1", [b.workspaceId])).rows[0]?.e).toBe(false);
    expect((await db.query<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [bx.running.taskId])).rows[0]?.status).toBe("running");
    expect((await db.query<{ status: string }>("SELECT status FROM approvals WHERE id = $1", [bx.approval.approvalId])).rows[0]?.status).toBe("pending");
  });

  it("止めたタスクを hooks.tasksTerminated に同じトランザクションで渡す（BR-80・順番の進め方の入口）。止める前の状態つき", async () => {
    const { db } = T();
    const seen: TasksTerminatedEvent[] = [];
    const t = makeTestApp(db, {
      deps: {
        hooks: {
          tasksTerminated: [
            async (tx, ctx, e) => {
              seen.push(e);
              // 同じトランザクションの中で、止めたあとの状態が見える
              const r = await tx.query<{ n: number }>("SELECT count(*) AS n FROM tasks WHERE workspace_id = $1 AND status = 'halted'", [ctx.workspaceId]);
              expect(r.rows[0]?.n).toBe(e.tasks.length);
            },
          ],
        },
      },
    });
    const a = await signInOwner(t);
    const x = await seedActivity(db, asFx(a));
    await engage(t, a, a.workspaceId);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cause).toBe("kill_switch");
    const running = seen[0]?.tasks.find((h) => h.id === x.running.taskId);
    expect(running).toMatchObject({ previousStatus: "running", rehearsalRunId: null, jobId: x.agent.jobId, shadow: false });
    const rehearsal = seen[0]?.tasks.find((h) => h.id === x.rehearsalTask.taskId);
    expect(rehearsal?.rehearsalRunId).toBe(x.run.runId);
  });

  it("hook が失敗したら発動ごと戻る（タスクも Kill Switch もそのまま）", async () => {
    const { db } = T();
    const t = makeTestApp(db, {
      deps: {
        hooks: {
          tasksTerminated: [
            async () => {
              throw new Error("hook failed");
            },
          ],
        },
      },
    });
    const a = await signInOwner(t);
    const x = await seedActivity(db, asFx(a));
    expect((await engage(t, a, a.workspaceId)).status).toBe(500);
    expect((await db.query<{ e: boolean }>("SELECT kill_switch_engaged AS e FROM workspaces WHERE id = $1", [a.workspaceId])).rows[0]?.e).toBe(false);
    expect((await db.query<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [x.running.taskId])).rows[0]?.status).toBe("running");
  });

  it("Idempotency-Key：同じキーの2回目は1回目の応答をそのまま（affectedTaskIds も）、違う本文に使うと 400、形が違うと 400", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const x = await seedActivity(db, asFx(a));
    const key = "0b7b8c1e-2f2d-4b8a-9d0e-0a1b2c3d4e5f";
    const first = await engage(t, a, a.workspaceId, { reason: "r" }, { "idempotency-key": key });
    const firstBody = await first.json();
    const second = await engage(t, a, a.workspaceId, { reason: "r" }, { "idempotency-key": key });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    expect((firstBody as { affectedTaskIds: string[] }).affectedTaskIds).toContain(x.running.taskId);
    expect((await engage(t, a, a.workspaceId, { reason: "別" }, { "idempotency-key": key })).status).toBe(400);
    expect((await engage(t, a, a.workspaceId, { reason: "r" }, { "idempotency-key": "not-a-uuid" })).status).toBe(400);
    // キーなしは今の状態（発動中）を返す
    expect(((await (await engage(t, a, a.workspaceId)).json()) as { affectedTaskIds: string[] }).affectedTaskIds).toEqual([]);
  });

  it("同じキーで同時に2本送っても発動は1回（監査ログ1件）で、両方が同じ応答", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    await seedActivity(db, asFx(a));
    const key = "1b7b8c1e-2f2d-4b8a-9d0e-0a1b2c3d4e5f";
    const [r1, r2] = await Promise.all([
      engage(t, a, a.workspaceId, {}, { "idempotency-key": key }),
      engage(t, a, a.workspaceId, {}, { "idempotency-key": key }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await r1.json()).toEqual(await r2.json());
    expect((await db.query<{ n: number }>("SELECT count(*) AS n FROM audit_logs WHERE event_type = 'killswitch.engaged'")).rows[0]?.n).toBe(1);
  });
});

describe("EP-28 解除", () => {
  it("T-103・SO-KS-10 理由 '' ／ 501文字 → 400、1文字 → 200（タスクは再開しない）、監査ログ killswitch.released・事象", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const x = await seedActivity(db, asFx(a));
    await engage(t, a, a.workspaceId);
    const rel = (body: unknown) => send(t, "POST", `/api/v1/workspaces/${a.workspaceId}/kill-switch/release`, { cookie: a.cookie, csrf: a.csrf, body });
    expect((await rel({ reason: "" })).status).toBe(400);
    expect((await rel({ reason: "   " })).status).toBe(400);
    expect((await rel({ reason: "あ".repeat(501) })).status).toBe(400);
    expect((await rel({})).status).toBe(400);
    const ok = await rel({ reason: "直" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ engaged: false });
    expect((await db.query<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [x.running.taskId])).rows[0]?.status).toBe("halted");
    const ws = await db.query("SELECT kill_switch_engaged, kill_switch_engaged_at, kill_switch_engaged_by, kill_switch_reason FROM workspaces WHERE id = $1", [a.workspaceId]);
    expect(ws.rows[0]).toEqual({ kill_switch_engaged: false, kill_switch_engaged_at: null, kill_switch_engaged_by: null, kill_switch_reason: null });
    const logs = await db.query<{ event_type: string; payload: unknown }>("SELECT event_type, payload FROM audit_logs WHERE workspace_id = $1 AND event_type LIKE 'killswitch.%' ORDER BY seq", [a.workspaceId]);
    expect(logs.rows.map((r) => r.event_type)).toEqual(["killswitch.engaged", "killswitch.released"]);
    expect(logs.rows[1]?.payload).toEqual({ reason: "直" });
    const events = await db.query<{ data: unknown }>("SELECT data FROM workspace_events WHERE workspace_id = $1 ORDER BY id", [a.workspaceId]);
    expect(events.rows.map((r) => r.data)).toEqual([{ engaged: true, engagedAt: T0.toISOString() }, { engaged: false, engagedAt: null }]);
  });

  it("発動中でなければ 200 { engaged: false }（冪等。監査ログは増えない）", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const res = await send(t, "POST", `/api/v1/workspaces/${a.workspaceId}/kill-switch/release`, { cookie: a.cookie, csrf: a.csrf, body: { reason: "x" } });
    expect(res.status).toBe(200);
    expect((await db.query<{ n: number }>("SELECT count(*) AS n FROM audit_logs WHERE event_type = 'killswitch.released'")).rows[0]?.n).toBe(0);
  });

  it("T-103・SO-KS-03 maintainer は解除できない（403。BR-17：解除は owner だけ）", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    await engage(t, a, a.workspaceId);
    const m = await memberSession(db, a.workspaceId, "maintainer");
    const res = await send(t, "POST", `/api/v1/workspaces/${a.workspaceId}/kill-switch/release`, { cookie: m.cookie, csrf: m.csrf, body: { reason: "x" } });
    expect(res.status).toBe(403);
  });
});

describe("止まり方（登録簿・LISTEN/NOTIFY・見回り。SO §3.15、T-105、SO-KS-07・08）", () => {
  it("発動したインスタンスの登録簿はコミットの直後に中断される（理由は StopRequested kill_switch）", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const ac = new AbortController();
    t.deps.registry.register("task-1", a.workspaceId, ac);
    const other = new AbortController();
    t.deps.registry.register("task-2", "00000000-0000-4000-8000-000000000001", other);
    await engage(t, a, a.workspaceId);
    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason).toBeInstanceOf(StopRequested);
    expect((ac.signal.reason as StopRequested).stopCause).toBe("kill_switch");
    expect(other.signal.aborted).toBe(false);
  });

  it("ほかのインスタンス（別の登録簿）は LISTEN ot_kill_switch の通知で止まる", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const otherInstance = createRunningTaskRegistry();
    const watch = await startKillWatch({ db, registry: otherInstance, log: t.deps.log, pollMs: 60_000 });
    try {
      const ac = new AbortController();
      otherInstance.register("task-x", a.workspaceId, ac);
      const started = Date.now();
      await engage(t, a, a.workspaceId);
      await waitFor(() => ac.signal.aborted, 5_000);
      // NFR-012 の p95 10秒（通知なら1秒もかからない）
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await watch.stop();
    }
  });

  it("SO-KS-08 通知がなくても見回りで止まる（Kill Switch を DB で直接立てる）。終了状態のタスクも止める", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const ws = asFx(a);
    const agent = await fxAgent(db, ws);
    const finished = await fxTask(db, ws, agent, { status: "cancelled" });
    const registry = createRunningTaskRegistry();
    const watch = await startKillWatch({ db, registry, log: t.deps.log, pollMs: 60_000, listen: false });
    try {
      const done = new AbortController();
      registry.register(finished.taskId, a.workspaceId, done);
      await watch.pollNow();
      expect(done.signal.aborted).toBe(true);
      expect((done.signal.reason as StopRequested).stopCause).toBe("task_terminated");

      const live = new AbortController();
      registry.register("generate-1", a.workspaceId, live, "ask_generate");
      await watch.pollNow();
      expect(live.signal.aborted).toBe(false);
      await db.query("UPDATE workspaces SET kill_switch_engaged = true, kill_switch_engaged_at = $2 WHERE id = $1", [a.workspaceId, T0]);
      await watch.pollNow();
      expect(live.signal.aborted).toBe(true);
      expect((live.signal.reason as StopRequested).stopCause).toBe("kill_switch");
    } finally {
      await watch.stop();
    }
  });

  it("見回りは間隔ごとに自分で動く（既定2秒。試験は50ms）", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const registry = createRunningTaskRegistry();
    const watch = await startKillWatch({ db, registry, log: t.deps.log, pollMs: 50, listen: false });
    try {
      const ac = new AbortController();
      registry.register("task-y", a.workspaceId, ac);
      await db.query("UPDATE workspaces SET kill_switch_engaged = true, kill_switch_engaged_at = $2 WHERE id = $1", [a.workspaceId, T0]);
      await waitFor(() => ac.signal.aborted, 3_000);
    } finally {
      await watch.stop();
    }
  });

  it("T-104・SO-KS-12 発動中の状態は /me と EP-26 に出る（発動中の依頼・リハーサルの 423 は各 API の担当が Kill Switch を見て返す）", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    await engage(t, a, a.workspaceId, { reason: "止める" });
    const view = (await (await send(t, "GET", `/api/v1/workspaces/${a.workspaceId}`, { cookie: a.cookie })).json()) as { killSwitch: { engaged: boolean } };
    expect(view.killSwitch.engaged).toBe(true);
  });
});
