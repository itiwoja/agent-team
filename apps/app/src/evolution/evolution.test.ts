// 「チームが使うほど育つ」の処理の試験（DB を使う。LLM は台本）：スキルの案・整理・承認・戻す
import { insertWorkspacePolicyIfMissing } from "@open-team/db/app";
import { listAgentSkills } from "@open-team/db/sandbox";
import { fxAgent, fxTask, fxWorkspace, useTestDb, type FxAgent, type FxWorkspace } from "@open-team/db/testing";
import type { SessionCtx } from "@open-team/db";
import { skillDigest } from "@open-team/edge";
import { defaultWorkspacePolicy, hashCanonical, type JsonObject } from "@open-team/kernel";
import { ScriptedLlmClient, type ScriptedReply } from "@open-team/llm";
import { describe, expect, it } from "vitest";
import { T0, jsonReply, makeTestApp } from "../test-helpers.ts";
import { decideSkillProposalAction, restoreEvolutionItemAction } from "./actions.ts";
import { learnSkillsStep } from "./learn.ts";
import { createPruneStep } from "./prune.ts";

const T = useTestDb();
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(T0.getTime() - ms);

const RULE_HASH = `sha256:${"a".repeat(64)}` as const;
const rule = (id: string, addedAt: Date) => ({
  id,
  action: "mcp.supplier.place_order",
  match: { supplier_id: id },
  free: [],
  tool_hash: RULE_HASH,
  added_by: "owner",
  added_at: addedAt.toISOString(),
});

async function setup(replies: ScriptedReply[] = []) {
  const { db } = T();
  const ws = await fxWorkspace(db, { audit: true });
  const agent = await fxAgent(db, ws);
  // fxAgent の担当は supplier を付与している（ワークスペースで有効でないと定義を組み直せない）
  const policy = defaultWorkspacePolicy(["supplier"]);
  await db.transaction((tx) => insertWorkspacePolicyIfMissing(tx, ws.ctx, { policy: policy as unknown as JsonObject, policyHash: hashCanonical(policy), createdBy: null, now: T0 }));
  const llm = new ScriptedLlmClient(replies);
  const t = makeTestApp(db, { deps: { llm }, env: { gemini: { apiKey: undefined, agentModel: "gemini-2.5-flash", plannerModel: "gemini-2.5-flash", compareModels: [] } } });
  const s = { ...ws.ctx, userId: ws.userId, role: "owner" } as unknown as SessionCtx;
  return { db, ws, agent, llm, t, s };
}

async function succeededTasks(ws: FxWorkspace, agent: FxAgent, n: number) {
  const { db } = T();
  for (let i = 1; i <= n; i++) {
    const { taskId } = await fxTask(db, ws, agent, { status: "succeeded", now: ago(i * DAY) });
    await db.query("UPDATE tasks SET report = $2, report_kind = 'normal', prompt = $3 WHERE id = $1", [taskId, `報告${i}`, `週報を作って ${i}`]);
  }
}

/** 新しいスナップショットに rules を入れて今のものにする（スナップショットは更新できない） */
async function setRules(agent: FxAgent, rules: unknown[]) {
  const { db } = T();
  const [cur] = await rowsOf<{ workspace_id: string; definition: Record<string, unknown>; effective_policies: unknown }>("SELECT workspace_id, definition, effective_policies FROM agent_snapshots WHERE id = (SELECT current_snapshot_id FROM agents WHERE id = $1)", [agent.agentId]);
  const [snap] = await rowsOf<{ id: string }>(
    "INSERT INTO agent_snapshots (workspace_id, agent_id, status, definition, effective_policies, ceilings_version) VALUES ($1, $2, 'valid', $3, $4, '0-H.1') RETURNING id",
    [cur!.workspace_id, agent.agentId, { ...cur!.definition, rules }, cur!.effective_policies],
  );
  await db.query("UPDATE agents SET current_snapshot_id = $2 WHERE id = $1", [agent.agentId, snap!.id]);
}

type Item = { type: string; id: string; label: string; restoredAt: string | null };
type Cur = { definition: { rules: { id: string }[] }; id: string; origin: string; classification: string; reverts_change_id: string | null };
const rowsOf = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => (await T().db.query<R>(sql, params)).rows;
const CUR_SQL = "SELECT s.definition, s.id, c.origin, c.classification, c.reverts_change_id FROM agents a JOIN agent_snapshots s ON s.id = a.current_snapshot_id JOIN agent_config_changes c ON c.id = s.config_change_id WHERE a.id = $1";

const SKILL = { name: "週報の作り方", description: "毎週の週報を作るとき", body: "1. 集計する\n2. 書く" };

describe("learnSkillsStep", () => {
  it("3件の成功タスクで案ができ、事象と usage_records が残る。案が未決定の間は作らない", async () => {
    const { db, ws, agent, llm, t } = await setup([jsonReply({ skill: SKILL, reason: "毎週同じ" })]);
    await succeededTasks(ws, agent, 3);
    await learnSkillsStep.run(t.deps, T0);
    const rows = await rowsOf<{ status: string; name: string; reason: string; source_task_ids: string[] }>("SELECT * FROM skill_proposals WHERE agent_id = $1", [agent.agentId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ status: "proposed", name: SKILL.name, reason: "毎週同じ" });
    expect(rows[0]!.source_task_ids).toHaveLength(3);
    expect(llm.requests[0]!.messages[0]!.content).toContain("<untrusted");
    expect((await db.query("SELECT type FROM workspace_events WHERE workspace_id = $1 AND type = 'agent.skill_proposed'", [ws.workspaceId])).rows).toHaveLength(1);
    expect((await db.query("SELECT phase, agent_id FROM usage_records WHERE workspace_id = $1", [ws.workspaceId])).rows).toEqual([{ phase: "summarize", agent_id: agent.agentId }]);
    // 未決定の案がある：LLM を呼ばない（追加の3件があっても）
    await succeededTasks(ws, agent, 3);
    await learnSkillsStep.run(t.deps, T0);
    expect(llm.requests).toHaveLength(1);
  });

  it("skill なしの答えは skipped になり、案の一覧には出ない。LLM の失敗は握りつぶさずログに残して止まらない", async () => {
    const { db, ws, agent, t } = await setup([jsonReply({ reason: "共通の手順はない" })]);
    await succeededTasks(ws, agent, 3);
    await learnSkillsStep.run(t.deps, T0);
    expect((await db.query("SELECT status, name FROM skill_proposals")).rows).toEqual([{ status: "skipped", name: null }]);
    expect((await db.query("SELECT 1 FROM workspace_events WHERE type = 'agent.skill_proposed'")).rows).toHaveLength(0);
  });

  it("LLM の呼び出しの失敗はログに残し、skipped を残す（同じ担当を毎分呼び直さない。例外で tick を止めない）", async () => {
    const b = await setup([]);
    await succeededTasks(b.ws, b.agent, 3);
    await learnSkillsStep.run(b.t.deps, T0);
    expect(b.t.logs.some((l) => l.event === "evolution.learn_call_failed")).toBe(true);
    expect(await rowsOf("SELECT status, reason FROM skill_proposals WHERE agent_id = $1", [b.agent.agentId])).toEqual([{ status: "skipped", reason: "案を作る呼び出しに失敗しました" }]);
  });
});

describe("pruneStep", () => {
  it("30日使われていないスキルが外れ、イベントができる。1時間以内の再実行は走らない", async () => {
    const { db, ws, agent, t } = await setup();
    const { insertAgentSkill } = await import("@open-team/db/sandbox");
    await db.transaction(async (tx) => {
      await insertAgentSkill(tx, ws.ctx, { agentId: agent.agentId, name: "古い", description: "d", body: "b", packId: "teacher", now: ago(60 * DAY) });
      await insertAgentSkill(tx, ws.ctx, { agentId: agent.agentId, name: "新しい", description: "d", body: "b", packId: "teacher", now: ago(DAY) });
    });
    const step = createPruneStep();
    await step.run(t.deps, T0);
    expect((await listAgentSkills(db, ws.ctx, agent.agentId)).map((k) => k.name)).toEqual(["新しい"]);
    const ev = await rowsOf<{ items: Item[]; config_change_id: string | null }>("SELECT items, config_change_id FROM agent_evolution_events");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.items).toMatchObject([{ type: "skill", label: "古い", restoredAt: null }]);
    expect(ev[0]!.config_change_id).toBeNull();
    expect((await db.query("SELECT 1 FROM audit_logs WHERE event_type = 'agent.evolution.pruned'")).rows).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM workspace_events WHERE type = 'agent.evolution.pruned'")).rows).toHaveLength(1);
    // 同じ手順は1時間以内なら走査しない
    await db.query("UPDATE agent_skills SET removed_at = NULL, last_used_at = NULL");
    await step.run(t.deps, new Date(T0.getTime() + 60_000));
    expect((await listAgentSkills(db, ws.ctx, agent.agentId))).toHaveLength(2);
  });

  it("使われていないルールが新しいスナップショットで外れる（origin=prune）。スキルとルールを戻せて、二重に戻すとエラー", async () => {
    const { db, ws, agent, t, s } = await setup();
    const { insertAgentSkill } = await import("@open-team/db/sandbox");
    await setRules(agent, [rule("r-old", ago(60 * DAY)), rule("r-new", ago(DAY))]);
    await db.transaction((tx) => insertAgentSkill(tx, ws.ctx, { agentId: agent.agentId, name: "古い", description: "d", body: "b", packId: "teacher", now: ago(60 * DAY) }));
    await createPruneStep().run(t.deps, T0);

    const cur = (await rowsOf<Cur>(CUR_SQL, [agent.agentId]))[0]!;
    expect(cur.id).not.toBe(agent.snapshotId);
    expect(cur.definition.rules.map((r: { id: string }) => r.id)).toEqual(["r-new"]);
    expect(cur).toMatchObject({ origin: "prune", classification: "narrow" });
    const ev = (await rowsOf<{ id: string; items: Item[] }>("SELECT id, items FROM agent_evolution_events"))[0]!;
    expect(ev.items.map((i) => i.type).sort()).toEqual(["rule", "skill"]);
    const skillItem = ev.items.find((i) => i.type === "skill")!;

    // 戻す
    const r1 = await restoreEvolutionItemAction(t.deps, s, agent.agentId, ev.id, { type: "skill", id: skillItem.id });
    expect(r1.restoredAt).toBe(T0.toISOString());
    expect(await listAgentSkills(db, ws.ctx, agent.agentId)).toHaveLength(1);
    await expect(restoreEvolutionItemAction(t.deps, s, agent.agentId, ev.id, { type: "skill", id: skillItem.id })).rejects.toMatchObject({ code: "CHANGE_NOT_PENDING" });

    await restoreEvolutionItemAction(t.deps, s, agent.agentId, ev.id, { type: "rule", id: "r-old" });
    const back = (await rowsOf<Cur>(CUR_SQL, [agent.agentId]))[0]!;
    expect(back.definition.rules.map((r: { id: string }) => r.id)).toEqual(["r-new", "r-old"]);
    expect(back).toMatchObject({ origin: "revert", classification: "widen" });
    expect(back.reverts_change_id).not.toBeNull();
    // 戻したルールは戻した時刻から数え直す（古い added_at のままだと次の整理ですぐまた外れる）
    expect((back.definition.rules as Array<{ id: string; added_at?: string }>).find((r) => r.id === "r-old")?.added_at).toBe(t.deps.clock.now().toISOString());
    await expect(restoreEvolutionItemAction(t.deps, s, agent.agentId, ev.id, { type: "rule", id: "r-old" })).rejects.toMatchObject({ code: "CHANGE_NOT_PENDING" });
    // 別の担当の記録・存在しない項目
    await expect(restoreEvolutionItemAction(t.deps, s, agent.agentId, ev.id, { type: "rule", id: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("ルールが上限（20個）なら戻せない", async () => {
    const { db, agent, t, s } = await setup();
    await setRules(agent, [rule("r-old", ago(60 * DAY))]);
    await createPruneStep().run(t.deps, T0);
    const ev = (await rowsOf<{ id: string }>("SELECT id FROM agent_evolution_events"))[0]!;
    // 今の定義を20個にする
    await setRules(agent, Array.from({ length: 20 }, (_, i) => rule(`r-f${i}`, ago(DAY))));
    await expect(restoreEvolutionItemAction(t.deps, s, agent.agentId, ev.id, { type: "rule", id: "r-old" })).rejects.toMatchObject({ code: "RULE_NOT_ALLOWED" });
  });
});

describe("decideSkillProposalAction", () => {
  async function proposed(over: Partial<typeof SKILL> = {}) {
    const c = await setup();
    const { insertSkillProposal } = await import("@open-team/db/evolution");
    const p = await c.db.transaction((tx) => insertSkillProposal(tx, c.ws.ctx, { agentId: c.agent.agentId, status: "proposed", ...SKILL, ...over, reason: "r", sourceTaskIds: [], now: T0 }));
    return { ...c, p };
  }

  it("承認で learned スキルができ、approved_digest が skillDigest と一致する。二重の承認はエラー", async () => {
    const { db, ws, agent, t, s, p } = await proposed();
    const r = await decideSkillProposalAction(t.deps, s, agent.agentId, p.id, "approve");
    expect(r).toMatchObject({ proposalId: p.id, status: "approved" });
    const [skill] = await listAgentSkills(db, ws.ctx, agent.agentId);
    expect(skill).toMatchObject({ id: r.skillId, origin: "learned", approved_by: ws.userId, proposal_id: p.id, pack_id: null });
    expect(skill!.approved_digest).toBe(skillDigest(SKILL));
    await expect(decideSkillProposalAction(t.deps, s, agent.agentId, p.id, "approve")).rejects.toMatchObject({ code: "PROPOSAL_NOT_PENDING" });
    await expect(decideSkillProposalAction(t.deps, s, agent.agentId, p.id, "reject")).rejects.toMatchObject({ code: "PROPOSAL_NOT_PENDING" });
    expect((await db.query("SELECT 1 FROM audit_logs WHERE event_type = 'agent.skill.approved'")).rows).toHaveLength(1);
  });

  it("却下ではスキルができない。担当が違う案は NOT_FOUND", async () => {
    const { db, ws, agent, t, s, p } = await proposed();
    const other = await fxAgent(db, ws, { name: "別の係" });
    await expect(decideSkillProposalAction(t.deps, s, other.agentId, p.id, "reject")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await decideSkillProposalAction(t.deps, s, agent.agentId, p.id, "reject")).toMatchObject({ status: "rejected", skillId: null });
    expect(await listAgentSkills(db, ws.ctx, agent.agentId)).toHaveLength(0);
  });
});
