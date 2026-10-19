// リハーサルの試験・自分の言葉の入力の問い合わせ（repo/rehearsal.ts）の試験。権限は ot_app のロールでつないで流す（本番の app と同じ権限）
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../client.ts";
import { fxAgent, fxRehearsalRun, fxSimExecution, fxSimSnapshot, fxTask, fxWorkspace, openRoleDb, useTestDb } from "../testing.ts";
import {
  applyCaseMerges,
  finishUserInput,
  insertRehearsalCase,
  insertUserInput,
  issueCertificate,
  revokeJobCertificate,
  listActiveRehearsalCases,
  listUserInputCreatedAts,
} from "./rehearsal.ts";

const T = useTestDb();
const NOW = new Date("2026-10-14T01:00:00.000Z");
const roleDbs: Db[] = [];
afterEach(async () => {
  for (const d of roleDbs.splice(0)) await d.close();
});
async function asApp(url: string): Promise<Db> {
  const d = await openRoleDb(url, "ot_app");
  roleDbs.push(d);
  return d;
}
const scenario = { schemaVersion: 1, world: "shop", seed: 5, faults: [{ id: "F-04" }] };

async function setup() {
  const { db, url } = T();
  const ws = await fxWorkspace(db, { kind: "guest" });
  const agent = await fxAgent(db, ws);
  const app = await asApp(url);
  return { db, app, ws, agent };
}

describe("insertRehearsalCase・listActiveRehearsalCases", () => {
  it("generated・user を足せる（ot_app の権限で通る）。対象は仕事か依頼のちょうど片方。ほかのワークスペースの試験は見えない", async () => {
    const { app, ws, agent } = await setup();
    const g = await insertRehearsalCase(app, ws.ctx, { subject: { jobId: agent.jobId }, source: "generated", faultIds: ["F-04"], scenario, seed: 5 });
    expect(g).toMatchObject({ source: "generated", fault_ids: ["F-04"], seed: 5, user_text: null, created_by: ws.userId, job_id: agent.jobId });
    expect(g.scenario).toMatchObject({ world: "shop" });
    const u = await insertRehearsalCase(app, ws.ctx, { subject: { jobId: agent.jobId }, source: "user", faultIds: ["F-02", "F-05"], scenario, seed: 6, userText: "店長の名前で至急" });
    expect(u).toMatchObject({ source: "user", user_text: "店長の名前で至急" });
    expect((await listActiveRehearsalCases(app, ws.ctx, { jobId: agent.jobId })).map((r) => r.id)).toEqual([g.id, u.id]);

    await expect(insertRehearsalCase(app, ws.ctx, { subject: {} as never, source: "generated", faultIds: ["F-04"], scenario, seed: 1 })).rejects.toThrow(TypeError);
    // DB の CHECK が最後の守り：障害 ID なし・source = user で user_text なし
    await expect(insertRehearsalCase(app, ws.ctx, { subject: { jobId: agent.jobId }, source: "generated", faultIds: [], scenario, seed: 1 })).rejects.toThrow();
    await expect(insertRehearsalCase(app, ws.ctx, { subject: { jobId: agent.jobId }, source: "user", faultIds: ["F-04"], scenario, seed: 1 })).rejects.toThrow();

    const other = await fxWorkspace(T().db, { kind: "guest" });
    expect(await listActiveRehearsalCases(app, other.ctx, { jobId: agent.jobId })).toEqual([]);
  });

  it("外された試験は一覧に出ない", async () => {
    const { app, ws, agent } = await setup();
    const g = await insertRehearsalCase(app, ws.ctx, { subject: { jobId: agent.jobId }, source: "generated", faultIds: ["F-04"], scenario, seed: 5 });
    await app.query("UPDATE rehearsal_cases SET removed_at = now(), removed_reason = 'user' WHERE id = $1", [g.id]);
    expect(await listActiveRehearsalCases(app, ws.ctx, { jobId: agent.jobId })).toEqual([]);
  });
});

describe("applyCaseMerges", () => {
  it("古い incident を新しいほうへまとめ（removed_reason = merged）、stopped_writes を残す1件に足す。外されていない incident だけが対象", async () => {
    const { db, app, ws, agent } = await setup();
    const live = await fxSimExecution(db, ws);
    const { taskId } = await fxTask(db, ws, agent);
    const snap = await fxSimSnapshot(db, ws, { executionId: live.executionId, sourceTaskId: taskId });
    const mk = async (n: number) => {
      const r = await db.query<{ id: string }>(
        `INSERT INTO rehearsal_cases (workspace_id, job_id, source, fault_ids, scenario, seed, sim_snapshot_id, source_task_id, reason_code, incident_kind, stopped_writes)
         VALUES ($1, $2, 'incident', '{}', $3, 1, $4, $5, 'guard_exceeded', 'kernel_approve', $6::jsonb) RETURNING id`,
        [ws.workspaceId, agent.jobId, scenario, snap.snapshotId, taskId, [{ n }]],
      );
      return r.rows[0]!.id;
    };
    const [a, b, c] = [await mk(1), await mk(2), await mk(3)];
    const gen = await insertRehearsalCase(db, ws.ctx, { subject: { jobId: agent.jobId }, source: "generated", faultIds: ["F-04"], scenario, seed: 5 });

    const removed = await app.transaction((tx) =>
      applyCaseMerges(tx, ws.ctx, [{ keepId: c, mergedIds: [a, b] }, { keepId: c, mergedIds: [gen.id] }], NOW),
    );
    // generated はまとめない
    expect(removed.sort()).toEqual([a, b].sort());
    const rows = await db.query<{ id: string; removed_reason: string | null; stopped_writes: unknown }>(
      "SELECT id, removed_reason, stopped_writes FROM rehearsal_cases WHERE job_id = $1",
      [agent.jobId],
    );
    const by = new Map(rows.rows.map((r) => [r.id, r]));
    expect(by.get(a)!.removed_reason).toBe("merged");
    expect(by.get(b)!.removed_reason).toBe("merged");
    expect(by.get(c)!.removed_reason).toBeNull();
    expect(by.get(gen.id)!.removed_reason).toBeNull();
    // 残す試験は元の1件＋まとめた2件の stopped_writes を持つ（古い順）
    expect(by.get(c)!.stopped_writes).toEqual([{ n: 3 }, { n: 1 }, { n: 2 }]);
    // もう一度流しても増えない（外されたものは対象外）
    expect(await app.transaction((tx) => applyCaseMerges(tx, ws.ctx, [{ keepId: c, mergedIds: [a, b] }], NOW))).toEqual([]);
    expect((await db.query<{ stopped_writes: unknown[] }>("SELECT stopped_writes FROM rehearsal_cases WHERE id = $1", [c])).rows[0]!.stopped_writes).toHaveLength(3);
  });
});

describe("rehearsal_user_inputs", () => {
  it("insertUserInput は interpreting で作り、finishUserInput は interpreting のものだけ更新する。作成時刻の一覧は since で絞れる", async () => {
    const { app, ws, agent } = await setup();
    const input = await insertUserInput(app, ws.ctx, { subject: { jobId: agent.jobId }, text: "仕入れ先が倒産した" });
    expect(input).toMatchObject({ status: "interpreting", text: "仕入れ先が倒産した", created_by: ws.userId, case_id: null });
    const done = await finishUserInput(app, ws.ctx, input.id, {
      status: "no_match",
      interpretation: { message: "カタログにない障害です" },
      nearestFaultId: "F-06",
      caseId: null,
    });
    expect(done).toMatchObject({ status: "no_match", nearest_fault_id: "F-06", interpretation: { message: "カタログにない障害です" } });
    // 2回目は更新しない
    expect(await finishUserInput(app, ws.ctx, input.id, { status: "failed", interpretation: null, nearestFaultId: null, caseId: null })).toBeNull();
    expect((await listUserInputCreatedAts(app, ws.ctx)).length).toBe(1);
    expect(await listUserInputCreatedAts(app, ws.ctx, new Date(Date.now() + 60_000))).toEqual([]);
    // ほかのワークスペースの行は更新できない・数えない
    const other = await fxWorkspace(T().db, { kind: "guest" });
    expect(await listUserInputCreatedAts(app, other.ctx)).toEqual([]);
    const input2 = await insertUserInput(app, ws.ctx, { subject: { jobId: agent.jobId }, text: "x" });
    expect(await finishUserInput(app, other.ctx, input2.id, { status: "failed", interpretation: null, nearestFaultId: null, caseId: null })).toBeNull();
  });
});

describe("issueCertificate・revokeJobCertificate", () => {
  const H = (c: string) => c.repeat(64);
  it("発行すると有効な合格証は1つ。再発行で前のものは superseded。切ると監査ログが残る", async () => {
    const { app, ws, agent } = await setup();
    const run1 = await fxRehearsalRun(app, ws, { jobId: agent.jobId, status: "done" });
    const run2 = await fxRehearsalRun(app, ws, { jobId: agent.jobId, status: "done" });
    const base = { jobId: agent.jobId, policyHash: H("a"), toolHashes: [], modelId: "m", caseSetHash: H("b"), caseCount: 3, summary: {}, costUsd: "0.100000", now: NOW };
    const c1 = await app.transaction((tx) => issueCertificate(tx, ws.ctx, { ...base, runId: run1.runId, certificateHash: H("c") }));
    expect(c1.revoked_at).toBeNull();
    const c2 = await app.transaction((tx) => issueCertificate(tx, ws.ctx, { ...base, runId: run2.runId, certificateHash: H("d") }));
    const rows = await app.query<{ id: string; revoke_reason: string | null }>("SELECT id, revoke_reason FROM rehearsal_certificates WHERE job_id = $1 ORDER BY issued_at, id", [agent.jobId]);
    expect(rows.rows.find((r) => r.id === c1.id)?.revoke_reason).toBe("superseded");
    expect(rows.rows.find((r) => r.id === c2.id)?.revoke_reason).toBeNull();
    const revoked = await app.transaction((tx) => revokeJobCertificate(tx, ws.ctx, agent.jobId, "widen", NOW));
    expect(revoked).toMatchObject({ id: c2.id, revoke_reason: "widen" });
    expect(await app.transaction((tx) => revokeJobCertificate(tx, ws.ctx, agent.jobId, "widen", NOW))).toBeNull();
  });
});
