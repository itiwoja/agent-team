// ワークスペースをまたぐ走査の試験（DB §4.1 の2・§4.12、IA §3.13・3.15）
import { describe, expect, it } from "vitest";
import type { Uuid } from "../types.ts";
import { fxAgent, fxApproval, fxAsk, fxAskRun, fxConnector, fxIntent, fxTask, fxWorkspace, useTestDb } from "../testing.ts";
import { markAskRunsScanned, scanActiveAskRuns, scanDueAsks, scanExpiredApprovals, scanQueuedTasks, scanStaleLiveTasks, scanStuckExecutingIntents } from "./scans.ts";

const T = useTestDb();
const NOW = new Date("2026-10-12T09:00:00.000Z");

describe("走査（ロックを取らずに候補を返す）", () => {
  it("定期の依頼：next_run_at <= now を古い順に、ワークスペースをまたいで。削除予約のワークスペースは除く", async () => {
    const { db } = T();
    const a = await fxWorkspace(db);
    const b = await fxWorkspace(db);
    const gone = await fxWorkspace(db, { deleteRequestedAt: NOW });
    const trigger = { type: "schedule", cron: "0 18 * * *", timezone: "Asia/Tokyo" };
    const mk = async (ws: typeof a, nextRunAt: Date) => {
      const { askId } = await fxAsk(db, ws);
      await db.query("UPDATE asks SET trigger = $2, next_run_at = $3 WHERE id = $1", [askId, trigger, nextRunAt]);
      return askId;
    };
    const late = await mk(a, new Date(NOW.getTime() - 1000));
    const exact = await mk(b, NOW);
    await mk(a, new Date(NOW.getTime() + 1));
    await mk(gone, new Date(NOW.getTime() - 5000));
    const hits = await scanDueAsks(db, NOW);
    expect(hits.map((h) => h.id)).toEqual([late, exact]);
    expect(hits[0]).toMatchObject({ workspaceId: a.workspaceId, workspaceKind: "guest", status: "running" });
    expect(await scanDueAsks(db, NOW, 1)).toHaveLength(1);
  });

  it("承認の期限切れ（expires_at = now ちょうどで切れる）・executing の取り残し", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const agent = await fxAgent(db, ws);
    const conn = await fxConnector(db, ws);
    const { taskId } = await fxTask(db, ws, agent, { status: "awaiting_approval" });
    const i1 = await fxIntent(db, ws, { taskId, jobId: agent.jobId, connectorId: conn.connectorId });
    const i2 = await fxIntent(db, ws, { taskId, jobId: agent.jobId, connectorId: conn.connectorId });
    const a1 = await fxApproval(db, ws, { taskId, intentId: i1.intentId });
    const a2 = await fxApproval(db, ws, { taskId, intentId: i2.intentId });
    await db.query("UPDATE approvals SET expires_at = $2 WHERE id = $1", [a1.approvalId, NOW]);
    await db.query("UPDATE approvals SET expires_at = $2 WHERE id = $1", [a2.approvalId, new Date(NOW.getTime() + 1)]);
    const expired = await scanExpiredApprovals(db, NOW);
    expect(expired).toEqual([
      { workspaceId: ws.workspaceId, workspaceKind: "guest", id: a1.approvalId, intentId: i1.intentId, taskId, expiryCause: "ttl" },
    ]);
    const ex = await fxIntent(db, ws, { taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "executing" });
    await db.query("UPDATE action_intents SET updated_at = $2 WHERE id = $1", [ex.intentId, new Date(NOW.getTime() - 120_000)]);
    expect((await scanStuckExecutingIntents(db, new Date(NOW.getTime() - 90_000))).map((h) => h.id)).toEqual([ex.intentId]);
    expect(await scanStuckExecutingIntents(db, new Date(NOW.getTime() - 180_000))).toEqual([]);
  });

  it("queued のタスク：Kill Switch と削除予約のワークスペースは除き、古い順", async () => {
    const { db } = T();
    const ok = await fxWorkspace(db);
    const killed = await fxWorkspace(db, { killSwitchEngaged: true });
    const agentOk = await fxAgent(db, ok);
    const agentKilled = await fxAgent(db, killed);
    const t2 = await fxTask(db, ok, agentOk, { status: "queued", now: new Date(NOW.getTime() + 10) });
    const t1 = await fxTask(db, ok, agentOk, { status: "queued", now: NOW });
    await fxTask(db, ok, agentOk, { status: "running" });
    await fxTask(db, killed, agentKilled, { status: "queued" });
    expect((await scanQueuedTasks(db)).map((h) => h.id)).toEqual([t1.taskId, t2.taskId]);
  });

  it("動いている依頼の実行：拾った印（last_scanned_at）の古い順。まだ拾っていないものが先（先頭の進まない実行で詰まらない）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const runs: Uuid[] = [];
    for (let i = 0; i < 3; i++) {
      const { askId } = await fxAsk(db, ws);
      runs.push((await fxAskRun(db, ws, askId)).askRunId);
    }
    expect(new Set((await scanActiveAskRuns(db, 10)).map((h) => h.id))).toEqual(new Set(runs));
    await markAskRunsScanned(db, [runs[0]!], NOW);
    expect((await scanActiveAskRuns(db, 2)).map((h) => h.id).sort()).toEqual([runs[1]!, runs[2]!].sort());
    await markAskRunsScanned(db, [runs[1]!], new Date(NOW.getTime() + 1000));
    expect((await scanActiveAskRuns(db, 1)).map((h) => h.id)).toEqual([runs[2]]);
    await markAskRunsScanned(db, [runs[2]!], new Date(NOW.getTime() + 2000));
    expect((await scanActiveAskRuns(db, 1)).map((h) => h.id)).toEqual([runs[0]]);
  });

  it("ハートビートの途絶えた本番のタスク（provisioning・running）：承認の待ち・Kill Switch のワークスペースは除く", async () => {
    const { db } = T();
    const ok = await fxWorkspace(db);
    const killed = await fxWorkspace(db, { killSwitchEngaged: true });
    const agentOk = await fxAgent(db, ok);
    const agentKilled = await fxAgent(db, killed);
    const at = (m: number) => new Date(NOW.getTime() - m * 60_000);
    const setHeartbeat = async (taskId: Uuid, heartbeat: Date | null, updated: Date) =>
      db.query("UPDATE tasks SET last_heartbeat_at = $2, updated_at = $3 WHERE id = $1", [taskId, heartbeat, updated]);
    const stale = (await fxTask(db, ok, agentOk, { status: "running" })).taskId;
    await setHeartbeat(stale, at(20), at(20));
    const provisioningNoBeat = (await fxTask(db, ok, agentOk, { status: "provisioning" })).taskId;
    await setHeartbeat(provisioningNoBeat, null, at(15));
    const fresh = (await fxTask(db, ok, agentOk, { status: "running" })).taskId;
    await setHeartbeat(fresh, at(1), at(1));
    const waiting = (await fxTask(db, ok, agentOk, { status: "awaiting_approval" })).taskId;
    await setHeartbeat(waiting, at(60), at(60));
    const killedTask = (await fxTask(db, killed, agentKilled, { status: "running" })).taskId;
    await setHeartbeat(killedTask, at(30), at(30));
    const hits = await scanStaleLiveTasks(db, at(10));
    expect(hits.map((h) => h.id).sort()).toEqual([stale, provisioningNoBeat].sort());
    expect(hits.find((h) => h.id === stale)).toMatchObject({ workspaceId: ok.workspaceId, workspaceKind: "guest", askId: null });
  });
});
