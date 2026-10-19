// 本番の停止を試験にするフック（incident-hook.ts）と、試験の一覧・外す API の試験
import { issueSession } from "@open-team/db";
import { fxAgent, fxConnector, fxIntent, fxRehearsalCase, fxRehearsalRun, fxRehearsalScenario, fxSimExecution, fxSimSnapshot, fxTask, fxWorkspace, useTestDb } from "@open-team/db/testing";
import { ScenarioSchema } from "@open-team/sim-core";
import { describe, expect, it } from "vitest";
import { makeTestApp, send } from "../test-helpers.ts";
import { incidentOnTasksTerminated, recordIncident } from "./incident-hook.ts";

const T = useTestDb();
const NOW = new Date("2026-10-14T01:00:00.000Z");

async function setup() {
  const { db } = T();
  const ws = await fxWorkspace(db, { kind: "owner" });
  const agent = await fxAgent(db, ws);
  const connector = await fxConnector(db, ws);
  // デモ店舗の走行はワークスペースに1つ（sim_executions_demo_store_uq）
  const live = await fxSimExecution(db, ws);
  return { db, ws, agent, connectorId: connector.connectorId, executionId: live.executionId };
}

/** 本番のタスク（開始時のスナップショットつき）と、止まった Intent */
async function stoppedTask(
  s: Awaited<ReturnType<typeof setup>>,
  o: { reasonCode?: string; detail?: unknown; taskOpts?: Parameters<typeof fxTask>[3]; noSnapshot?: boolean } = {},
) {
  const { db, ws, agent } = s;
  const { taskId } = await fxTask(db, ws, agent, o.taskOpts);
  const snap = await fxSimSnapshot(db, ws, { executionId: s.executionId, sourceTaskId: taskId });
  if (!o.noSnapshot) await db.query("UPDATE tasks SET sim_snapshot_id = $2 WHERE id = $1", [taskId, snap.snapshotId]);
  const { intentId } = await fxIntent(db, ws, { taskId, jobId: agent.jobId, connectorId: s.connectorId });
  if (o.reasonCode !== undefined) {
    await db.query("UPDATE action_intents SET reason_code = $2, decision_detail = $3::jsonb WHERE id = $1", [intentId, o.reasonCode, o.detail ?? null]);
  }
  return { taskId, intentId, snapshotId: snap.snapshotId };
}

const record = (s: Awaited<ReturnType<typeof setup>>, t: { taskId: string; intentId: string | null }, kind: "kernel_approve" | "kernel_deny" | "user_reject" | "kill_switch" = "kernel_approve") =>
  s.db.transaction((tx) => recordIncident(tx, s.ws.ctx, { taskId: t.taskId, kind, intentId: t.intentId }, NOW));

describe("recordIncident（FR-066・D-81）", () => {
  it("ガードで approve になった実行を incident にする：開始時のスナップショット・シード・F-04・止まった書き込み・監査ログ", async () => {
    const s = await setup();
    const t = await stoppedTask(s, {
      reasonCode: "guard_exceeded",
      detail: { kind: "guard", argPath: "items[0].quantity", value: 20, found: true, guard: {} },
    });
    const r = await record(s, t);
    expect(r.recorded).toBe(true);
    if (!r.recorded) return;
    expect(r.row).toMatchObject({
      source: "incident",
      job_id: s.agent.jobId,
      sim_snapshot_id: t.snapshotId,
      source_task_id: t.taskId,
      reason_code: "guard_exceeded",
      incident_kind: "kernel_approve",
      fault_ids: ["F-04"],
      seed: 7,
    });
    expect(r.row.stopped_writes).toEqual([
      expect.objectContaining({ intentId: t.intentId, sourceTaskId: t.taskId, jobId: s.agent.jobId, action: "mcp.supplier.place_order", stoppedBy: "kernel_approve", reasonCode: "guard_exceeded" }),
    ]);
    const scenario = ScenarioSchema.parse(r.row.scenario);
    expect(scenario.origin).toEqual({ source: "incident", sourceTaskId: t.taskId });
    expect(scenario.faults).toEqual([expect.objectContaining({ id: "F-04", sku: "BEAN-01", variant: "case_vs_unit" })]);
    const audit = await s.db.query<{ event_type: string }>("SELECT event_type FROM audit_logs WHERE workspace_id = $1 AND event_type = 'rehearsal.case_added'", [s.ws.workspaceId]);
    expect(audit.rowCount).toBe(1);
  });

  it("確認の却下・deny も足す。unknown_outcome_pending は F-01、汚染ありは F-02（文面はスナップショットのもの）", async () => {
    const s = await setup();
    const a = await record(s, await stoppedTask(s, { reasonCode: "unknown_outcome_pending" }), "kernel_deny");
    const b = await record(s, await stoppedTask(s), "user_reject");
    expect(a.recorded && a.row.fault_ids).toEqual(["F-01"]);
    expect(a.recorded && a.row.incident_kind).toBe("kernel_deny");
    expect(b.recorded && b.row).toMatchObject({ incident_kind: "user_reject", reason_code: "approval_required", fault_ids: [] });
    // 題は平易な日本語（理由のコードは reason_code にだけ残す）
    expect(b.recorded && (b.row.scenario as { title?: string }).title).toBe("本番で止まった：確認で却下した（人の確認が必要）");
    const tainted = await stoppedTask(s, { taskOpts: { tainted: true } });
    await s.db.query("UPDATE action_intents SET taint_snapshot = $2::jsonb WHERE id = $1", [tainted.intentId, { tainted: true, sources: [] }]);
    const c = await record(s, tainted);
    expect(c.recorded && c.row.fault_ids).toEqual(["F-02"]);
  });

  it("同じ停止を2回呼んでも1件だけ。ユーザーが外した試験も戻さない", async () => {
    const s = await setup();
    const t = await stoppedTask(s);
    expect((await record(s, t)).recorded).toBe(true);
    expect(await record(s, t)).toEqual({ recorded: false, reason: "duplicate" });
    await s.db.query("UPDATE rehearsal_cases SET removed_at = now(), removed_reason = 'user'");
    expect(await record(s, t)).toEqual({ recorded: false, reason: "duplicate" });
  });

  it("リハーサルの実行（dry_run）のタスクと、スナップショットのないタスクでは足さない", async () => {
    const s = await setup();
    const { runId } = await fxRehearsalRun(s.db, s.ws, { jobId: s.agent.jobId });
    const { caseId } = await fxRehearsalCase(s.db, s.ws, { jobId: s.agent.jobId });
    const { scenarioId } = await fxRehearsalScenario(s.db, s.ws, { runId, caseId });
    const dry = await stoppedTask(s, { taskOpts: { rehearsalRunId: runId, rehearsalScenarioId: scenarioId, shadow: true }, noSnapshot: true });
    expect(await record(s, dry)).toEqual({ recorded: false, reason: "dry_run" });
    expect(await record(s, await stoppedTask(s, { noSnapshot: true }))).toEqual({ recorded: false, reason: "no_snapshot" });
    expect((await s.db.query("SELECT 1 FROM rehearsal_cases WHERE source = 'incident'")).rowCount).toBe(0);
  });

  it("仕事の合格証を切る（case_added）。20件を超えるなら同じ reasonCode の古い incident をまとめる", async () => {
    const s = await setup();
    const first = await record(s, await stoppedTask(s, { reasonCode: "guard_exceeded", detail: { kind: "guard", argPath: "items[0].quantity", value: 20, found: true, guard: {} } }));
    expect(first.recorded && first.mergedIds).toEqual([]);
    // 20件に満たない間はまとめない。19件の generated を足して21件目でまとめる
    for (let i = 0; i < 18; i++) {
      await s.db.query(
        `INSERT INTO rehearsal_cases (workspace_id, job_id, source, fault_ids, scenario, seed) VALUES ($1, $2, 'generated', '{F-05}', '{}'::jsonb, $3)`,
        [s.ws.workspaceId, s.agent.jobId, i],
      );
    }
    const mk = () => stoppedTask(s, { reasonCode: "guard_exceeded", detail: { kind: "guard", argPath: "items[0].quantity", value: 20, found: true, guard: {} } });
    expect((await record(s, await mk())).recorded).toBe(true); // 20件
    const over = await record(s, await mk()); // 21件目：古い incident をまとめる
    expect(over.recorded && over.mergedIds).toHaveLength(1);
    const active = await s.db.query("SELECT 1 FROM rehearsal_cases WHERE job_id = $1 AND removed_at IS NULL", [s.agent.jobId]);
    expect(active.rowCount).toBe(20);
  });
});

describe("incidentOnTasksTerminated（Kill Switch）", () => {
  it("本番のタスクだけ incident（kill_switch）にし、期限切れにした書き込みを止まった書き込みに入れる", async () => {
    const s = await setup();
    const t = await stoppedTask(s);
    await s.db.query("UPDATE action_intents SET status = 'expired', expire_reason = 'kill_switch' WHERE id = $1", [t.intentId]);
    const shadowTask = await stoppedTask(s);
    await s.db.transaction((tx) =>
      incidentOnTasksTerminated(tx, s.ws.ctx, {
        cause: "kill_switch",
        now: NOW,
        tasks: [t, shadowTask].map((x, i) => ({
          id: x.taskId, jobId: s.agent.jobId, agentId: s.agent.agentId, askId: null, askRunId: null, rehearsalRunId: null, shadow: i === 1, previousStatus: "running" as const,
        })),
      }),
    );
    const rows = await s.db.query<{ incident_kind: string; reason_code: string; fault_ids: string[]; stopped_writes: Array<{ intentId: string }> }>(
      "SELECT incident_kind, reason_code, fault_ids, stopped_writes FROM rehearsal_cases WHERE workspace_id = $1",
      [s.ws.workspaceId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ incident_kind: "kill_switch", fault_ids: [] });
    expect(rows.rows[0]!.stopped_writes.map((w) => w.intentId)).toEqual([t.intentId]);
  });
});

describe("incidentOnTasksTerminated の隔離", () => {
  it("試験の保存が例外を投げても Kill Switch の書き込み（同じトランザクションの書き込み）は巻き戻らない", async () => {
    const s = await setup();
    const t = await stoppedTask(s);
    await s.db.query("UPDATE action_intents SET status = 'expired', expire_reason = 'kill_switch' WHERE id = $1", [t.intentId]);
    await s.db.transaction(async (tx) => {
      await tx.query("UPDATE tasks SET status_detail = 'ks_marker' WHERE id = $1", [t.taskId]);
      await tx.query("CREATE FUNCTION pg_temp.boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$");
      await tx.query("CREATE TRIGGER boom_t BEFORE INSERT ON rehearsal_cases FOR EACH ROW EXECUTE FUNCTION pg_temp.boom()");
      await incidentOnTasksTerminated(tx, s.ws.ctx, {
        cause: "kill_switch",
        now: NOW,
        tasks: [{ id: t.taskId, jobId: s.agent.jobId, agentId: s.agent.agentId, askId: null, askRunId: null, rehearsalRunId: null, shadow: false, previousStatus: "running" as const }],
      });
      await tx.query("DROP TRIGGER boom_t ON rehearsal_cases");
    });
    const row = await s.db.query<{ status_detail: string }>("SELECT status_detail FROM tasks WHERE id = $1", [t.taskId]);
    expect(row.rows[0]!.status_detail).toBe("ks_marker");
    const cases = await s.db.query("SELECT 1 FROM rehearsal_cases WHERE workspace_id = $1", [s.ws.workspaceId]);
    expect(cases.rowCount).toBe(0);
  });
});

describe("試験の一覧と外す API", () => {
  async function app(s: Awaited<ReturnType<typeof setup>>, role: "owner" | "viewer" = "owner") {
    const t = makeTestApp(s.db, {});
    const issued = await issueSession(s.db, { workspaceId: s.ws.workspaceId, userId: s.ws.userId, ipHash: null, userAgent: null, now: NOW });
    if (role === "viewer") await s.db.query("UPDATE memberships SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2", [s.ws.workspaceId, s.ws.userId]);
    return { t, cookie: issued.cookieValue, csrf: issued.csrfToken, base: `/api/v1/workspaces/${s.ws.workspaceId}/rehearsal-cases` };
  }

  it("一覧は対象の試験を返し、外すと監査ログ rehearsal.case_removed が残る。外したものは既定の一覧から消え、2回目は 404", async () => {
    const s = await setup();
    const r = await record(s, await stoppedTask(s));
    if (!r.recorded) throw new Error("足せなかった");
    const a = await app(s);
    const list = await send(a.t, "GET", `${a.base}?jobId=${s.agent.jobId}`, { cookie: a.cookie });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: Array<{ id: string; source: string; stoppedWriteCount: number }> }).items).toEqual([
      expect.objectContaining({ id: r.row.id, source: "incident", stoppedWriteCount: 1 }),
    ]);

    const del = await send(a.t, "DELETE", `${a.base}/${r.row.id}`, { cookie: a.cookie, csrf: a.csrf });
    expect(del.status).toBe(200);
    const audit = await s.db.query<{ actor_id: string; payload: { caseId: string } }>(
      "SELECT actor_id, payload FROM audit_logs WHERE workspace_id = $1 AND event_type = 'rehearsal.case_removed'",
      [s.ws.workspaceId],
    );
    expect(audit.rows).toEqual([{ actor_id: s.ws.userId, payload: expect.objectContaining({ caseId: r.row.id, source: "incident" }) }]);
    const after = await send(a.t, "GET", `${a.base}?jobId=${s.agent.jobId}`, { cookie: a.cookie });
    expect(((await after.json()) as { items: unknown[] }).items).toEqual([]);
    const withRemoved = await send(a.t, "GET", `${a.base}?jobId=${s.agent.jobId}&includeRemoved=true`, { cookie: a.cookie });
    expect(((await withRemoved.json()) as { items: Array<{ removedReason: string }> }).items[0]).toMatchObject({ removedReason: "user" });
    expect((await send(a.t, "DELETE", `${a.base}/${r.row.id}`, { cookie: a.cookie, csrf: a.csrf })).status).toBe(404);
  });

  it("viewer は外せない（403）。jobId も askId も無ければ 400", async () => {
    const s = await setup();
    const r = await record(s, await stoppedTask(s));
    if (!r.recorded) throw new Error("足せなかった");
    const a = await app(s, "viewer");
    expect((await send(a.t, "DELETE", `${a.base}/${r.row.id}`, { cookie: a.cookie, csrf: a.csrf })).status).toBe(403);
    expect((await send(a.t, "GET", a.base, { cookie: a.cookie })).status).toBe(400);
  });
});

