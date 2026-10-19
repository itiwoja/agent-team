// 実行の文脈の試験（db-schema.md §7.6 の T-80・T-81 の DB の部分、M-17）
import { describe, expect, it } from "vitest";
import type { Db } from "./client.ts";
import { execContextOf, execContextSql, ExecContextError, type ExecContext } from "./exec-context.ts";
import {
  fxAgent,
  fxConnector,
  fxHash,
  fxIntent,
  fxRehearsalCase,
  fxRehearsalRun,
  fxRehearsalScenario,
  fxSimExecution,
  fxTask,
  fxWorkspace,
  useTestDb,
} from "./testing.ts";

const T = useTestDb();

/** 同じ仕事・文脈の unknown_outcome の destinationKey（BR-68 の unknownOutcomeKeys を作る問い合わせの形） */
async function unknownOutcomeKeys(db: Db, workspaceId: string, jobId: string, ec: ExecContext): Promise<string[]> {
  const c = execContextSql(ec, "t", 3);
  const r = await db.query<{ k: string }>(
    `SELECT DISTINCT i.destination_key AS k FROM action_intents i JOIN tasks t ON t.id = i.task_id
      WHERE i.workspace_id = $1 AND i.job_id = $2 AND i.status = 'unknown_outcome' AND ${c.sql} ORDER BY 1`,
    [workspaceId, jobId, ...c.params],
  );
  return r.rows.map((x) => x.k);
}

describe("本番とリハーサルを混ぜない", () => {
  it("T-80 リハーサルの F-01 で同じ仕事に unknown_outcome ができても、本番の unknownOutcomeKeys に入らない。T-81 本番のものは入る", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const agent = await fxAgent(db, ws);
    const conn = await fxConnector(db, ws);
    const run = await fxRehearsalRun(db, ws, { jobId: agent.jobId });
    const c = await fxRehearsalCase(db, ws, { jobId: agent.jobId });
    const sc = await fxRehearsalScenario(db, ws, { runId: run.runId, caseId: c.caseId });
    const governed = await fxSimExecution(db, ws, { rehearsalRunId: run.runId, variant: "governed" });
    const shadow = await fxSimExecution(db, ws, { rehearsalRunId: run.runId, variant: "shadow" });
    const rTask = await fxTask(db, ws, agent, { rehearsalRunId: run.runId, rehearsalScenarioId: sc.scenarioId, simExecutionId: governed.executionId });
    const sTask = await fxTask(db, ws, agent, {
      rehearsalRunId: run.runId,
      rehearsalScenarioId: sc.scenarioId,
      simExecutionId: shadow.executionId,
      shadow: true,
    });
    const live = await fxTask(db, ws, agent);
    const dest = fxHash("dest:supplier-01");
    await fxIntent(db, ws, { taskId: rTask.taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "unknown_outcome", destinationKey: dest });
    expect(await unknownOutcomeKeys(db, ws.workspaceId, agent.jobId, { kind: "live" })).toEqual([]);
    expect(await unknownOutcomeKeys(db, ws.workspaceId, agent.jobId, execContextOf({ id: rTask.taskId, rehearsal_run_id: run.runId, sim_execution_id: governed.executionId }))).toEqual([dest]);
    // 同じ状況の影の走行とも混ぜない
    expect(await unknownOutcomeKeys(db, ws.workspaceId, agent.jobId, { kind: "rehearsal", simExecutionId: shadow.executionId })).toEqual([]);
    void sTask;
    await fxIntent(db, ws, { taskId: live.taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "unknown_outcome", destinationKey: dest });
    expect(await unknownOutcomeKeys(db, ws.workspaceId, agent.jobId, { kind: "live" })).toEqual([dest]);
  });

  it("execContextOf：本番は live、リハーサルは走行の ID。走行のないリハーサルのタスクは本番に倒さず例外", () => {
    expect(execContextOf({ id: "t", rehearsal_run_id: null, sim_execution_id: null })).toEqual({ kind: "live" });
    expect(execContextOf({ id: "t", rehearsal_run_id: "r", sim_execution_id: "e" })).toEqual({ kind: "rehearsal", simExecutionId: "e" });
    expect(() => execContextOf({ id: "t", rehearsal_run_id: "r", sim_execution_id: null })).toThrow(ExecContextError);
    expect(execContextSql({ kind: "live" }, "t", 5)).toEqual({ sql: "t.rehearsal_run_id IS NULL", params: [] });
    expect(execContextSql({ kind: "rehearsal", simExecutionId: "e" }, "tk", 5)).toEqual({ sql: "tk.sim_execution_id = $5", params: ["e"] });
    expect(() => execContextSql({ kind: "live" }, "t; DROP", 1)).toThrow();
  });
});
