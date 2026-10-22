// エージェントの一覧（GET /api/v1/agents）の試験：順番の依頼（受信箱係 → 仕入れ係。check/test-helpers.ts）の担当がライブラリに並び、別のワークスペースの担当は出ない
import { useTestDb } from "@open-team/db/testing";
import { describe, expect, it } from "vitest";
import { AgentLibraryResponseSchema } from "../agents/contract.ts";
import { insertCheckMark } from "@open-team/db/check";
import { CheckResponse } from "../check/contract.ts";
import { call, checkHarness, enterWithPendingApproval } from "../check/test-helpers.ts";
import { send, signInGuest } from "../test-helpers.ts";

const T = useTestDb();

describe("GET /agents", () => {
  it("依頼の担当が、関わった依頼・仕事つきで並ぶ。確認待ちの仕入れ係が先", async () => {
    const { db } = T();
    const { t } = checkHarness(db);
    const g = await enterWithPendingApproval(t);
    const res = await send(t, "GET", "/api/v1/agents", { cookie: g.cookie });
    expect(res.status).toBe(200);
    const body = AgentLibraryResponseSchema.parse(await res.json());
    expect(body.limit).toBe(20);
    expect(body.count).toBe(body.items.length);
    const names = body.items.map((a) => a.name);
    expect(names).toContain("受信箱係");
    expect(names).toContain("仕入れ係");

    const buyer = body.items.find((a) => a.name === "仕入れ係")!;
    const inbox = body.items.find((a) => a.name === "受信箱係")!;
    // 仕入れ係は送る前の確認で止まっている（確認待ち）。受信箱係は済み（待機中）
    expect(buyer).toMatchObject({ activity: "awaiting_approval", activityText: "確認待ち", status: "active", disabledReason: null });
    expect(inbox).toMatchObject({ activity: "idle", activityText: "待機中" });
    // 本番のタスクが数えられ、最後に動いた時刻がある
    expect(buyer.taskCount).toBeGreaterThanOrEqual(1);
    expect(buyer.lastActiveAt).not.toBeNull();
    // 関わった依頼は順番の依頼で、窓口は仕入れ係、段の番号は 受信箱係 1 → 仕入れ係 2
    expect(buyer.asks.map((k) => [k.askId, k.isSpokesperson, k.position])).toEqual([[g.askId, true, 2]]);
    expect(inbox.asks.map((k) => [k.askId, k.isSpokesperson, k.position])).toEqual([[g.askId, false, 1]]);
    expect(buyer.askCount).toBe(1);
    expect(buyer.jobCount).toBe(buyer.jobs.length);
    expect(buyer.jobs.length).toBeGreaterThanOrEqual(1);
    for (const j of buyer.jobs) expect(j.kindLabel).not.toBe("");
    // 最後に動いた順：確認待ちで止まっている仕入れ係のほうが新しい
    expect(names.indexOf("仕入れ係")).toBeLessThan(names.indexOf("受信箱係"));
  });

  it("別のワークスペースの担当は出ない。セッションなしは 401", async () => {
    const { db } = T();
    const { t } = checkHarness(db);
    await enterWithPendingApproval(t);
    const guest = await signInGuest(t);
    const res = await send(t, "GET", "/api/v1/agents", { cookie: guest.cookie });
    expect(res.status).toBe(200);
    const body = AgentLibraryResponseSchema.parse(await res.json());
    // ゲストの新しいワークスペースには、オーナーの担当は混ざらない
    expect(body.items).toEqual([]);
    expect((await send(t, "GET", "/api/v1/agents")).status).toBe(401);
  });
});

// ---- 育つ（0022）：スキル・案・外したもの、案の決定、戻す、見てほしいもの ----

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedEvolution(db: ReturnType<typeof T>["db"], workspaceId: string, agentId: string) {
  const skill = await db.query<{ id: string }>(
    "INSERT INTO agent_skills (workspace_id, agent_id, name, description, body, pack_id) VALUES ($1,$2,'在庫の見方','在庫を見る','手順',NULL) RETURNING id",
    [workspaceId, agentId],
  );
  const removed = await db.query<{ id: string }>(
    "INSERT INTO agent_skills (workspace_id, agent_id, name, description, body, pack_id, removed_at) VALUES ($1,$2,'古いスキル','古い','手順',NULL, now()) RETURNING id",
    [workspaceId, agentId],
  );
  const proposal = await db.query<{ id: string }>(
    "INSERT INTO skill_proposals (workspace_id, agent_id, status, name, description, body, reason) VALUES ($1,$2,'proposed','発注の定型','発注の手順','## 手順\n1. 見る','3回続けて同じ手順') RETURNING id",
    [workspaceId, agentId],
  );
  const items = JSON.stringify([{ type: "skill", id: removed.rows[0]!.id, label: "古いスキル", restoredAt: null }]);
  const evt = await db.query<{ id: string }>("INSERT INTO agent_evolution_events (workspace_id, agent_id, kind, items) VALUES ($1,$2,'pruned',$3::text::jsonb) RETURNING id", [workspaceId, agentId, items]);
  const old = await db.query<{ id: string }>(
    "INSERT INTO agent_evolution_events (workspace_id, agent_id, kind, items, created_at) VALUES ($1,$2,'pruned',$3::text::jsonb,now() - $4::interval) RETURNING id",
    [workspaceId, agentId, items, `${40} days`],
  );
  return { skillId: skill.rows[0]!.id, removedSkillId: removed.rows[0]!.id, proposalId: proposal.rows[0]!.id, eventId: evt.rows[0]!.id, oldEventId: old.rows[0]!.id };
}

describe("スキルの育ち", () => {
  it("一覧に skills・skillProposals・pruned が出る（外したスキルは skills に出ない。30日より前の整理は出ない）", async () => {
    const { db } = T();
    const { t } = checkHarness(db);
    const g = await enterWithPendingApproval(t);
    const body0 = AgentLibraryResponseSchema.parse(await (await send(t, "GET", "/api/v1/agents", { cookie: g.cookie })).json());
    const buyer0 = body0.items.find((a) => a.name === "仕入れ係")!;
    const x = await seedEvolution(db, g.workspaceId, buyer0.id);
    const body = AgentLibraryResponseSchema.parse(await (await send(t, "GET", "/api/v1/agents", { cookie: g.cookie })).json());
    const buyer = body.items.find((a) => a.name === "仕入れ係")!;
    expect(buyer.skills.map((k) => k.id)).toContain(x.skillId);
    expect(buyer.skills.map((k) => k.id)).not.toContain(x.removedSkillId);
    expect(buyer.skills.find((k) => k.id === x.skillId)).toMatchObject({ origin: "pack", lastUsedAt: null });
    expect(buyer.skillProposals).toMatchObject([{ id: x.proposalId, name: "発注の定型", reason: "3回続けて同じ手順" }]);
    expect(buyer.pruned.map((e) => e.eventId)).toEqual([x.eventId]);
    expect(buyer.pruned[0]!.items).toEqual([{ type: "skill", id: x.removedSkillId, label: "古いスキル", restoredAt: null }]);
    const inbox = body.items.find((a) => a.name === "受信箱係")!;
    expect(inbox.skillProposals).toEqual([]);
    expect(inbox.pruned).toEqual([]);
    expect(DAY_MS).toBeGreaterThan(0);
  });

  it("見てほしいものに evolution の行が出て、チェックすると消え、案が決まると消える", async () => {
    const { db } = T();
    const { t } = checkHarness(db);
    const g = await enterWithPendingApproval(t);
    const list = AgentLibraryResponseSchema.parse(await (await send(t, "GET", "/api/v1/agents", { cookie: g.cookie })).json());
    const buyer = list.items.find((a) => a.name === "仕入れ係")!;
    const x = await seedEvolution(db, g.workspaceId, buyer.id);
    const check = async () => CheckResponse.parse((await call(t, g, "GET", "/api/v1/check")).body);
    const rows = (await check()).items.filter((i) => i.kind === "report" && i.reportKind === "evolution");
    expect(rows.map((r) => r.key).sort()).toEqual([`evolution:${x.eventId}`, `evolution:${x.oldEventId}`, `skill_proposal:${x.proposalId}`].map((k) => k).sort());
    const prop = rows.find((r) => r.key === `skill_proposal:${x.proposalId}`)!;
    expect(prop.title).toBe("仕入れ係 にスキルの案「発注の定型」が届きました");
    expect(prop.kind === "report" && prop.link.agentId).toBe(buyer.id);
    const evo = rows.find((r) => r.key === `evolution:${x.eventId}`)!;
    expect(evo.title).toBe("仕入れ係：使われていないスキル 1件を外しました（担当のページで戻せます）");

    // チェックすると消える
    await db.transaction((tx) => insertCheckMark(tx, { workspaceId: g.workspaceId } as never, `evolution:${x.eventId}`, new Date()));
    expect((await check()).items.map((i) => i.key)).not.toContain(`evolution:${x.eventId}`);

    // 案が決まると消える
    const decided = await call<{ status: string; skillId: string | null }>(t, g, "POST", `/api/v1/agents/${buyer.id}/skill-proposals/${x.proposalId}/decide`, { decision: "approve" });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ proposalId: x.proposalId, status: "approved" });
    expect(decided.body.skillId).not.toBeNull();
    expect((await check()).items.map((i) => i.key)).not.toContain(`skill_proposal:${x.proposalId}`);
  });

  it("decide・restore は入力を検証して actions を呼ぶ（戻すと skills に戻る）", async () => {
    const { db } = T();
    const { t } = checkHarness(db);
    const g = await enterWithPendingApproval(t);
    const list = AgentLibraryResponseSchema.parse(await (await send(t, "GET", "/api/v1/agents", { cookie: g.cookie })).json());
    const buyer = list.items.find((a) => a.name === "仕入れ係")!;
    const x = await seedEvolution(db, g.workspaceId, buyer.id);
    const dec = `/api/v1/agents/${buyer.id}/skill-proposals/${x.proposalId}/decide`;
    expect((await call(t, g, "POST", dec, { decision: "maybe" })).status).toBe(400);
    expect((await call(t, g, "POST", dec, {})).status).toBe(400);
    const rej = await call(t, g, "POST", dec, { decision: "reject" });
    expect(rej.body).toMatchObject({ status: "rejected", skillId: null });
    // 決めた案は二度と決められない
    expect((await call(t, g, "POST", dec, { decision: "approve" })).status).toBeGreaterThanOrEqual(400);

    const res = `/api/v1/agents/${buyer.id}/evolution/${x.eventId}/restore`;
    expect((await call(t, g, "POST", res, { type: "skill", id: "" })).status).toBe(400);
    expect((await call(t, g, "POST", res, { type: "tool", id: x.removedSkillId })).status).toBe(400);
    const ok = await call<{ restoredAt: string }>(t, g, "POST", res, { type: "skill", id: x.removedSkillId });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ eventId: x.eventId, type: "skill", id: x.removedSkillId });
    const after = AgentLibraryResponseSchema.parse(await (await send(t, "GET", "/api/v1/agents", { cookie: g.cookie })).json());
    const b2 = after.items.find((a) => a.id === buyer.id)!;
    expect(b2.skills.map((k) => k.id)).toContain(x.removedSkillId);
    expect(b2.pruned[0]!.items[0]!.restoredAt).not.toBeNull();
    // 二度は戻せない・セッションなしは 401
    expect((await call(t, g, "POST", res, { type: "skill", id: x.removedSkillId })).status).toBeGreaterThanOrEqual(400);
    expect((await send(t, "POST", res, { body: { type: "skill", id: "x" } })).status).toBe(401);
  });
});
