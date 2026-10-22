// 0022（スキルの学習と整理）の問い合わせの試験。ot_app の権限で流す
import { describe, expect, it } from "vitest";
import type { Db } from "../client.ts";
import { system } from "../index.ts";
import { fxAgent, fxHash, fxTask, fxWorkspace, openRoleDb, useTestDb, type FxAgent, type FxWorkspace } from "../testing.ts";
import { insertAgentSkill, listAgentSkills } from "./sandbox.ts";
import {
  applyPruneChange,
  applyRuleRestoreChange,
  decideSkillProposal,
  getEvolutionEvent,
  insertEvolutionEvent,
  insertSkillProposal,
  lastSkillProposalAt,
  listAgentSkillsIncludingRemoved,
  listPendingSkillProposals,
  listRecentEvolutionEvents,
  listRecentLiveSucceededTasks,
  listStaleSkills,
  markEvolutionItemRestored,
  markSkillsRemoved,
  restoreSkill,
  ruleLastMatchedAt,
  touchSkillUsed,
} from "./evolution.ts";

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
async function owner(): Promise<{ ws: FxWorkspace; agent: FxAgent }> {
  const ws = await fxWorkspace(T().db, { kind: "owner", audit: true });
  return { ws, agent: await fxAgent(T().db, ws) };
}
const DIGEST = fxHash("skill");

describe("スキル", () => {
  it("listAgentSkills は外したものを返さず、IncludingRemoved は返す。insertAgentSkill の ON CONFLICT は外した印を戻して上書きする", async () => {
    const { ws, agent } = await owner();
    await withApp(async (app) => {
      await app.transaction(async (tx) => {
        const pack = await insertAgentSkill(tx, ws.ctx, { agentId: agent.agentId, name: "採点", description: "d", body: "b", packId: "teacher", now: NOW });
        expect(pack.origin).toBe("pack");
        expect(pack.removed_at).toBeNull();
        await insertAgentSkill(tx, ws.ctx, { agentId: agent.agentId, name: "要約", description: "d", body: "b", packId: null, now: NOW, origin: "learned", approvedBy: ws.userId, approvedAt: NOW, approvedDigest: DIGEST });
        await markSkillsRemoved(tx, ws.ctx, [pack.id], NOW);
      });
      expect((await listAgentSkills(app, ws.ctx, agent.agentId)).map((s) => s.name)).toEqual(["要約"]);
      expect((await listAgentSkillsIncludingRemoved(app, ws.ctx, agent.agentId)).map((s) => s.name)).toEqual(["採点", "要約"]);
      const again = await app.transaction((tx) =>
        insertAgentSkill(tx, ws.ctx, { agentId: agent.agentId, name: "採点", description: "新", body: "新", packId: null, now: NOW, origin: "learned", approvedBy: ws.userId, approvedAt: NOW, approvedDigest: DIGEST }),
      );
      expect(again).toMatchObject({ description: "新", origin: "learned", removed_at: null, approved_digest: DIGEST });
      expect(await listAgentSkills(app, ws.ctx, agent.agentId)).toHaveLength(2);
    });
  });

  it("learned は approved_digest と approved_at がないと入れられない（DB の CHECK）", async () => {
    const { ws, agent } = await owner();
    await withApp(async (app) => {
      await expect(
        app.transaction((tx) => insertAgentSkill(tx, ws.ctx, { agentId: agent.agentId, name: "x", description: "d", body: "b", packId: null, now: NOW, origin: "learned" })),
      ).rejects.toThrow(/agent_skills_learned_chk/);
    });
  });

  it("listStaleSkills は coalesce(last_used_at, approved_at, created_at) が before より前（ちょうどは含めない）。使うと外れず、戻すと last_used_at が now になる", async () => {
    const { ws, agent } = await owner();
    await withApp(async (app) => {
      const before = ago(30 * DAY);
      const [edge, over, used] = await app.transaction(async (tx) => [
        await insertAgentSkill(tx, ws.ctx, { agentId: agent.agentId, name: "境目", description: "d", body: "b", packId: "p1", now: before }),
        await insertAgentSkill(tx, ws.ctx, { agentId: agent.agentId, name: "古い", description: "d", body: "b", packId: "p1", now: new Date(before.getTime() - 1) }),
        await insertAgentSkill(tx, ws.ctx, { agentId: agent.agentId, name: "使った", description: "d", body: "b", packId: "p1", now: ago(90 * DAY) }),
      ]);
      await touchSkillUsed(app, ws.ctx, used!.id, ago(DAY));
      expect((await listStaleSkills(app, ws.ctx, before)).map((s) => s.name)).toEqual(["古い"]);
      const removed = await app.transaction((tx) => markSkillsRemoved(tx, ws.ctx, [over!.id, edge!.id], NOW));
      expect(removed).toHaveLength(2);
      expect(await listStaleSkills(app, ws.ctx, before)).toEqual([]);
      // 二重に外さない
      expect(await app.transaction((tx) => markSkillsRemoved(tx, ws.ctx, [over!.id], NOW))).toEqual([]);
      const back = await app.transaction((tx) => restoreSkill(tx, ws.ctx, over!.id, NOW));
      expect(back).toMatchObject({ removed_at: null, last_used_at: NOW });
      expect(await app.transaction((tx) => restoreSkill(tx, ws.ctx, over!.id, NOW))).toBeNull();
    });
  });
});

describe("スキルの案", () => {
  it("proposed を保存し、決められるのは1回だけ（二重の決定は null）。skipped は一覧に出ず、lastSkillProposalAt に数える", async () => {
    const { ws, agent } = await owner();
    await withApp(async (app) => {
      expect(await lastSkillProposalAt(app, ws.ctx, agent.agentId)).toBeNull();
      const skipped = await app.transaction((tx) => insertSkillProposal(tx, ws.ctx, { agentId: agent.agentId, status: "skipped", sourceTaskIds: [], now: ago(2 * DAY) }));
      expect(skipped).toMatchObject({ status: "skipped", name: null });
      const p = await app.transaction((tx) =>
        insertSkillProposal(tx, ws.ctx, { agentId: agent.agentId, status: "proposed", name: "週報", description: "週報の手順", body: "# 手順", reason: "毎週同じ", sourceTaskIds: [], now: ago(DAY) }),
      );
      expect((await listPendingSkillProposals(app, ws.ctx)).map((x) => x.id)).toEqual([p.id]);
      expect(await listPendingSkillProposals(app, ws.ctx, "00000000-0000-4000-8000-000000000000")).toEqual([]);
      expect(await lastSkillProposalAt(app, ws.ctx, agent.agentId)).toEqual(ago(DAY));
      // proposed なのに本文がない案は作れない
      await expect(app.transaction((tx) => insertSkillProposal(tx, ws.ctx, { agentId: agent.agentId, status: "proposed", sourceTaskIds: [], now: NOW }))).rejects.toThrow(/skill_proposals_content_chk/);

      const decided = await app.transaction((tx) => decideSkillProposal(tx, ws.ctx, { id: p.id, status: "approved", decidedBy: ws.userId, now: NOW }));
      expect(decided).toMatchObject({ status: "approved", decided_by: ws.userId, decided_at: NOW });
      expect(await app.transaction((tx) => decideSkillProposal(tx, ws.ctx, { id: p.id, status: "rejected", decidedBy: ws.userId, now: NOW }))).toBeNull();
      expect(await listPendingSkillProposals(app, ws.ctx)).toEqual([]);
    });
  });
});

describe("成功したタスクの数え方", () => {
  it("本番の成功（報告つき）だけを数え、最後の案より後・30日以内・minTasks 件以上の担当を返す", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { kind: "owner", audit: true });
    const many = await fxAgent(db, ws, { name: "多い係" });
    const few = await fxAgent(db, ws, { name: "少ない係" });
    const old = await fxAgent(db, ws, { name: "古い係" });
    const proposed = await fxAgent(db, ws, { name: "案の後係" });
    const withReport = async (a: FxAgent, o: Parameters<typeof fxTask>[3]) => {
      const { taskId } = await fxTask(db, ws, a, o);
      await db.query("UPDATE tasks SET report = '報告', report_kind = 'normal', prompt = '指示' WHERE id = $1", [taskId]);
      return taskId;
    };
    for (let i = 1; i <= 3; i++) await withReport(many, { status: "succeeded", now: ago(i * DAY) });
    // 数えないもの：失敗
    await fxTask(db, ws, few, { status: "failed", now: ago(DAY) });
    await withReport(few, { status: "succeeded", now: ago(DAY) });
    await withReport(few, { status: "succeeded", now: ago(DAY) });
    // 30日より前
    for (let i = 0; i < 3; i++) await withReport(old, { status: "completed", now: ago(31 * DAY + i) });
    // 最後の案より後が2件しかない
    for (let i = 1; i <= 4; i++) await withReport(proposed, { status: "succeeded", now: ago(i * DAY) });
    await db.query("INSERT INTO skill_proposals (workspace_id, agent_id, status, created_at) VALUES ($1, $2, 'skipped', $3)", [ws.workspaceId, proposed.agentId, ago(2.5 * DAY)]);

    const guest = await fxWorkspace(db, { kind: "guest" });
    const ga = await fxAgent(db, guest);
    for (let i = 1; i <= 3; i++) {
      const { taskId } = await fxTask(db, guest, ga, { status: "succeeded", now: ago(i * DAY) });
      await db.query("UPDATE tasks SET report = '報告', report_kind = 'normal' WHERE id = $1", [taskId]);
    }
    const r = await withApp((app) => system.scanAgentsForSkillLearning(app, NOW, { minTasks: 3, windowMs: 30 * DAY, limit: 10 }));
    expect(r).toEqual([{ workspaceId: ws.workspaceId, agentId: many.agentId }]);
    // minTasks を下げると、2件の担当・案の後に2件ある担当も入る（失敗の1件は数えない）
    expect(await withApp((app) => system.scanAgentsForSkillLearning(app, NOW, { minTasks: 2, limit: 10 }))).toHaveLength(3);

    // Kill Switch の間は対象にしない
    await db.query("UPDATE workspaces SET kill_switch_engaged = true, kill_switch_engaged_at = now() WHERE id = $1", [ws.workspaceId]);
    expect(await withApp((app) => system.scanAgentsForSkillLearning(app, NOW, { minTasks: 3, limit: 10 }))).toEqual([]);
    await db.query("UPDATE workspaces SET kill_switch_engaged = false, kill_switch_engaged_at = NULL WHERE id = $1", [ws.workspaceId]);

    // 未決定の案（proposed）がある担当は、その後にタスクが増えても対象にしない（人が決めるまで次の案は作らない）
    await db.query("INSERT INTO skill_proposals (workspace_id, agent_id, status, name, description, body, created_at) VALUES ($1, $2, 'proposed', '案', '説明', '本文', $3)", [ws.workspaceId, many.agentId, ago(10 * DAY)]);
    expect(await withApp((app) => system.scanAgentsForSkillLearning(app, NOW, { minTasks: 3, limit: 10 }))).toEqual([]);
    await db.query("DELETE FROM skill_proposals WHERE agent_id = $1", [many.agentId]);

    const recent = await withApp((app) => listRecentLiveSucceededTasks(app, ws.ctx, many.agentId, { since: ago(2.5 * DAY), limit: 5 }));
    expect(recent.map((x) => x.instruction)).toEqual(["指示", "指示"]);
    expect(recent[0]).toMatchObject({ report: "報告" });
  });

  it("リハーサルのタスクと shadow は listRecentLiveSucceededTasks に出ない", async () => {
    const { db } = T();
    const { ws, agent } = await owner();
    const { taskId } = await fxTask(db, ws, agent, { status: "succeeded", now: ago(DAY) });
    await db.query("UPDATE tasks SET report = '報告', report_kind = 'normal' WHERE id = $1", [taskId]);
    await db.query("UPDATE tasks SET shadow = false WHERE id = $1", [taskId]);
    expect(await listRecentLiveSucceededTasks(db, ws.ctx, agent.agentId, { since: ago(10 * DAY), limit: 5 })).toHaveLength(1);
    // 試し実行（is_dry_run）にすると外れる
    await db.query("UPDATE tasks SET is_dry_run = true, trigger_type = 'dry_run' WHERE id = $1", [taskId]);
    expect(await listRecentLiveSucceededTasks(db, ws.ctx, agent.agentId, { since: ago(10 * DAY), limit: 5 })).toHaveLength(0);
  });
});

describe("整理の走査", () => {
  it("外す候補のスキルかルールを持つ担当だけ返す", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { kind: "owner", audit: true });
    const stale = await fxAgent(db, ws, { name: "古いスキル係" });
    const fresh = await fxAgent(db, ws, { name: "新しいスキル係" });
    const ruled = await fxAgent(db, ws, { name: "ルール係" });
    await fxAgent(db, ws, { name: "何もない係" });
    await withApp(async (app) => {
      await app.transaction(async (tx) => {
        await insertAgentSkill(tx, ws.ctx, { agentId: stale.agentId, name: "s", description: "d", body: "b", packId: "p1", now: ago(31 * DAY) });
        await insertAgentSkill(tx, ws.ctx, { agentId: fresh.agentId, name: "s", description: "d", body: "b", packId: "p1", now: ago(DAY) });
      });
    });
    // スナップショットは更新できないので、ルールつきの定義を新しく足して今のものにする
    const snap = await db.query<{ id: string }>(
      `INSERT INTO agent_snapshots (workspace_id, agent_id, status, definition, effective_policies, ceilings_version)
       VALUES ($1, $2, 'valid', $3, '{}', '0-H.1') RETURNING id`,
      [ws.workspaceId, ruled.agentId, { version: 2, name: "ルール係", rules: [{ id: "r1" }] }],
    );
    await db.query("UPDATE agents SET current_snapshot_id = $2 WHERE id = $1", [ruled.agentId, snap.rows[0]!.id]);
    const r = await withApp((app) => system.scanAgentsForPruning(app, NOW, { limit: 10 }));
    expect(r.map((x) => x.agentId).sort()).toEqual([stale.agentId, ruled.agentId].sort());
  });
});

describe("ルールの整理と記録", () => {
  async function setup() {
    const { db } = T();
    const { ws, agent } = await owner();
    const def = { version: 2, name: "x", rules: [] as unknown[] };
    const input = (expected: string) => ({
      agentId: agent.agentId,
      patch: [{ op: "remove", path: "/rules/0" }],
      expectedSnapshotId: expected,
      definition: def as never,
      effectivePolicies: { [agent.jobSlug]: { policy: { version: 1 }, hash: agent.policyHash } } as never,
      clamped: [],
      ceilingsVersion: "0-H.1",
      now: NOW,
    });
    return { db, ws, agent, input };
  }

  it("applyPruneChange は prune・narrow・システムの決定で保存し、スナップショットがずれていたら null", async () => {
    const { db, ws, agent, input } = await setup();
    await withApp(async (app) => {
      const done = await app.transaction((tx) => applyPruneChange(tx, ws.ctx, { ...input(agent.snapshotId), removedRuleIds: ["r1"] }));
      expect(done).not.toBeNull();
      const ch = (await db.query("SELECT origin, classification, widened_items, decided_by, status, snapshot_id FROM agent_config_changes WHERE id = $1", [done!.changeId])).rows[0];
      expect(ch).toEqual({ origin: "prune", classification: "narrow", widened_items: null, decided_by: null, status: "applied", snapshot_id: done!.snapshotId });
      expect((await db.query<{ s: string }>("SELECT current_snapshot_id AS s FROM agents WHERE id = $1", [agent.agentId])).rows[0]?.s).toBe(done!.snapshotId);
      const log = await db.query<{ payload: { removedRuleIds: string[] } }>("SELECT payload FROM audit_logs WHERE workspace_id = $1 AND event_type = 'agent.config.narrowed'", [ws.workspaceId]);
      expect(log.rows).toHaveLength(1);
      expect(log.rows[0]!.payload.removedRuleIds).toEqual(["r1"]);
      // 期待したスナップショットから動いている（古いまま）なら何も書かない
      const before = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_config_changes WHERE agent_id = $1", [agent.agentId])).rows[0]!.n;
      expect(await app.transaction((tx) => applyPruneChange(tx, ws.ctx, { ...input(agent.snapshotId), removedRuleIds: ["r1"] }))).toBeNull();
      expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_config_changes WHERE agent_id = $1", [agent.agentId])).rows[0]!.n).toBe(before);

      // 戻す：revert・widen・reverts_change_id
      const restored = await app.transaction((tx) =>
        applyRuleRestoreChange(tx, ws.ctx, {
          ...input(done!.snapshotId),
          patch: [{ op: "add", path: "/rules/-", value: { id: "r1" } }],
          widenedItems: [{ rule: "r1" }],
          revertsChangeId: done!.changeId,
          ruleId: "r1",
          decidedBy: ws.userId,
        }),
      );
      expect(restored).not.toBeNull();
      const rc = (await db.query("SELECT origin, classification, reverts_change_id, decided_by FROM agent_config_changes WHERE id = $1", [restored!.changeId])).rows[0];
      expect(rc).toEqual({ origin: "revert", classification: "widen", reverts_change_id: done!.changeId, decided_by: ws.userId });
    });
  });

  it("整理の記録は items の1件ずつ restoredAt を埋め、二重の戻しは null", async () => {
    const { ws, agent } = await owner();
    await withApp(async (app) => {
      const ev = await app.transaction((tx) =>
        insertEvolutionEvent(tx, ws.ctx, {
          agentId: agent.agentId,
          configChangeId: null,
          now: ago(DAY),
          items: [
            { type: "skill", id: "s1", label: "採点", restoredAt: null },
            { type: "rule", id: "r1", label: "メールを送る", restoredAt: null },
          ],
        }),
      );
      expect((await listRecentEvolutionEvents(app, ws.ctx, { since: ago(2 * DAY) })).map((e) => e.id)).toEqual([ev.id]);
      expect(await listRecentEvolutionEvents(app, ws.ctx, { since: NOW })).toEqual([]);
      const after = await app.transaction((tx) => markEvolutionItemRestored(tx, ws.ctx, ev.id, "rule", "r1", NOW));
      expect(after!.items).toEqual([
        { type: "skill", id: "s1", label: "採点", restoredAt: null },
        { type: "rule", id: "r1", label: "メールを送る", restoredAt: NOW.toISOString() },
      ]);
      expect(await app.transaction((tx) => markEvolutionItemRestored(tx, ws.ctx, ev.id, "rule", "r1", NOW))).toBeNull();
      expect(await app.transaction((tx) => markEvolutionItemRestored(tx, ws.ctx, ev.id, "skill", "zzz", NOW))).toBeNull();
      expect((await getEvolutionEvent(app, ws.ctx, ev.id))!.items[0]!.restoredAt).toBeNull();
    });
  });

  it("ruleLastMatchedAt は本番の rule_matched の判定だけを ruleId ごとの最後の時刻にする", async () => {
    const { db, ws, agent } = await setup();
    const live = await fxTask(db, ws, agent, { status: "completed", now: ago(5 * DAY) });
    const ins = (taskId: string, ruleId: string | null, at: Date, reason = "rule_matched") =>
      db.query(
        `INSERT INTO policy_decisions (workspace_id, task_id, subject_kind, subject, counters, flags, decision, reason_code, matched_rule_id, inputs_hash, kernel_version, created_at)
         VALUES ($1, $2, 'tool_call', '{}', '{}', '{}', 'allow', $3, $4, $5, 'k', $6)`,
        [ws.workspaceId, taskId, reason, ruleId, fxHash("d"), at],
      );
    await ins(live.taskId, "r1", ago(9 * DAY));
    await ins(live.taskId, "r1", ago(4 * DAY));
    await ins(live.taskId, "r2", ago(3 * DAY), "allowed");
    await ins(live.taskId, null, ago(DAY));
    const map = await ruleLastMatchedAt(db, ws.ctx, agent.agentId);
    expect([...map.entries()]).toEqual([["r1", ago(4 * DAY)]]);
  });
});
