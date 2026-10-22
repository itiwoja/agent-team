// 使われないエージェントの片付けの試験。ot_app の権限で流す
import { describe, expect, it } from "vitest";
import type { Db } from "../client.ts";
import { fxAgent, fxAsk, fxAskMember, fxTask, fxWorkspace, openRoleDb, useTestDb, type FxAgent } from "../testing.ts";
import { removeUnusedAgents } from "./agents.ts";

const T = useTestDb();
const NOW = new Date("2026-12-01T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

async function withApp<R>(fn: (app: Db) => Promise<R>): Promise<R> {
  const app = await openRoleDb(T().url, "ot_app");
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}
/** エージェントと、それに付いた依頼の参加の時刻をそろえる（タスクは fxTask の now で決める） */
async function touch(db: Db, agent: FxAgent, at: Date): Promise<void> {
  await db.query("UPDATE agents SET created_at = $2, updated_at = $2 WHERE id = $1", [agent.agentId, at]);
  await db.query("UPDATE ask_members SET created_at = $2 WHERE agent_id = $1", [agent.agentId, at]);
}
async function statusOf(db: Db, agent: FxAgent): Promise<string | undefined> {
  return (await db.query<{ status: string }>("SELECT status FROM agents WHERE id = $1", [agent.agentId])).rows[0]?.status;
}

describe("使われないエージェントの片付け（30日）", () => {
  it("30日ちょうどは残し、1ms 過ぎたら removed にして監査ログ agent.removed を残す（行は消さない）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { audit: true });
    const edge = await fxAgent(db, ws, { name: "境目係" });
    const over = await fxAgent(db, ws, { name: "古い係" });
    await touch(db, edge, ago(30 * DAY));
    await touch(db, over, ago(30 * DAY + 1));
    const r = await withApp((app) => removeUnusedAgents(app, NOW));
    expect(r.removed).toEqual([{ workspaceId: ws.workspaceId, agentId: over.agentId }]);
    expect(r.failed).toEqual([]);
    expect(await statusOf(db, edge)).toBe("active");
    expect(await statusOf(db, over)).toBe("removed");
    const log = await db.query<{ event_type: string; actor_id: string; payload: unknown }>(
      "SELECT event_type, actor_id, payload FROM audit_logs WHERE workspace_id = $1 AND event_type = 'agent.removed'",
      [ws.workspaceId],
    );
    expect(log.rows).toEqual([{ event_type: "agent.removed", actor_id: "retention", payload: { agentId: over.agentId, name: "古い係", reason: "unused_30d" } }]);
    // 2回目は何もしない
    const again = await withApp((app) => removeUnusedAgents(app, NOW));
    expect(again.scanned).toBe(0);
  });

  it("最近のタスク・依頼への参加があれば残す", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { audit: true });
    const tasked = await fxAgent(db, ws);
    const member = await fxAgent(db, ws);
    await fxTask(db, ws, tasked, { status: "completed", now: ago(10 * DAY) });
    const { askId } = await fxAsk(db, ws, { status: "done" });
    await fxAskMember(db, ws, { askId, agent: member });
    await touch(db, tasked, ago(60 * DAY));
    await touch(db, member, ago(60 * DAY));
    await db.query("UPDATE ask_members SET created_at = $2 WHERE agent_id = $1", [member.agentId, ago(5 * DAY)]);
    const r = await withApp((app) => removeUnusedAgents(app, NOW));
    expect(r.scanned).toBe(0);
  });

  it("終わっていないタスク・動いている依頼・定期の依頼・用意した依頼に入っていれば古くても残す。取り消した定期の依頼なら片付ける", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { audit: true });
    const running = await fxAgent(db, ws);
    await fxTask(db, ws, running, { status: "running", now: ago(60 * DAY) });
    const waiting = await fxAgent(db, ws);
    await fxAskMember(db, ws, { askId: (await fxAsk(db, ws, { status: "waiting_input" })).askId, agent: waiting });
    const recurring = await fxAgent(db, ws);
    const rec = await fxAsk(db, ws, { status: "done" });
    await db.query(`UPDATE asks SET trigger = '{"type":"schedule"}' WHERE id = $1`, [rec.askId]);
    await fxAskMember(db, ws, { askId: rec.askId, agent: recurring });
    const seeded = await fxAgent(db, ws);
    await fxAskMember(db, ws, { askId: (await fxAsk(db, ws, { status: "done", seedKey: "prepared-purchasing" })).askId, agent: seeded });
    const cancelled = await fxAgent(db, ws);
    const can = await fxAsk(db, ws, { status: "cancelled" });
    await db.query(`UPDATE asks SET trigger = '{"type":"schedule"}' WHERE id = $1`, [can.askId]);
    await fxAskMember(db, ws, { askId: can.askId, agent: cancelled });
    for (const a of [running, waiting, recurring, seeded, cancelled]) await touch(db, a, ago(60 * DAY));
    const r = await withApp((app) => removeUnusedAgents(app, NOW));
    expect(r.removed.map((x) => x.agentId)).toEqual([cancelled.agentId]);
  });

});
