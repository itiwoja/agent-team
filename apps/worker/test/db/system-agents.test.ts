// 使われないエージェントの片付けの試験（packages/db/src/system/agents.test.ts の WorkspaceDO 版）。
// ot_app のロールで流す話・ワークスペースをまたぐ話は落とした（DO の中の担当だけを見る）
import { describe, expect, it } from "vitest";
import { CODECS } from "../../src/db/codecs.ts";
import { removeUnusedAgents } from "../../src/db/repo/system-agents.ts";
import { all, newId, one, run, type WsDb } from "../../src/db/sqlite.ts";
import { fxAgent, fxAsk, fxAskMember, fxTask, inWorkspace, type FxAgent } from "./fixtures.ts";

const NOW = new Date("2026-12-01T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** エージェントと、それに付いた依頼の参加の時刻をそろえる（タスクは fxTask の now で決める） */
function touch(db: WsDb, agent: FxAgent, at: Date): void {
  run(db, "UPDATE agents SET created_at = ?1, updated_at = ?1 WHERE id = ?2", at, agent.agentId);
  run(db, "UPDATE ask_members SET created_at = ? WHERE agent_id = ?", at, agent.agentId);
}
function statusOf(db: WsDb, agent: FxAgent): string | undefined {
  return one<{ status: string }>(db, {}, "SELECT status FROM agents WHERE id = ?", agent.agentId)?.status;
}

describe("使われないエージェントの片付け（30日）", () => {
  it("30日ちょうどは残し、1ms 過ぎたら removed にして監査ログ agent.removed を残す（行は消さない）", async () => {
    await inWorkspace((db) => {
      const edge = fxAgent(db, { name: "境目係" });
      const over = fxAgent(db, { name: "古い係" });
      touch(db, edge, ago(30 * DAY));
      touch(db, over, ago(30 * DAY + 1));
      const r = removeUnusedAgents(db, NOW);
      expect(r.removed).toEqual([{ agentId: over.agentId }]);
      expect(r.failed).toEqual([]);
      expect(statusOf(db, edge)).toBe("active");
      expect(statusOf(db, over)).toBe("removed");
      const log = all<{ event_type: string; actor_id: string; payload: unknown }>(
        db,
        CODECS.audit_logs,
        "SELECT event_type, actor_id, payload FROM audit_logs WHERE event_type = 'agent.removed'",
      );
      expect(log).toEqual([{ event_type: "agent.removed", actor_id: "retention", payload: { agentId: over.agentId, name: "古い係", reason: "unused_30d" } }]);
      // 2回目は何もしない
      expect(removeUnusedAgents(db, NOW).scanned).toBe(0);
    });
  });

  it("最近のタスク・依頼への参加・会話があれば残す", async () => {
    await inWorkspace((db, ws) => {
      const tasked = fxAgent(db);
      const member = fxAgent(db);
      const talked = fxAgent(db);
      fxTask(db, ws, tasked, { status: "completed", now: ago(10 * DAY) });
      const { askId } = fxAsk(db, ws, { status: "done" });
      fxAskMember(db, { askId, agent: member });
      for (const a of [tasked, member, talked]) touch(db, a, ago(60 * DAY));
      run(db, "UPDATE ask_members SET created_at = ? WHERE agent_id = ?", ago(5 * DAY), member.agentId);
      run(db, "INSERT INTO agent_messages (id, agent_id, author, kind, body, created_at) VALUES (?, ?, 'user', 'text', 'やあ', ?)", newId(), talked.agentId, ago(DAY));
      expect(removeUnusedAgents(db, NOW).scanned).toBe(0);
    });
  });

  it("終わっていないタスク・動いている依頼・定期の依頼・用意した依頼に入っていれば古くても残す。取り消した定期の依頼なら片付ける", async () => {
    await inWorkspace((db, ws) => {
      const running = fxAgent(db);
      fxTask(db, ws, running, { status: "running", now: ago(60 * DAY) });
      const waiting = fxAgent(db);
      fxAskMember(db, { askId: fxAsk(db, ws, { status: "waiting_input" }).askId, agent: waiting });
      const recurring = fxAgent(db);
      const rec = fxAsk(db, ws, { status: "done" });
      run(db, `UPDATE asks SET "trigger" = '{"type":"schedule"}' WHERE id = ?`, rec.askId);
      fxAskMember(db, { askId: rec.askId, agent: recurring });
      const seeded = fxAgent(db);
      fxAskMember(db, { askId: fxAsk(db, ws, { status: "done", seedKey: "prepared-purchasing" }).askId, agent: seeded });
      const cancelled = fxAgent(db);
      const can = fxAsk(db, ws, { status: "cancelled" });
      run(db, `UPDATE asks SET "trigger" = '{"type":"schedule"}' WHERE id = ?`, can.askId);
      fxAskMember(db, { askId: can.askId, agent: cancelled });
      for (const a of [running, waiting, recurring, seeded, cancelled]) touch(db, a, ago(60 * DAY));
      const r = removeUnusedAgents(db, NOW);
      expect(r.removed.map((x) => x.agentId)).toEqual([cancelled.agentId]);
    });
  });

  it("batch 件ずつ片付け、残りは次の回", async () => {
    await inWorkspace((db) => {
      const agents = [fxAgent(db), fxAgent(db), fxAgent(db)];
      for (const a of agents) touch(db, a, ago(40 * DAY));
      expect(removeUnusedAgents(db, NOW, { batch: 2 }).removed).toHaveLength(2);
      expect(removeUnusedAgents(db, NOW, { batch: 2 }).removed).toHaveLength(1);
    });
  });
});
