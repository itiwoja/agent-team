// 0022（スキルの学習と整理）の問い合わせの試験（packages/db/src/repo/evolution.test.ts の WorkspaceDO 版）。
// ot_app のロールで流す話・ワークスペースをまたぐ話は落とした（DO の中の担当だけを見る）
import { describe, expect, it } from "vitest";
import { CODECS } from "../../src/db/codecs.ts";
import {
  applyPruneChange,
  applyRuleRestoreChange,
  decideSkillProposal,
  getEvolutionEvent,
  getSkillProposal,
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
  scanAgentsForPruning,
  scanAgentsForSkillLearning,
  touchSkillUsed,
} from "../../src/db/repo/evolution.ts";
import { insertAgentSkill, listAgentSkills } from "../../src/db/repo/sandbox.ts";
import { all, count, newId, one, run, type WsDb } from "../../src/db/sqlite.ts";
import type { AgentConfigChangeRow } from "../../src/db/types.ts";
import { fxAgent, fxHash, fxTask, inWorkspace, type FxAgent, type FxTaskOptions, type FxWorkspace } from "./fixtures.ts";

const NOW = new Date("2026-12-01T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DIGEST = fxHash("skill");

describe("スキル", () => {
  it("listAgentSkills は外したものを返さず、IncludingRemoved は返す。insertAgentSkill の ON CONFLICT は外した印を戻して上書きする", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const pack = insertAgentSkill(db, { agentId: agent.agentId, name: "採点", description: "d", body: "b", packId: "teacher", now: NOW });
      expect(pack.origin).toBe("pack");
      expect(pack.removed_at).toBeNull();
      insertAgentSkill(db, { agentId: agent.agentId, name: "要約", description: "d", body: "b", packId: null, now: NOW, origin: "learned", approvedBy: ws.userId, approvedAt: NOW, approvedDigest: DIGEST });
      markSkillsRemoved(db, [pack.id], NOW);
      expect(listAgentSkills(db, agent.agentId).map((s) => s.name)).toEqual(["要約"]);
      expect(listAgentSkillsIncludingRemoved(db, agent.agentId).map((s) => s.name)).toEqual(["採点", "要約"]);
      const again = insertAgentSkill(db, { agentId: agent.agentId, name: "採点", description: "新", body: "新", packId: null, now: NOW, origin: "learned", approvedBy: ws.userId, approvedAt: NOW, approvedDigest: DIGEST });
      expect(again).toMatchObject({ id: pack.id, description: "新", origin: "learned", removed_at: null, approved_digest: DIGEST, approved_at: NOW });
      expect(listAgentSkills(db, agent.agentId)).toHaveLength(2);
    });
  });

  it("learned は approved_digest と approved_at がないと入れられない（DB の CHECK）", async () => {
    await inWorkspace((db) => {
      const agent = fxAgent(db);
      expect(() => insertAgentSkill(db, { agentId: agent.agentId, name: "x", description: "d", body: "b", packId: null, now: NOW, origin: "learned" })).toThrow(
        /agent_skills_learned_chk/,
      );
    });
  });

  it("listStaleSkills は coalesce(last_used_at, approved_at, created_at) が before より前（ちょうどは含めない）。使うと外れず、戻すと last_used_at が now になる", async () => {
    await inWorkspace((db) => {
      const agent = fxAgent(db);
      const before = ago(30 * DAY);
      const edge = insertAgentSkill(db, { agentId: agent.agentId, name: "境目", description: "d", body: "b", packId: "p1", now: before });
      const over = insertAgentSkill(db, { agentId: agent.agentId, name: "古い", description: "d", body: "b", packId: "p1", now: new Date(before.getTime() - 1) });
      const used = insertAgentSkill(db, { agentId: agent.agentId, name: "使った", description: "d", body: "b", packId: "p1", now: ago(90 * DAY) });
      touchSkillUsed(db, used.id, ago(DAY));
      expect(listStaleSkills(db, before).map((s) => s.name)).toEqual(["古い"]);
      const removed = markSkillsRemoved(db, [over.id, edge.id], NOW);
      expect(removed).toHaveLength(2);
      expect(listStaleSkills(db, before)).toEqual([]);
      // 二重に外さない
      expect(markSkillsRemoved(db, [over.id], NOW)).toEqual([]);
      expect(markSkillsRemoved(db, [], NOW)).toEqual([]);
      const back = restoreSkill(db, over.id, NOW);
      expect(back).toMatchObject({ removed_at: null, last_used_at: NOW });
      expect(restoreSkill(db, over.id, NOW)).toBeNull();
    });
  });
});

describe("スキルの案", () => {
  it("proposed を保存し、決められるのは1回だけ（二重の決定は null）。skipped は一覧に出ず、lastSkillProposalAt に数える", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      expect(lastSkillProposalAt(db, agent.agentId)).toBeNull();
      const skipped = insertSkillProposal(db, { agentId: agent.agentId, status: "skipped", sourceTaskIds: [], now: ago(2 * DAY) });
      expect(skipped).toMatchObject({ status: "skipped", name: null, source_task_ids: [] });
      const p = insertSkillProposal(db, { agentId: agent.agentId, status: "proposed", name: "週報", description: "週報の手順", body: "# 手順", reason: "毎週同じ", sourceTaskIds: [], now: ago(DAY) });
      expect(listPendingSkillProposals(db).map((x) => x.id)).toEqual([p.id]);
      expect(listPendingSkillProposals(db, agent.agentId).map((x) => x.id)).toEqual([p.id]);
      expect(listPendingSkillProposals(db, "00000000-0000-4000-8000-000000000000")).toEqual([]);
      expect(lastSkillProposalAt(db, agent.agentId)).toEqual(ago(DAY));
      // proposed なのに本文がない案は作れない
      expect(() => insertSkillProposal(db, { agentId: agent.agentId, status: "proposed", sourceTaskIds: [], now: NOW })).toThrow(/skill_proposals_content_chk/);

      const decided = decideSkillProposal(db, { id: p.id, status: "approved", decidedBy: ws.userId, now: NOW });
      expect(decided).toMatchObject({ status: "approved", decided_by: ws.userId, decided_at: NOW });
      expect(decideSkillProposal(db, { id: p.id, status: "rejected", decidedBy: ws.userId, now: NOW })).toBeNull();
      expect(getSkillProposal(db, p.id)?.status).toBe("approved");
      expect(listPendingSkillProposals(db)).toEqual([]);
    });
  });
});

/** 報告つきのタスク（成功の数え方の材料） */
function withReport(db: WsDb, ws: FxWorkspace, a: FxAgent, o: FxTaskOptions): string {
  const { taskId } = fxTask(db, ws, a, o);
  run(db, "UPDATE tasks SET report = '報告', report_kind = 'normal', prompt = '指示' WHERE id = ?", taskId);
  return taskId;
}

describe("成功したタスクの数え方", () => {
  it("本番の成功（報告つき）だけを数え、最後の案より後・30日以内・minTasks 件以上の担当を返す", async () => {
    await inWorkspace((db, ws) => {
      const many = fxAgent(db, { name: "多い係" });
      const few = fxAgent(db, { name: "少ない係" });
      const old = fxAgent(db, { name: "古い係" });
      const proposed = fxAgent(db, { name: "案の後係" });
      for (let i = 1; i <= 3; i++) withReport(db, ws, many, { status: "succeeded", now: ago(i * DAY) });
      // 数えないもの：失敗
      fxTask(db, ws, few, { status: "failed", now: ago(DAY) });
      withReport(db, ws, few, { status: "succeeded", now: ago(DAY) });
      withReport(db, ws, few, { status: "succeeded", now: ago(DAY) });
      // 30日より前
      for (let i = 0; i < 3; i++) withReport(db, ws, old, { status: "completed", now: ago(31 * DAY + i) });
      // 最後の案より後が2件しかない
      for (let i = 1; i <= 4; i++) withReport(db, ws, proposed, { status: "succeeded", now: ago(i * DAY) });
      run(db, "INSERT INTO skill_proposals (id, agent_id, status, created_at) VALUES (?, ?, 'skipped', ?)", newId(), proposed.agentId, ago(2.5 * DAY));

      expect(scanAgentsForSkillLearning(db, NOW, { minTasks: 3, windowMs: 30 * DAY, limit: 10 })).toEqual([{ agentId: many.agentId }]);
      // minTasks を下げると、2件の担当・案の後に2件ある担当も入る（失敗の1件は数えない）
      expect(scanAgentsForSkillLearning(db, NOW, { minTasks: 2, limit: 10 })).toHaveLength(3);

      // 未決定の案（proposed）がある担当は、その後にタスクが増えても対象にしない（人が決めるまで次の案は作らない）
      run(db, "INSERT INTO skill_proposals (id, agent_id, status, name, description, body, created_at) VALUES (?, ?, 'proposed', '案', '説明', '本文', ?)", newId(), many.agentId, ago(10 * DAY));
      expect(scanAgentsForSkillLearning(db, NOW, { minTasks: 3, limit: 10 })).toEqual([]);
      run(db, "DELETE FROM skill_proposals WHERE agent_id = ?", many.agentId);

      const recent = listRecentLiveSucceededTasks(db, many.agentId, { since: ago(2.5 * DAY), limit: 5 });
      expect(recent.map((x) => x.instruction)).toEqual(["指示", "指示"]);
      expect(recent[0]).toMatchObject({ report: "報告", finishedAt: ago(DAY) });
    });
  });

  it("試し実行のタスクは listRecentLiveSucceededTasks に出ない", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const taskId = withReport(db, ws, agent, { status: "succeeded", now: ago(DAY) });
      expect(listRecentLiveSucceededTasks(db, agent.agentId, { since: ago(10 * DAY), limit: 5 })).toHaveLength(1);
      // 試し実行（is_dry_run）にすると外れる
      run(db, "UPDATE tasks SET is_dry_run = 1, trigger_type = 'dry_run' WHERE id = ?", taskId);
      expect(listRecentLiveSucceededTasks(db, agent.agentId, { since: ago(10 * DAY), limit: 5 })).toHaveLength(0);
    });
  });
});

describe("整理の走査", () => {
  it("外す候補のスキルかルールを持つ担当だけ返す", async () => {
    await inWorkspace((db) => {
      const stale = fxAgent(db, { name: "古いスキル係" });
      const fresh = fxAgent(db, { name: "新しいスキル係" });
      const ruled = fxAgent(db, { name: "ルール係" });
      fxAgent(db, { name: "何もない係" });
      insertAgentSkill(db, { agentId: stale.agentId, name: "s", description: "d", body: "b", packId: "p1", now: ago(31 * DAY) });
      insertAgentSkill(db, { agentId: fresh.agentId, name: "s", description: "d", body: "b", packId: "p1", now: ago(DAY) });
      // スナップショットは更新できないので、ルールつきの定義を新しく足して今のものにする
      const snapId = newId();
      run(
        db,
        `INSERT INTO agent_snapshots (id, agent_id, status, definition, effective_policies, ceilings_version) VALUES (?, ?, 'valid', ?, '{}', '0-H.1')`,
        snapId,
        ruled.agentId,
        { version: 2, name: "ルール係", rules: [{ id: "r1" }] },
      );
      run(db, "UPDATE agents SET current_snapshot_id = ? WHERE id = ?", snapId, ruled.agentId);
      const r = scanAgentsForPruning(db, NOW, { limit: 10 });
      expect(r.map((x) => x.agentId).sort()).toEqual([stale.agentId, ruled.agentId].sort());
    });
  });
});

describe("ルールの整理と記録", () => {
  function input(agent: FxAgent, expected: string) {
    return {
      agentId: agent.agentId,
      patch: [{ op: "remove", path: "/rules/0" }],
      expectedSnapshotId: expected,
      definition: { version: 2, name: "x", rules: [] },
      effectivePolicies: { [agent.jobSlug]: { policy: { version: 1 }, hash: agent.policyHash } } as never,
      clamped: [],
      ceilingsVersion: "0-H.1",
      now: NOW,
    };
  }

  it("applyPruneChange は prune・narrow・システムの決定で保存し、スナップショットがずれていたら null", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const done = applyPruneChange(db, { ...input(agent, agent.snapshotId), removedRuleIds: ["r1"] });
      expect(done).not.toBeNull();
      const ch = one<AgentConfigChangeRow>(db, CODECS.agent_config_changes, "SELECT * FROM agent_config_changes WHERE id = ?", done!.changeId);
      expect(ch).toMatchObject({ origin: "prune", classification: "narrow", widened_items: null, decided_by: null, status: "applied", snapshot_id: done!.snapshotId, decided_at: NOW });
      expect(one<{ s: string }>(db, {}, "SELECT current_snapshot_id AS s FROM agents WHERE id = ?", agent.agentId)?.s).toBe(done!.snapshotId);
      const log = all<{ payload: { removedRuleIds: string[] } }>(db, CODECS.audit_logs, "SELECT payload FROM audit_logs WHERE event_type = 'agent.config.narrowed'");
      expect(log).toHaveLength(1);
      expect(log[0]!.payload.removedRuleIds).toEqual(["r1"]);
      // 期待したスナップショットから動いている（古いまま）なら何も書かない
      const before = count(db, "SELECT count(*) FROM agent_config_changes WHERE agent_id = ?", agent.agentId);
      expect(applyPruneChange(db, { ...input(agent, agent.snapshotId), removedRuleIds: ["r1"] })).toBeNull();
      expect(count(db, "SELECT count(*) FROM agent_config_changes WHERE agent_id = ?", agent.agentId)).toBe(before);

      // 戻す：revert・widen・reverts_change_id
      const restored = applyRuleRestoreChange(db, {
        ...input(agent, done!.snapshotId),
        patch: [{ op: "add", path: "/rules/-", value: { id: "r1" } }],
        widenedItems: [{ rule: "r1" }],
        revertsChangeId: done!.changeId,
        ruleId: "r1",
        decidedBy: ws.userId,
      });
      expect(restored).not.toBeNull();
      const rc = one<AgentConfigChangeRow>(db, CODECS.agent_config_changes, "SELECT * FROM agent_config_changes WHERE id = ?", restored!.changeId);
      expect(rc).toMatchObject({ origin: "revert", classification: "widen", reverts_change_id: done!.changeId, decided_by: ws.userId, widened_items: [{ rule: "r1" }] });
      expect(count(db, "SELECT count(*) FROM audit_logs WHERE event_type = 'agent.config.widened'")).toBe(1);
    });
  });

  it("整理の記録は items の1件ずつ restoredAt を埋め、二重の戻しは null", async () => {
    await inWorkspace((db) => {
      const agent = fxAgent(db);
      const ev = insertEvolutionEvent(db, {
        agentId: agent.agentId,
        configChangeId: null,
        now: ago(DAY),
        items: [
          { type: "skill", id: "s1", label: "採点", restoredAt: null },
          { type: "rule", id: "r1", label: "メールを送る", restoredAt: null },
        ],
      });
      expect(listRecentEvolutionEvents(db, { since: ago(2 * DAY) }).map((e) => e.id)).toEqual([ev.id]);
      expect(listRecentEvolutionEvents(db, { since: NOW })).toEqual([]);
      const after = markEvolutionItemRestored(db, ev.id, "rule", "r1", NOW);
      expect(after!.items).toEqual([
        { type: "skill", id: "s1", label: "採点", restoredAt: null },
        { type: "rule", id: "r1", label: "メールを送る", restoredAt: NOW.toISOString() },
      ]);
      expect(markEvolutionItemRestored(db, ev.id, "rule", "r1", NOW)).toBeNull();
      expect(markEvolutionItemRestored(db, ev.id, "skill", "zzz", NOW)).toBeNull();
      expect(markEvolutionItemRestored(db, newId(), "skill", "s1", NOW)).toBeNull();
      expect(getEvolutionEvent(db, ev.id)!.items[0]!.restoredAt).toBeNull();
    });
  });

  it("ruleLastMatchedAt は本番の rule_matched の判定だけを ruleId ごとの最後の時刻にする", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const live = fxTask(db, ws, agent, { status: "completed", now: ago(5 * DAY) });
      const dry = fxTask(db, ws, agent, { status: "completed", dryRun: true, now: ago(5 * DAY) });
      const ins = (taskId: string, ruleId: string | null, at: Date, reason = "rule_matched") =>
        run(
          db,
          `INSERT INTO policy_decisions (id, task_id, subject_kind, subject, counters, flags, decision, reason_code, matched_rule_id, inputs_hash, kernel_version, created_at)
           VALUES (?, ?, 'tool_call', '{}', '{}', '{}', 'allow', ?, ?, ?, 'k', ?)`,
          newId(),
          taskId,
          reason,
          ruleId,
          fxHash("d"),
          at,
        );
      ins(live.taskId, "r1", ago(9 * DAY));
      ins(live.taskId, "r1", ago(4 * DAY));
      ins(live.taskId, "r2", ago(3 * DAY), "allowed");
      ins(live.taskId, null, ago(DAY));
      ins(dry.taskId, "r3", ago(DAY));
      expect([...ruleLastMatchedAt(db, agent.agentId).entries()]).toEqual([["r1", ago(4 * DAY)]]);
    });
  });
});
