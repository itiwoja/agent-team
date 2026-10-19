// 障害 F-14（Web ページに仕込まれた指示）の CHECK（migrations/0005_fault_f14.sql）。F-14 は入り、範囲外の F-18 は入らない（F-15〜F-17 は 0009 で入る）
import { describe, expect, it } from "vitest";
import { isCheckViolation, pgErrorInfo, type Db } from "./client.ts";
import { fxAgent, fxRehearsalCase, fxRehearsalRun, fxWorkspace, useTestDb, type FxWorkspace } from "./testing.ts";

const T = useTestDb();

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

async function base(db: Db): Promise<{ ws: FxWorkspace; jobId: string }> {
  const ws = await fxWorkspace(db);
  const agent = await fxAgent(db, ws);
  return { ws, jobId: agent.jobId };
}

describe("0005：障害 F-14 の CHECK", () => {
  it("F-14 を含む rehearsal_cases を挿入できる（fault_ids の CHECK rehearsal_cases_fault_ids_check）", async () => {
    const { db } = T();
    const { ws, jobId } = await base(db);
    const r = await db.query<{ fault_ids: string[] }>(
      `INSERT INTO rehearsal_cases (workspace_id, job_id, source, fault_ids, scenario, seed)
       VALUES ($1, $2, 'generated', '{F-02,F-14}', '{}', 1) RETURNING fault_ids`,
      [ws.workspaceId, jobId],
    );
    expect(r.rows[0]?.fault_ids).toEqual(["F-02", "F-14"]);
  });

  it("F-18 のような範囲の外は rehearsal_cases で CHECK に止まる", async () => {
    const { db } = T();
    const { ws, jobId } = await base(db);
    const e = await caught(
      db.query(`INSERT INTO rehearsal_cases (workspace_id, job_id, source, fault_ids, scenario, seed) VALUES ($1, $2, 'generated', '{F-18}', '{}', 1)`, [
        ws.workspaceId,
        jobId,
      ]),
    );
    expect(isCheckViolation(e)).toBe(true);
    expect(pgErrorInfo(e)?.constraint).toBe("rehearsal_cases_fault_ids_check");
  });

  it("F-14 を含む rehearsal_scenarios を挿入できる。F-18 は CHECK で止まる", async () => {
    const { db } = T();
    const { ws, jobId } = await base(db);
    const run = await fxRehearsalRun(db, ws, { jobId });
    const c = await fxRehearsalCase(db, ws, { jobId });
    const ok = await db.query<{ fault_ids: string[] }>(
      "INSERT INTO rehearsal_scenarios (workspace_id, rehearsal_run_id, case_id, ordinal, fault_ids, scenario, seed) VALUES ($1, $2, $3, 1, '{F-14}', '{}', 1) RETURNING fault_ids",
      [ws.workspaceId, run.runId, c.caseId],
    );
    expect(ok.rows[0]?.fault_ids).toEqual(["F-14"]);
    const e = await caught(
      db.query("INSERT INTO rehearsal_scenarios (workspace_id, rehearsal_run_id, case_id, ordinal, fault_ids, scenario, seed) VALUES ($1, $2, $3, 2, '{F-18}', '{}', 1)", [
        ws.workspaceId,
        run.runId,
        c.caseId,
      ]),
    );
    expect(pgErrorInfo(e)?.constraint).toBe("rehearsal_scenarios_fault_ids_check");
  });

  it("nearest_fault_id は F-14 を受け、F-18 は CHECK で止まる（最も近い障害の表示）", async () => {
    const { db } = T();
    const { ws, jobId } = await base(db);
    const ins = (nearest: string) =>
      db.query(
        `INSERT INTO rehearsal_user_inputs (workspace_id, job_id, text, nearest_fault_id, created_by) VALUES ($1, $2, '指示を入れる', $3, $4)`,
        [ws.workspaceId, jobId, nearest, ws.userId],
      );
    await ins("F-14");
    const e = await caught(ins("F-18"));
    expect(pgErrorInfo(e)?.constraint).toBe("rehearsal_user_inputs_nearest_fault_id_check");
  });
});
