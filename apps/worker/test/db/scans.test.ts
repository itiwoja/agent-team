// alarm の走査の試験（packages/db/src/system/scans.test.ts の WorkspaceDO 版。DB §4.1 の2・§4.12、IA §3.13・3.15）。
// 自分の DO の中だけを走査する。Kill Switch のワークスペースを除く試験は「発動中は何も返さない」に置き換えた
import { describe, expect, it } from "vitest";
import {
  markAskRunsScanned,
  scanActiveAskRuns,
  scanAsksWithPendingReplies,
  scanDueAsks,
  scanExpiredApprovals,
  scanQueuedTasks,
  scanStaleLiveTasks,
  scanStuckExecutingIntents,
  scanStuckGeneratingAsks,
} from "../../src/db/repo/scans.ts";
import { newId, run, type WsDb } from "../../src/db/sqlite.ts";
import type { Uuid } from "../../src/db/types.ts";
import { fxAgent, fxApproval, fxAsk, fxAskRun, fxConnector, fxIntent, fxTask, inWorkspace } from "./fixtures.ts";

const NOW = new Date("2026-10-12T09:00:00.000Z");
const engage = (db: WsDb) => run(db, "UPDATE workspace SET kill_switch_engaged = 1, kill_switch_engaged_at = ? WHERE id = 1", NOW);

describe("走査（候補を返すだけ）", () => {
  it("定期の依頼：next_run_at <= now を古い順に", async () => {
    await inWorkspace((db, ws) => {
      const trigger = { type: "schedule", cron: "0 18 * * *", timezone: "Asia/Tokyo" };
      const mk = (nextRunAt: Date) => {
        const { askId } = fxAsk(db, ws);
        run(db, `UPDATE asks SET "trigger" = ?, next_run_at = ? WHERE id = ?`, trigger, nextRunAt, askId);
        return askId;
      };
      const exact = mk(NOW);
      const late = mk(new Date(NOW.getTime() - 1000));
      mk(new Date(NOW.getTime() + 1));
      const hits = scanDueAsks(db, NOW);
      expect(hits.map((h) => h.id)).toEqual([late, exact]);
      expect(hits[0]).toEqual({ id: late, nextRunAt: new Date(NOW.getTime() - 1000), status: "running" });
      expect(scanDueAsks(db, NOW, 1)).toHaveLength(1);
    });
  });

  it("承認の期限切れ（expires_at = now ちょうどで切れる）・executing の取り残し", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const conn = fxConnector(db);
      const { taskId } = fxTask(db, ws, agent, { status: "awaiting_approval" });
      const i1 = fxIntent(db, { taskId, jobId: agent.jobId, connectorId: conn.connectorId });
      const i2 = fxIntent(db, { taskId, jobId: agent.jobId, connectorId: conn.connectorId });
      const a1 = fxApproval(db, ws, { taskId, intentId: i1.intentId });
      const a2 = fxApproval(db, ws, { taskId, intentId: i2.intentId });
      run(db, "UPDATE approvals SET expires_at = ? WHERE id = ?", NOW, a1.approvalId);
      run(db, "UPDATE approvals SET expires_at = ? WHERE id = ?", new Date(NOW.getTime() + 1), a2.approvalId);
      expect(scanExpiredApprovals(db, NOW)).toEqual([{ id: a1.approvalId, intentId: i1.intentId, taskId, expiryCause: "ttl" }]);
      const ex = fxIntent(db, { taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "executing" });
      run(db, "UPDATE action_intents SET updated_at = ? WHERE id = ?", new Date(NOW.getTime() - 120_000), ex.intentId);
      expect(scanStuckExecutingIntents(db, new Date(NOW.getTime() - 90_000))).toEqual([{ id: ex.intentId, taskId }]);
      expect(scanStuckExecutingIntents(db, new Date(NOW.getTime() - 180_000))).toEqual([]);
    });
  });

  it("queued のタスク：古い順。Kill Switch の発動中は何も返さない", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const t2 = fxTask(db, ws, agent, { status: "queued", now: new Date(NOW.getTime() + 10) });
      const t1 = fxTask(db, ws, agent, { status: "queued", now: NOW });
      fxTask(db, ws, agent, { status: "running" });
      expect(scanQueuedTasks(db).map((h) => h.id)).toEqual([t1.taskId, t2.taskId]);
      expect(scanQueuedTasks(db)[0]?.queuedAt).toEqual(NOW);
      engage(db);
      expect(scanQueuedTasks(db)).toEqual([]);
    });
  });

  it("動いている依頼の実行：拾った印（last_scanned_at）の古い順。まだ拾っていないものが先（先頭の進まない実行で詰まらない）", async () => {
    await inWorkspace((db, ws) => {
      const runs: Uuid[] = [];
      for (let i = 0; i < 3; i++) {
        const { askId } = fxAsk(db, ws);
        runs.push(fxAskRun(db, askId).askRunId);
      }
      expect(new Set(scanActiveAskRuns(db, 10).map((h) => h.id))).toEqual(new Set(runs));
      expect(scanActiveAskRuns(db, 10)[0]?.createdBy).toBe(ws.userId);
      markAskRunsScanned(db, [runs[0]!], NOW);
      expect(scanActiveAskRuns(db, 2).map((h) => h.id).sort()).toEqual([runs[1]!, runs[2]!].sort());
      markAskRunsScanned(db, [runs[1]!], new Date(NOW.getTime() + 1000));
      expect(scanActiveAskRuns(db, 1).map((h) => h.id)).toEqual([runs[2]]);
      markAskRunsScanned(db, [runs[2]!], new Date(NOW.getTime() + 2000));
      expect(scanActiveAskRuns(db, 1).map((h) => h.id)).toEqual([runs[0]]);
      engage(db);
      expect(scanActiveAskRuns(db, 10)).toEqual([]);
    });
  });

  it("順番待ちの返事：動いている実行がない running・done の依頼だけ。古い返事が先", async () => {
    await inWorkspace((db, ws) => {
      const reply = (askId: Uuid, at: Date) =>
        run(db, "INSERT INTO ask_pending_replies (id, ask_id, text, requester_id, created_at) VALUES (?, ?, '返事', ?, ?)", newId(), askId, ws.userId, at);
      const done = fxAsk(db, ws, { status: "done" }).askId;
      const running = fxAsk(db, ws).askId;
      const busy = fxAsk(db, ws).askId;
      const failed = fxAsk(db, ws, { status: "failed" }).askId;
      fxAskRun(db, busy);
      reply(running, new Date(NOW.getTime() + 1));
      reply(done, NOW);
      reply(busy, NOW);
      reply(failed, NOW);
      expect(scanAsksWithPendingReplies(db)).toEqual([
        { id: done, askId: done },
        { id: running, askId: running },
      ]);
      engage(db);
      expect(scanAsksWithPendingReplies(db)).toEqual([]);
    });
  });

  it("ハートビートの途絶えた本番のタスク（provisioning・running）：承認の待ちは除く。Kill Switch の発動中は何も返さない", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const at = (m: number) => new Date(NOW.getTime() - m * 60_000);
      const setHeartbeat = (taskId: Uuid, heartbeat: Date | null, updated: Date) =>
        run(db, "UPDATE tasks SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?", heartbeat, updated, taskId);
      const stale = fxTask(db, ws, agent, { status: "running" }).taskId;
      setHeartbeat(stale, at(20), at(20));
      const provisioningNoBeat = fxTask(db, ws, agent, { status: "provisioning" }).taskId;
      setHeartbeat(provisioningNoBeat, null, at(15));
      const fresh = fxTask(db, ws, agent, { status: "running" }).taskId;
      setHeartbeat(fresh, at(1), at(1));
      const waiting = fxTask(db, ws, agent, { status: "awaiting_approval" }).taskId;
      setHeartbeat(waiting, at(60), at(60));
      const hits = scanStaleLiveTasks(db, at(10));
      expect(hits.map((h) => h.id)).toEqual([stale, provisioningNoBeat]);
      expect(hits[0]).toEqual({ id: stale, askId: null });
      engage(db);
      expect(scanStaleLiveTasks(db, at(10))).toEqual([]);
    });
  });

  it("生成中のまま止まった依頼：質問を待っているものは除く", async () => {
    await inWorkspace((db, ws) => {
      const old = new Date(NOW.getTime() - 10 * 60_000);
      const stuck = fxAsk(db, ws, { status: "generating" }).askId;
      const asking = fxAsk(db, ws, { status: "generating" }).askId;
      const answered = fxAsk(db, ws, { status: "generating" }).askId;
      const fresh = fxAsk(db, ws, { status: "generating" }).askId;
      const q = { text: "どの店？", choices: [], allowFreeText: true };
      run(db, "UPDATE asks SET question = ? WHERE id IN (?, ?)", q, asking, answered);
      run(db, "UPDATE asks SET question_answer = '駅前' WHERE id = ?", answered);
      run(db, "UPDATE asks SET updated_at = ? WHERE id IN (?, ?, ?)", old, stuck, asking, answered);
      run(db, "UPDATE asks SET updated_at = ? WHERE id = ?", NOW, fresh);
      expect(scanStuckGeneratingAsks(db, new Date(NOW.getTime() - 60_000)).map((h) => h.id).sort()).toEqual([stuck, answered].sort());
    });
  });
});
