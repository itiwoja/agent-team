// app の土台の問い合わせ（repo/app.ts）の試験（packages/db/src/repo/app.test.ts の WorkspaceDO 版）。
// ロールの権限・NOTIFY・ワークスペースをまたぐ話・所属（getMemberUser は D1）の試験は DO にないので落とした
import { describe, expect, it } from "vitest";
import { appendAuditLog } from "../../src/db/audit.ts";
import {
  appendWorkspaceEvent,
  applyToolClassification,
  engageKillSwitchTx,
  findAgentByName,
  findAgentJob,
  findAskBySeedKey,
  findIdempotencyRecord,
  findStoppedTasks,
  getAgent,
  getLatestWorkspacePolicy,
  getWorkspaceDayCostMicroUsd,
  insertAgentJob,
  insertAgentWithSnapshot,
  insertAsk,
  insertAskMember,
  insertWorkspacePolicyIfMissing,
  latestWorkspaceEventId,
  listAskMembers,
  listAuditLogs,
  listConnectors,
  listConnectorTools,
  listWorkspaceEventsAfter,
  releaseKillSwitchTx,
  saveIdempotencyRecord,
  workspaceEventExists,
} from "../../src/db/repo/app.ts";
import { all, isUniqueViolation, one, run } from "../../src/db/sqlite.ts";
import { getWorkspace } from "../../src/db/workspace.ts";
import { fxAgent, fxApproval, fxConnector, fxIntent, fxTask, fxUsage, inWorkspace } from "./fixtures.ts";

const NOW = new Date("2026-10-14T01:00:00.000Z");

describe("Kill Switch の DB の部分", () => {
  it("engageKillSwitchTx：終了していないタスクを halted・トークン失効、承認・未実行の Intent を expired、executing は残す。2回目は何もしない", async () => {
    await inWorkspace((db, ws) => {
      const conn = fxConnector(db);
      const agent = fxAgent(db);
      const running = fxTask(db, ws, agent, { status: "running" });
      const done = fxTask(db, ws, agent, { status: "completed" });
      const pending = fxIntent(db, { taskId: running.taskId, jobId: agent.jobId, connectorId: conn.connectorId });
      fxApproval(db, ws, { taskId: running.taskId, intentId: pending.intentId });
      const executing = fxIntent(db, { taskId: running.taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "executing" });
      const queued = fxTask(db, ws, agent, { status: "queued" });
      run(db, "UPDATE tasks SET task_token_hash = randomblob(32), task_token_expires_at = ? WHERE id = ?", NOW, running.taskId);

      const r = engageKillSwitchTx(db, { by: ws.userId, reason: "r", now: NOW });
      expect(r).toMatchObject({ alreadyEngaged: false, engagedAt: NOW, expiredIntentIds: [pending.intentId] });
      expect(r?.haltedTasks.map((t) => t.id)).toEqual([running.taskId, queued.taskId].sort());
      expect(r?.haltedTasks.find((t) => t.id === queued.taskId)).toMatchObject({ previousStatus: "queued", jobId: agent.jobId, agentId: agent.agentId });
      expect(r?.expiredApprovalIds).toHaveLength(1);
      const statuses = all<{ id: string; status: string; halt_reason: string | null; task_token_hash: unknown }>(
        db,
        {},
        "SELECT id, status, halt_reason, task_token_hash FROM tasks",
      );
      expect(Object.fromEntries(statuses.map((x) => [x.id, x.status]))).toEqual({
        [running.taskId]: "halted",
        [done.taskId]: "completed",
        [queued.taskId]: "halted",
      });
      expect(statuses.find((x) => x.id === running.taskId)).toMatchObject({ halt_reason: "kill_switch", task_token_hash: null });
      expect(one<{ status: string }>(db, {}, "SELECT status FROM action_intents WHERE id = ?", executing.intentId)?.status).toBe("executing");
      expect(getWorkspace(db)).toMatchObject({ kill_switch_engaged: true, kill_switch_engaged_at: NOW, kill_switch_engaged_by: ws.userId, kill_switch_reason: "r" });

      // 2回目は何もしない（冪等）
      const again = engageKillSwitchTx(db, { by: ws.userId, reason: "x", now: new Date(NOW.getTime() + 1000) });
      expect(again).toEqual({ alreadyEngaged: true, engagedAt: NOW, haltedTasks: [], expiredApprovalIds: [], expiredIntentIds: [] });
      expect(getWorkspace(db)?.kill_switch_reason).toBe("r");
    });
  });

  it("releaseKillSwitchTx：発動中なら外して時刻・人・理由を消す、発動中でなければ wasEngaged false", async () => {
    await inWorkspace(
      (db) => {
        expect(releaseKillSwitchTx(db, NOW)).toEqual({ wasEngaged: true });
        expect(releaseKillSwitchTx(db, NOW)).toEqual({ wasEngaged: false });
        expect(getWorkspace(db)).toMatchObject({ kill_switch_engaged: false, kill_switch_engaged_at: null, kill_switch_reason: null });
      },
      { killSwitchEngaged: true },
    );
  });

  it("findStoppedTasks：終了状態のタスクと Kill Switch", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const live = fxTask(db, ws, agent, { status: "running" });
      const ended = fxTask(db, ws, agent, { status: "cancelled" });
      expect(findStoppedTasks(db, [live.taskId, ended.taskId, "00000000-0000-4000-8000-000000000000"])).toEqual({
        killSwitchEngaged: false,
        terminalTaskIds: [ended.taskId],
      });
      expect(findStoppedTasks(db, [])).toEqual({ killSwitchEngaged: false, terminalTaskIds: [] });
      engageKillSwitchTx(db, { by: null, reason: null, now: NOW });
      expect(findStoppedTasks(db, [live.taskId]).killSwitchEngaged).toBe(true);
    });
  });
});

describe("ワークスペースの事象（SSE）", () => {
  it("appendWorkspaceEvent は行を足し、読み出しは id の昇順。type の形が違えば例外", async () => {
    await inWorkspace((db) => {
      expect(latestWorkspaceEventId(db)).toBe(0);
      const e1 = appendWorkspaceEvent(db, { type: "ask.updated", data: { n: 1 } }, NOW);
      const e2 = appendWorkspaceEvent(db, { type: "check.remove", data: "k" }, NOW);
      expect(e1).toMatchObject({ type: "ask.updated", data: { n: 1 }, created_at: NOW });
      expect(listWorkspaceEventsAfter(db, 0, 10).map((x) => x.id)).toEqual([e1.id, e2.id]);
      expect(listWorkspaceEventsAfter(db, e1.id, 10).map((x) => [x.type, x.data])).toEqual([["check.remove", "k"]]);
      expect(latestWorkspaceEventId(db)).toBe(e2.id);
      expect(workspaceEventExists(db, e1.id)).toBe(true);
      expect(workspaceEventExists(db, e2.id + 1)).toBe(false);
      expect(() => appendWorkspaceEvent(db, { type: "Bad", data: {} }, NOW)).toThrow(TypeError);
    });
  });

  it("ロールバックしたら行は残らない", async () => {
    await inWorkspace((db) => {
      expect(() =>
        db.transaction(() => {
          appendWorkspaceEvent(db, { type: "ask.updated", data: {} }, NOW);
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(latestWorkspaceEventId(db)).toBe(0);
    });
  });
});

describe("監査ログの一覧", () => {
  it("seq の降順・beforeSeq・影の行の除外（payload.enforced = false）・hasMore・絞り込み", async () => {
    await inWorkspace((db) => {
      appendAuditLog(db, { eventType: "decision.made", actorType: "system", actorId: "app", payload: { enforced: false } }, NOW);
      appendAuditLog(db, { eventType: "decision.made", actorType: "system", actorId: "app", payload: { enforced: true } }, NOW);
      appendAuditLog(db, { eventType: "decision.made", actorType: "system", actorId: "app", payload: { enforced: "false" } }, NOW);
      const r = listAuditLogs(db, { limit: 1, beforeSeq: null });
      expect(r.rows.map((x) => x.seq)).toEqual([3]);
      expect(r.hasMore).toBe(true);
      expect(listAuditLogs(db, { limit: 10, beforeSeq: 3 }).rows.map((x) => x.seq)).toEqual([1]);
      expect(listAuditLogs(db, { limit: 10, beforeSeq: null, eventTypes: ["workspace.created"] }).rows.map((x) => x.seq)).toEqual([1]);
      expect(listAuditLogs(db, { limit: 10, beforeSeq: null, from: NOW }).rows.map((x) => x.seq)).toEqual([3]);
    });
  });
});

describe("冪等性のキー", () => {
  it("保存・期限の内だけ見つかる・同じキーは上書き・キーの大文字小文字を区別しない", async () => {
    await inWorkspace((db) => {
      const key = "0B7B8C1E-2F2D-4B8A-9D0E-0A1B2C3D4E5F";
      saveIdempotencyRecord(db, { key, method: "POST", path: "/p", requestHash: "a".repeat(64), responseStatus: 200, responseBody: { ok: 1 } }, NOW);
      const found = findIdempotencyRecord(db, key.toLowerCase(), new Date(NOW.getTime() - 1));
      expect(found).toMatchObject({ key: key.toLowerCase(), method: "POST", path: "/p", response_status: 200, response_body: { ok: 1 }, created_at: NOW });
      expect(findIdempotencyRecord(db, key, NOW)).toBeNull();
      saveIdempotencyRecord(db, { key, method: "POST", path: "/q", requestHash: "b".repeat(64), responseStatus: 201, responseBody: [] }, NOW);
      expect(findIdempotencyRecord(db, key, new Date(0))).toMatchObject({ path: "/q", response_body: [] });
    });
  });
});

describe("オーナーの初期投入に使う行", () => {
  it("insertWorkspacePolicyIfMissing：どの版もなければ v1、あれば今のものを返す", async () => {
    await inWorkspace((db) => {
      expect(getLatestWorkspacePolicy(db)).toBeNull();
      const first = insertWorkspacePolicyIfMissing(db, { policy: { version: 1, a: 1 }, policyHash: "c".repeat(64), createdBy: null, now: NOW });
      expect(first).toMatchObject({ created: true, row: { version: 1, policy: { version: 1, a: 1 }, created_at: NOW } });
      const second = insertWorkspacePolicyIfMissing(db, { policy: { version: 1, a: 2 }, policyHash: "d".repeat(64), createdBy: null, now: NOW });
      expect(second).toMatchObject({ created: false, row: { policy: { version: 1, a: 1 } } });
      expect(getLatestWorkspacePolicy(db)?.policy_hash).toBe("c".repeat(64));
    });
  });

  it("applyToolClassification：違うときだけ書く（2回目・キーの順だけ違うときは false）。needs_review の行は触らない", async () => {
    await inWorkspace((db) => {
      const c = fxConnector(db, { tools: [{ name: "place_order", classification: "unclassified" }] });
      const toolId = c.tools.place_order!.id;
      const input = {
        classification: "write" as const,
        argRoles: { supplier_id: "destination", note: "content" },
        scope: null,
        verify: "none" as const,
        toolHash: `sha256:${"e".repeat(64)}` as const,
        classifiedBy: "system:seed",
        now: NOW,
      };
      expect(applyToolClassification(db, toolId, input)).toBe(true);
      expect(applyToolClassification(db, toolId, input)).toBe(false);
      expect(applyToolClassification(db, toolId, { ...input, argRoles: { note: "content", supplier_id: "destination" } })).toBe(false);
      const rows = listConnectorTools(db, [c.connectorId]);
      expect(rows[0]).toMatchObject({ classification: "write", arg_roles: { supplier_id: "destination" }, classified_by: "system:seed", classified_at: NOW });
      run(db, "UPDATE connector_tools SET status = 'needs_review' WHERE id = ?", toolId);
      expect(applyToolClassification(db, toolId, { ...input, classification: "read" })).toBe(false);
      expect(listConnectorTools(db)).toHaveLength(1);
      expect(listConnectors(db).map((x) => x.slug)).toEqual(["supplier"]);
    });
  });

  it("insertAgentWithSnapshot：エージェントと有効なスナップショットを作り current にする。findAgentByName は removed を除く。名前の重なりは一意の違反", async () => {
    await inWorkspace((db) => {
      const input = {
        slug: "a-12345678",
        name: "仕入れ係",
        nameSource: "suggested" as const,
        role: "assist" as const,
        status: "active" as const,
        definition: { version: 2, name: "仕入れ係" },
        effectivePolicies: {},
        clamped: [],
        ceilingsVersion: "2026-10-03.1",
        now: NOW,
      };
      const r = insertAgentWithSnapshot(db, input);
      expect(r.agent.current_snapshot_id).toBe(r.snapshot.id);
      expect(r.snapshot).toMatchObject({ status: "valid", source: "in_app", ceilings_version: "2026-10-03.1", definition: { version: 2, name: "仕入れ係" } });
      expect(getAgent(db, r.agent.id)?.name).toBe("仕入れ係");
      expect(findAgentByName(db, "仕入れ係")?.id).toBe(r.agent.id);
      let err: unknown;
      try {
        insertAgentWithSnapshot(db, { ...input, slug: "a-87654321" });
      } catch (e) {
        err = e;
      }
      expect(isUniqueViolation(err, "agents.name")).toBe(true);
      run(db, "UPDATE agents SET status = 'removed' WHERE id = ?", r.agent.id);
      expect(findAgentByName(db, "仕入れ係")).toBeNull();
    });
  });

  it("仕事・依頼・担当を作って引ける（用意した依頼の印・段の順）", async () => {
    await inWorkspace((db, ws) => {
      const a = fxAgent(db);
      const b = fxAgent(db);
      const job = insertAgentJob(db, { agentId: a.agentId, slug: "watch-news", kind: "watch", template: "watcher", status: "active", now: NOW });
      expect(findAgentJob(db, a.agentId, "watch-news")).toEqual(job);
      expect(findAgentJob(db, b.agentId, "watch-news")).toBeNull();
      const ask = insertAsk(db, {
        createdBy: ws.userId,
        text: "毎朝ニュースをまとめて",
        shape: "chain",
        status: "running",
        trigger: { type: "schedule", cron: "0 8 * * *", timezone: "Asia/Tokyo" },
        nextRunAt: NOW,
        formation: { members: 2 },
        seedKey: "seed-news",
        now: NOW,
      });
      expect(ask).toMatchObject({ trigger: { type: "schedule", cron: "0 8 * * *" }, next_run_at: NOW, formation: { members: 2 } });
      expect(findAskBySeedKey(db, "seed-news")?.id).toBe(ask.id);
      const second = insertAskMember(db, {
        askId: ask.id,
        agentId: b.agentId,
        jobId: b.jobId,
        position: 2,
        dependsOn: [1],
        isAggregator: false,
        isSpokesperson: true,
        isNew: false,
        summary: "まとめる",
        now: NOW,
      });
      expect(second).toMatchObject({ depends_on: [1], is_spokesperson: true, is_new: false });
      insertAskMember(db, {
        askId: ask.id,
        agentId: a.agentId,
        jobId: job.id,
        position: 1,
        dependsOn: [],
        isAggregator: false,
        isSpokesperson: false,
        isNew: true,
        summary: "集める",
        now: NOW,
      });
      expect(listAskMembers(db, ask.id).map((m) => m.position)).toEqual([1, 2]);
    });
  });
});

describe("表示に使う行", () => {
  it("getWorkspaceDayCostMicroUsd はタイムゾーンの今日だけを足す（整数のマイクロドル）", async () => {
    await inWorkspace((db) => {
      const agent = fxAgent(db);
      // 2026-10-14 の JST の0時は 2026-10-13T15:00Z
      fxUsage(db, { agentId: agent.agentId, costMicroUsd: 100_000, createdAt: new Date("2026-10-13T15:00:00.000Z") });
      fxUsage(db, { agentId: agent.agentId, costMicroUsd: 200_000, createdAt: new Date("2026-10-14T14:59:59.999Z") });
      fxUsage(db, { agentId: agent.agentId, costMicroUsd: 5_000_000, createdAt: new Date("2026-10-13T14:59:59.999Z") });
      expect(getWorkspaceDayCostMicroUsd(db, NOW, "Asia/Tokyo")).toBe(300_000);
      expect(getWorkspaceDayCostMicroUsd(db, NOW, "UTC")).toBe(200_000);
      expect(getWorkspaceDayCostMicroUsd(db, new Date("2026-10-13T14:00:00.000Z"), "Asia/Tokyo")).toBe(5_000_000);
      expect(getWorkspaceDayCostMicroUsd(db, new Date("2026-11-01T00:00:00Z"), "Asia/Tokyo")).toBe(0);
    });
  });
});
