// app の土台の問い合わせ（repo/app.ts）の試験。権限の試験は ot_app のロールでつないで流す（本番の app と同じ権限）
import { afterEach, describe, expect, it } from "vitest";
import { appendAuditLog } from "../audit.ts";
import type { Db } from "../client.ts";
import {
  fxAgent,
  fxApproval,
  fxConnector,
  fxIntent,
  fxTask,
  fxWorkspace,
  openRoleDb,
  useTestDb,
} from "../testing.ts";
import {
  applyToolClassification,
  appendWorkspaceEvent,
  engageKillSwitchTx,
  findAgentByName,
  findIdempotencyRecord,
  findStoppedTasks,
  getLatestWorkspacePolicy,
  getMemberUser,
  getWorkspaceDayCostUsd,
  insertAgentWithSnapshot,
  insertWorkspacePolicyIfMissing,
  latestWorkspaceEventId,
  listAuditLogs,
  listConnectorTools,
  listWorkspaceEventsAfter,
  lockIdempotencyKey,
  releaseKillSwitchTx,
  saveIdempotencyRecord,
  WORKSPACE_EVENTS_CHANNEL,
  workspaceEventExists,
} from "./app.ts";

const T = useTestDb();
const NOW = new Date("2026-10-14T01:00:00.000Z");
const roleDbs: Db[] = [];
afterEach(async () => {
  for (const d of roleDbs.splice(0)) await d.close();
});
async function asApp(url: string): Promise<Db> {
  const d = await openRoleDb(url, "ot_app");
  roleDbs.push(d);
  return d;
}

describe("Kill Switch の DB の部分", () => {
  it("engageKillSwitchTx：終了していないタスクを halted・トークン失効、承認・未実行の Intent を expired、executing は残す（ot_app の権限で通る）", async () => {
    const { db, url } = T();
    const ws = await fxWorkspace(db);
    const conn = await fxConnector(db, ws);
    const agent = await fxAgent(db, ws);
    const running = await fxTask(db, ws, agent, { status: "running" });
    const done = await fxTask(db, ws, agent, { status: "completed" });
    const pending = await fxIntent(db, ws, { taskId: running.taskId, jobId: agent.jobId, connectorId: conn.connectorId });
    await fxApproval(db, ws, { taskId: running.taskId, intentId: pending.intentId });
    const executing = await fxIntent(db, ws, { taskId: running.taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "executing" });
    const queued = await fxTask(db, ws, agent, { status: "queued" });

    const app = await asApp(url);
    const r = await app.transaction((tx) => engageKillSwitchTx(tx, ws.ctx, { by: ws.userId, reason: "r", now: NOW }));
    expect(r).toMatchObject({ alreadyEngaged: false, engagedAt: NOW, expiredIntentIds: [pending.intentId] });
    expect(r?.haltedTasks.map((t) => t.id)).toEqual([running.taskId, queued.taskId].sort());
    expect(r?.haltedTasks.find((t) => t.id === queued.taskId)).toMatchObject({ previousStatus: "queued" });
    expect(r?.expiredApprovalIds).toHaveLength(1);
    const statuses = await db.query<{ id: string; status: string }>("SELECT id, status FROM tasks ORDER BY id");
    expect(Object.fromEntries(statuses.rows.map((x) => [x.id, x.status]))).toEqual({
      [running.taskId]: "halted",
      [done.taskId]: "completed",
      [queued.taskId]: "halted",
    });
    expect((await db.query<{ status: string }>("SELECT status FROM action_intents WHERE id = $1", [executing.intentId])).rows[0]?.status).toBe("executing");

    // 2回目は何もしない（冪等）
    const again = await app.transaction((tx) => engageKillSwitchTx(tx, ws.ctx, { by: ws.userId, reason: "x", now: new Date(NOW.getTime() + 1000) }));
    expect(again).toEqual({ alreadyEngaged: true, engagedAt: NOW, haltedTasks: [], expiredApprovalIds: [], expiredIntentIds: [] });
    expect((await db.query<{ kill_switch_reason: string }>("SELECT kill_switch_reason FROM workspaces")).rows[0]?.kill_switch_reason).toBe("r");
  });

  it("releaseKillSwitchTx：発動中なら外して時刻・人・理由を消す、発動中でなければ wasEngaged false。ワークスペースがなければ null", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { killSwitchEngaged: true });
    expect(await db.transaction((tx) => releaseKillSwitchTx(tx, ws.ctx, NOW))).toEqual({ wasEngaged: true });
    expect(await db.transaction((tx) => releaseKillSwitchTx(tx, ws.ctx, NOW))).toEqual({ wasEngaged: false });
    const row = await db.query("SELECT kill_switch_engaged, kill_switch_engaged_at, kill_switch_reason FROM workspaces");
    expect(row.rows[0]).toEqual({ kill_switch_engaged: false, kill_switch_engaged_at: null, kill_switch_reason: null });
    const missing = { workspaceId: "00000000-0000-4000-8000-000000000000", kind: "owner" as const, userId: null };
    expect(await db.transaction((tx) => releaseKillSwitchTx(tx, missing, NOW))).toBeNull();
    expect(await db.transaction((tx) => engageKillSwitchTx(tx, missing, { by: null, reason: null, now: NOW }))).toBeNull();
  });

  it("findStoppedTasks：終了状態のタスクと Kill Switch。ほかのワークスペースのタスクは見ない、ワークスペースが消えていたら全部", async () => {
    const { db } = T();
    const a = await fxWorkspace(db);
    const b = await fxWorkspace(db, { second: true });
    const agentA = await fxAgent(db, a);
    const agentB = await fxAgent(db, b);
    const live = await fxTask(db, a, agentA, { status: "running" });
    const ended = await fxTask(db, a, agentA, { status: "cancelled" });
    const foreign = await fxTask(db, b, agentB, { status: "failed" });
    expect(await findStoppedTasks(db, a.ctx, [live.taskId, ended.taskId, foreign.taskId])).toEqual({ killSwitchEngaged: false, terminalTaskIds: [ended.taskId] });
    expect(await findStoppedTasks(db, a.ctx, [])).toEqual({ killSwitchEngaged: false, terminalTaskIds: [] });
    const gone = { workspaceId: "00000000-0000-4000-8000-000000000000", kind: "owner" as const, userId: null };
    expect(await findStoppedTasks(db, gone, [live.taskId])).toEqual({ killSwitchEngaged: true, terminalTaskIds: [live.taskId] });
  });
});

describe("ワークスペースの事象（SSE）", () => {
  it("appendWorkspaceEvent は行を足し、コミットで '<ws>:<id>' を NOTIFY。読み出しはワークスペースで絞って id の昇順（ot_app の権限で通る）", async () => {
    const { db, url } = T();
    const a = await fxWorkspace(db);
    const b = await fxWorkspace(db, { second: true });
    const app = await asApp(url);
    const got: string[] = [];
    const l = await db.listen(WORKSPACE_EVENTS_CHANNEL, (p) => got.push(p));
    try {
      const e1 = await app.transaction((tx) => appendWorkspaceEvent(tx, a.ctx, { type: "ask.updated", data: { n: 1 } }, NOW));
      await app.transaction((tx) => appendWorkspaceEvent(tx, b.ctx, { type: "ask.updated", data: { n: 2 } }, NOW));
      const e3 = await app.transaction((tx) => appendWorkspaceEvent(tx, a.ctx, { type: "check.remove", data: { key: "k" } }, NOW));
      for (let i = 0; i < 50 && got.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
      expect(got[0]).toBe(`${a.workspaceId}:${e1.id}`);
      expect((await listWorkspaceEventsAfter(app, a.ctx, 0, 10)).map((x) => x.id)).toEqual([e1.id, e3.id]);
      expect((await listWorkspaceEventsAfter(app, a.ctx, e1.id, 10)).map((x) => [x.type, x.data])).toEqual([["check.remove", { key: "k" }]]);
      expect(await latestWorkspaceEventId(app, a.ctx)).toBe(e3.id);
      expect(await workspaceEventExists(app, a.ctx, e1.id)).toBe(true);
      expect(await workspaceEventExists(app, b.ctx, e1.id)).toBe(false);
      expect(await latestWorkspaceEventId(app, { ...a.ctx, workspaceId: "00000000-0000-4000-8000-000000000000" })).toBe(0);
    } finally {
      await l.unlisten();
    }
  });

  it("ロールバックしたら行も通知も残らない", async () => {
    const { db } = T();
    const a = await fxWorkspace(db);
    const got: string[] = [];
    const l = await db.listen(WORKSPACE_EVENTS_CHANNEL, (p) => got.push(p));
    try {
      await db
        .transaction(async (tx) => {
          await appendWorkspaceEvent(tx, a.ctx, { type: "ask.updated", data: {} }, NOW);
          throw new Error("rollback");
        })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
      expect(got).toEqual([]);
      expect(await latestWorkspaceEventId(db, a.ctx)).toBe(0);
    } finally {
      await l.unlisten();
    }
  });
});

describe("監査ログの一覧", () => {
  it("seq の降順・beforeSeq・0024 より前の影の行の除外（payload.enforced = false）・hasMore", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { audit: true });
    await db.transaction(async (tx) => {
      await appendAuditLog(tx, ws.workspaceId, { eventType: "decision.made", actorType: "system", actorId: "app", payload: { enforced: false } }, NOW);
      await appendAuditLog(tx, ws.workspaceId, { eventType: "decision.made", actorType: "system", actorId: "app", payload: { enforced: true } }, NOW);
    });
    const r = await listAuditLogs(db, ws.ctx, { limit: 1, beforeSeq: null });
    expect(r.rows.map((x) => x.seq)).toEqual([3]);
    expect(r.hasMore).toBe(true);
    expect((await listAuditLogs(db, ws.ctx, { limit: 10, beforeSeq: 3 })).rows.map((x) => x.seq)).toEqual([1]);
  });
});

describe("冪等性のキー", () => {
  it("保存・24時間の内だけ見つかる・同じキーは上書き・ワークスペースで分かれる", async () => {
    const { db } = T();
    const a = await fxWorkspace(db);
    const b = await fxWorkspace(db, { second: true });
    const key = "0B7B8C1E-2F2D-4B8A-9D0E-0A1B2C3D4E5F";
    await db.transaction(async (tx) => {
      await lockIdempotencyKey(tx, a.ctx, key);
      await saveIdempotencyRecord(tx, a.ctx, { key, method: "POST", path: "/p", requestHash: "a".repeat(64), responseStatus: 200, responseBody: { ok: 1 } }, NOW);
    });
    const found = await findIdempotencyRecord(db, a.ctx, key.toLowerCase(), new Date(NOW.getTime() - 1));
    expect(found).toMatchObject({ method: "POST", path: "/p", response_status: 200, response_body: { ok: 1 } });
    expect(await findIdempotencyRecord(db, a.ctx, key, NOW)).toBeNull();
    expect(await findIdempotencyRecord(db, b.ctx, key, new Date(0))).toBeNull();
    await db.transaction((tx) =>
      saveIdempotencyRecord(tx, a.ctx, { key, method: "POST", path: "/q", requestHash: "b".repeat(64), responseStatus: 201, responseBody: [] }, NOW),
    );
    expect((await findIdempotencyRecord(db, a.ctx, key, new Date(0)))?.path).toBe("/q");
  });
});

describe("オーナーの初期投入に使う行", () => {
  it("insertWorkspacePolicyIfMissing：どの版もなければ v1、あれば今のものを返す（ot_app の権限で通る）", async () => {
    const { db, url } = T();
    const ws = await fxWorkspace(db);
    const app = await asApp(url);
    const first = await app.transaction((tx) => insertWorkspacePolicyIfMissing(tx, ws.ctx, { policy: { version: 1, a: 1 }, policyHash: "c".repeat(64), createdBy: null, now: NOW }));
    expect(first).toMatchObject({ created: true, row: { version: 1, policy: { version: 1, a: 1 } } });
    const second = await app.transaction((tx) => insertWorkspacePolicyIfMissing(tx, ws.ctx, { policy: { version: 1, a: 2 }, policyHash: "d".repeat(64), createdBy: null, now: NOW }));
    expect(second).toMatchObject({ created: false, row: { policy: { version: 1, a: 1 } } });
    expect((await getLatestWorkspacePolicy(app, ws.ctx))?.policy_hash).toBe("c".repeat(64));
  });


  it("applyToolClassification：違うときだけ書く（2回目は false）。needs_review の行は触らない", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const c = await fxConnector(db, ws, { tools: [{ name: "place_order", classification: "unclassified" }] });
    const toolId = c.tools.place_order!.id;
    const input = { classification: "write" as const, argRoles: { supplier_id: "destination" }, scope: null, verify: "none" as const, toolHash: `sha256:${"e".repeat(64)}` as const, classifiedBy: "system:seed", now: NOW };
    expect(await db.transaction((tx) => applyToolClassification(tx, ws.ctx, toolId, input))).toBe(true);
    expect(await db.transaction((tx) => applyToolClassification(tx, ws.ctx, toolId, input))).toBe(false);
    const rows = await listConnectorTools(db, ws.ctx, [c.connectorId]);
    expect(rows[0]).toMatchObject({ classification: "write", arg_roles: { supplier_id: "destination" }, classified_by: "system:seed" });
    await db.query("UPDATE connector_tools SET status = 'needs_review' WHERE id = $1", [toolId]);
    expect(await db.transaction((tx) => applyToolClassification(tx, ws.ctx, toolId, { ...input, classification: "read" }))).toBe(false);
  });

  it("insertAgentWithSnapshot：エージェントと有効なスナップショットを作り current にする。findAgentByName は removed を除く（ot_app の権限で通る）", async () => {
    const { db, url } = T();
    const ws = await fxWorkspace(db);
    const app = await asApp(url);
    const r = await app.transaction((tx) =>
      insertAgentWithSnapshot(tx, ws.ctx, {
        slug: "a-12345678",
        name: "仕入れ係",
        nameSource: "suggested",
        role: "assist",
        status: "active",
        definition: { version: 2, name: "仕入れ係" },
        effectivePolicies: {},
        clamped: [],
        ceilingsVersion: "2026-10-03.1",
        now: NOW,
      }),
    );
    expect(r.agent.current_snapshot_id).toBe(r.snapshot.id);
    expect(r.snapshot).toMatchObject({ status: "valid", source: "in_app", ceilings_version: "2026-10-03.1" });
    expect((await findAgentByName(app, ws.ctx, "仕入れ係"))?.id).toBe(r.agent.id);
    await db.query("UPDATE agents SET status = 'removed' WHERE id = $1", [r.agent.id]);
    expect(await findAgentByName(app, ws.ctx, "仕入れ係")).toBeNull();
  });
});

describe("表示に使う行", () => {
  it("getMemberUser はそのワークスペースの所属だけ。getWorkspaceDayCostUsd はタイムゾーンの今日だけを足す", async () => {
    const { db } = T();
    const a = await fxWorkspace(db);
    const b = await fxWorkspace(db, { second: true });
    expect(await getMemberUser(db, a.ctx, a.userId)).toMatchObject({ id: a.userId, role: "owner" });
    expect(await getMemberUser(db, a.ctx, b.userId)).toBeNull();
    const agent = await fxAgent(db, a);
    const insert = (usd: string, at: Date) =>
      db.query(
        `INSERT INTO usage_records (workspace_id, agent_id, provider, model, phase, input_tokens, output_tokens, estimated_cost_usd, cost_usd, latency_ms, prompt_hash, created_at)
         VALUES ($1, $2, 'google', 'm', 'plan', 1, 1, $3, $3, 1, 'h', $4)`,
        [a.workspaceId, agent.agentId, usd, at],
      );
    // 2026-10-14 の JST の0時は 2026-10-13T15:00Z
    await insert("0.100000", new Date("2026-10-13T15:00:00.000Z"));
    await insert("0.200000", new Date("2026-10-14T14:59:59.999Z"));
    await insert("5.000000", new Date("2026-10-13T14:59:59.999Z"));
    expect(await getWorkspaceDayCostUsd(db, a.ctx, NOW, "Asia/Tokyo")).toBe("0.300000");
    expect(await getWorkspaceDayCostUsd(db, b.ctx, NOW, "Asia/Tokyo")).toBe("0.000000");
  });
});
