// エージェントの一覧（repo/agents.ts）の試験。Postgres 版には試験がなかったので、出している関数ごとに主な流れと守り（removed・試し実行を数えない）を試す
import { describe, expect, it } from "vitest";
import { listAgentAsks, listAgentJobs, listAgentLibrary } from "../../src/db/repo/agents.ts";
import { newId, run } from "../../src/db/sqlite.ts";
import { FIXED_NOW, fxAgent, fxAsk, fxAskMember, fxTask, inWorkspace } from "./fixtures.ts";

const NOW = FIXED_NOW;
const at = (s: number) => new Date(NOW.getTime() + s * 1000);

describe("エージェントの一覧", () => {
  it("listAgentLibrary：removed を除き、最後に動いた順。数・動いているか・使い回し・生まれた依頼・ルール・スキル", async () => {
    await inWorkspace((db, ws) => {
      const busy = fxAgent(db, { name: "仕入れ係" });
      const idle = fxAgent(db, { name: "受信箱係" });
      const gone = fxAgent(db, { name: "消えた係" });
      run(db, "UPDATE agents SET created_at = ? WHERE id = ?", at(-100), busy.agentId);
      run(db, "UPDATE agents SET created_at = ? WHERE id = ?", at(-50), idle.agentId);
      run(db, "UPDATE agents SET status = 'removed' WHERE id = ?", gone.agentId);

      const ask1 = fxAsk(db, ws).askId;
      const ask2 = fxAsk(db, ws).askId;
      run(db, "UPDATE asks SET created_at = ? WHERE id = ?", at(-90), ask1);
      run(db, "UPDATE asks SET created_at = ? WHERE id = ?", at(-80), ask2);
      fxAskMember(db, { askId: ask1, agent: busy, position: 1 });
      const job2 = newId();
      run(db, "INSERT INTO agent_jobs (id, agent_id, slug, kind, template) VALUES (?, ?, 'second', 'once', 'assistant')", job2, busy.agentId);
      fxAskMember(db, { askId: ask2, agent: { ...busy, jobId: job2 }, position: 1 });
      run(db, "UPDATE ask_members SET is_new = 0 WHERE ask_id = ?", ask2);

      fxTask(db, ws, busy, { status: "completed", now: at(10) });
      fxTask(db, ws, busy, { status: "awaiting_approval", now: at(5) });
      fxTask(db, ws, busy, { status: "running", dryRun: true, now: at(20) });
      fxTask(db, ws, idle, { status: "running", dryRun: true, now: at(30) });
      run(
        db,
        `INSERT INTO agent_config_changes (id, agent_id, origin, patch, classification, widened_items, status, snapshot_id, decided_at)
         VALUES (?, ?, 'approval_rule', '[]', 'widen', '[]', 'applied', ?, ?)`,
        newId(),
        busy.agentId,
        busy.snapshotId,
        NOW,
      );
      run(db, "INSERT INTO agent_skills (id, agent_id, name, description, body) VALUES (?, ?, 's', 'd', 'b')", newId(), busy.agentId);

      const rows = listAgentLibrary(db);
      expect(rows.map((r) => r.agent.name)).toEqual(["仕入れ係", "受信箱係"]);
      expect(rows[0]).toMatchObject({
        jobCount: 2,
        askCount: 2,
        taskCount: 2,
        lastActiveAt: at(10),
        running: false,
        awaitingApproval: true,
        reuseCount: 1,
        bornAskId: ask1,
        allowedRuleCount: 1,
        skillCount: 1,
      });
      // 試し実行しかない担当は、数えるタスクがない（動いた時刻は作った時刻で並ぶ）
      expect(rows[1]).toMatchObject({ jobCount: 1, askCount: 0, taskCount: 0, lastActiveAt: null, running: false, awaitingApproval: false, bornAskId: null });
      expect(rows[1]!.agent.created_at).toEqual(at(-50));
    });
  });

  it("listAgentAsks：担当ごとに新しい順で perAgent 件。listAgentJobs：作った順", async () => {
    await inWorkspace((db, ws) => {
      const a = fxAgent(db);
      const b = fxAgent(db);
      const asks = [0, 1, 2].map((i) => {
        const { askId } = fxAsk(db, ws, { text: `依頼${i}` });
        run(db, "UPDATE asks SET created_at = ? WHERE id = ?", at(i), askId);
        return askId;
      });
      const jobs = asks.map((_, i) => {
        if (i === 0) return a.jobId;
        const id = newId();
        run(db, "INSERT INTO agent_jobs (id, agent_id, slug, kind, template, created_at) VALUES (?, ?, ?, 'once', 'assistant', ?)", id, a.agentId, `job-${i}`, at(i));
        return id;
      });
      asks.forEach((askId, i) => fxAskMember(db, { askId, agent: { ...a, jobId: jobs[i]! }, position: 1, isSpokesperson: i === 2 }));
      fxAskMember(db, { askId: asks[0]!, agent: b, position: 2 });

      const rows = listAgentAsks(db, [a.agentId, b.agentId], 2);
      expect(rows.map((r) => [r.agent_id, r.ask_text])).toEqual(
        [
          [a.agentId, "依頼2"],
          [a.agentId, "依頼1"],
          [b.agentId, "依頼0"],
        ].sort((x, y) => (x[0]! < y[0]! ? -1 : x[0]! > y[0]! ? 1 : 0)),
      );
      const top = rows.find((r) => r.ask_text === "依頼2")!;
      expect(top).toMatchObject({ ask_status: "running", is_spokesperson: true, is_new: true, is_aggregator: false, position: 1, ask_created_at: at(2) });
      expect(listAgentAsks(db, [], 2)).toEqual([]);

      run(db, "UPDATE agent_jobs SET created_at = ? WHERE id = ?", at(-1), a.jobId);
      expect(listAgentJobs(db, [a.agentId]).map((j) => j.id)).toEqual(jobs);
      expect(listAgentJobs(db, [b.agentId])[0]).toMatchObject({ id: b.jobId, slug: "purchase", kind: "recurring", template: "assistant", status: "active" });
      expect(listAgentJobs(db, [])).toEqual([]);
    });
  });
});
