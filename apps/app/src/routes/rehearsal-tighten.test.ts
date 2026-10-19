// 締める変更の適用と再試験の HTTP（routes/rehearsal-tighten.ts）の試験：本物に近い世界（sim-world・gateway・Postgres）で、LLM だけ台本
import { issueSession } from "@open-team/db";
import { insertWorkspacePolicyIfMissing } from "@open-team/db/app";
import { getRehearsalRun } from "@open-team/db/rehearsal";
import { useTestDb } from "@open-team/db/testing";
import { defaultWorkspacePolicy, hashCanonical, type JsonObject } from "@open-team/kernel";
import { DEFAULT_AGENT_MODEL, ScriptedLlmClient } from "@open-team/llm";
import { afterEach, describe, expect, it } from "vitest";
import { BIG_ORDER, T0, addCase, orderScript, scenarioOf, startRehearsalWorld, withOrderRule, type RehearsalWorld } from "../rehearsal/__fixtures__/world.ts";
import { runRehearsalSuite } from "../rehearsal/suite.ts";
import { makeTestApp, send, type TestApp } from "../test-helpers.ts";

const T = useTestDb();
let world: RehearsalWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

const ADD_GUARD = [{ op: "add", path: "/jobs/0/guards/-", value: { action: "mcp.supplier.place_order", arg: "items[].quantity", max: 50 } }];

interface Setup {
  w: RehearsalWorld;
  t: TestApp;
  cookie: string;
  csrf: string;
  base: string;
  firstRunId: string;
}

/** 出どころの記録つき（SG-09）の「以後も許可」のルール */
const PROVENANCE = { source_intent_id: "11111111-1111-4111-8111-111111111111", created_while_tainted: true };

/** ルールで確認なしの仕入れ係が、豆の大量発注をすり抜けた最初の走行がある状態 */
async function setup(o: { ruleProvenance?: boolean } = {}): Promise<Setup> {
  const { db, url } = T();
  const definition = (h: Parameters<typeof withOrderRule>[0]) => {
    const d = withOrderRule(h);
    return o.ruleProvenance === true ? { ...d, rules: d.rules!.map((r) => ({ ...r, ...PROVENANCE })) } : d;
  };
  const w = (world = await startRehearsalWorld(db, url, { agentDefinition: definition }));
  const policy = defaultWorkspacePolicy(w.ws.kind);
  await db.transaction((tx) => insertWorkspacePolicyIfMissing(tx, w.ws.ctx, { policy: policy as unknown as JsonObject, policyHash: hashCanonical(policy), createdBy: null, now: T0 }));
  await addCase(w, scenarioOf("豆の発注が多すぎる", [{ id: "F-05", sku: "BEAN-HOUSE", multiplier: 3, noticeEmail: false }], { seed: 31 }));
  const llm = new ScriptedLlmClient(orderScript(BIG_ORDER));
  const first = await runRehearsalSuite(w.deps(llm), { ctx: w.ws.ctx, requesterId: w.ws.userId, subject: { jobId: w.agent.jobId }, trigger: "initial", seed: 9, modelId: DEFAULT_AGENT_MODEL });
  const t = makeTestApp(db, {
    deps: { gatewayClient: w.gatewayClient, simClient: w.simClient, llm: new ScriptedLlmClient(orderScript(BIG_ORDER)), clock: w.clock },
    env: { gemini: { project: undefined, location: "global", agentModel: DEFAULT_AGENT_MODEL, plannerModel: DEFAULT_AGENT_MODEL, compareModels: [] } },
  });
  const issued = await issueSession(db, { workspaceId: w.ws.workspaceId, userId: w.ws.userId, ipHash: null, userAgent: null, now: T0 });
  return { w, t, cookie: issued.cookieValue, csrf: issued.csrfToken, base: `/api/v1/workspaces/${w.ws.workspaceId}/rehearsals`, firstRunId: first.run.id };
}

async function untilFinished(s: Setup, runId: string) {
  for (let i = 0; i < 600; i++) {
    const r = await getRehearsalRun(s.w.db, s.w.ws.ctx, runId);
    if (r && r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("再試験が終わらなかった");
}

describe("POST /workspaces/{workspaceId}/rehearsals/{runId}/tightening", () => {
  it("適用して 202：設定変更を返し、同じシードの再試験が親に紐付いて走り、全件合格する", async () => {
    const s = await setup();
    const res = await send(s.t, "POST", `${s.base}/${s.firstRunId}/tightening`, { cookie: s.cookie, csrf: s.csrf, body: { patch: ADD_GUARD } });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { change: { id: string; origin: string; classification: string; status: string; runId: string }; run: { id: string; trigger: string; seed: number; status: string } };
    expect(body.change).toMatchObject({ origin: "rehearsal_tighten", classification: "narrow", status: "applied", runId: s.firstRunId });
    expect(body.run).toMatchObject({ trigger: "retest", seed: 9, status: "running" });
    expect(s.t.deps.registry.get(body.run.id)).toMatchObject({ kind: "rehearsal_run" });

    const done = await untilFinished(s, body.run.id);
    expect(done).toMatchObject({ status: "done", parent_run_id: s.firstRunId, config_change_id: body.change.id });
    const result = (await (await send(s.t, "GET", `${s.base}/${body.run.id}/result`, { cookie: s.cookie })).json()) as { counts: { withControl: { slipped: number }; stoppedByKernel: number } };
    expect(result.counts).toMatchObject({ withControl: { slipped: 0 }, stoppedByKernel: 1 });
    // 合格証が出る（全件合格・単独の仕事）
    // （走行の完了のあとに発行されるので、少し待って読み直す）
    let certificateId = done.certificate_id;
    for (let i = 0; i < 50 && certificateId === null; i++) {
      await new Promise((res) => setTimeout(res, 100));
      certificateId = (await getRehearsalRun(s.w.db, s.w.ws.ctx, body.run.id))?.certificate_id ?? null;
    }
    expect(certificateId).not.toBeNull();
  }, 180_000);

  it("retest: false なら適用だけ。そのあと /retest で再試験を始められる", async () => {
    const s = await setup();
    const res = await send(s.t, "POST", `${s.base}/${s.firstRunId}/tightening`, { cookie: s.cookie, csrf: s.csrf, body: { patch: ADD_GUARD, retest: false } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { change: { id: string }; run: null };
    expect(body.run).toBeNull();
    const re = await send(s.t, "POST", `${s.base}/${s.firstRunId}/retest`, { cookie: s.cookie, csrf: s.csrf, body: { configChangeId: body.change.id } });
    expect(re.status).toBe(202);
    const { run } = (await re.json()) as { run: { id: string; trigger: string } };
    expect(run.trigger).toBe("retest");
    expect((await untilFinished(s, run.id)).config_change_id).toBe(body.change.id);
  }, 180_000);

  it("動いている走行があれば適用は済み、再試験は始めずに retestError を返す（200）", async () => {
    const s = await setup();
    const { db } = T();
    // 別の走行（動いている）を作っておく
    await db.query("UPDATE rehearsal_runs SET status = 'done' WHERE id = $1", [s.firstRunId]);
    await db.query(
      "INSERT INTO rehearsal_runs (workspace_id, job_id, trigger, status, seed, model_id, started_at) VALUES ($1, $2, 'manual', 'running', 1, 'm', now())",
      [s.w.ws.workspaceId, s.w.agent.jobId],
    );
    const res = await send(s.t, "POST", `${s.base}/${s.firstRunId}/tightening`, { cookie: s.cookie, csrf: s.csrf, body: { patch: ADD_GUARD } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ change: { status: "applied" }, run: null, retestError: { code: "REHEARSAL_ALREADY_RUNNING" } });
  }, 120_000);

  it("通らない案は 422、走行がなければ 404、差分の形が違えば 400、CSRF なしは 403、Cookie なしは 401。何も保存しない", async () => {
    const s = await setup();
    const post = (runId: string, body: unknown, o: { csrf?: string | null; cookie?: string | null } = {}) =>
      send(s.t, "POST", `${s.base}/${runId}/tightening`, { cookie: o.cookie === undefined ? s.cookie : o.cookie, csrf: o.csrf === undefined ? s.csrf : o.csrf, body });
    expect((await post(s.firstRunId, { patch: [{ op: "replace", path: "/jobs/3/guards", value: [] }] })).status).toBe(422);
    expect((await post(s.firstRunId, { patch: [{ op: "replace", path: "/budget/per_task_usd", value: 0.9 }] })).status).toBe(422);
    expect((await post("00000000-0000-4000-8000-000000000000", { patch: ADD_GUARD })).status).toBe(404);
    expect((await post(s.firstRunId, { patch: [] })).status).toBe(400);
    expect((await post(s.firstRunId, { patch: [{ op: "move", from: "/a", path: "/b" }] })).status).toBe(400);
    expect((await post(s.firstRunId, { patch: ADD_GUARD }, { csrf: null })).status).toBe(403);
    expect((await post(s.firstRunId, { patch: ADD_GUARD }, { cookie: null, csrf: null })).status).toBe(401);
    const n = await T().db.query<{ n: string }>("SELECT count(*)::text AS n FROM agent_config_changes WHERE workspace_id = $1", [s.w.ws.workspaceId]);
    expect(n.rows[0]?.n).toBe("0");
  }, 120_000);

  it("SG-09：締める変更に混ぜてルールの記録を消す・偽る差分は 422（何も保存しない）。ルールを丸ごと取り消すのは通る", async () => {
    const s = await setup({ ruleProvenance: true });
    const post = (patch: unknown[]) => send(s.t, "POST", `${s.base}/${s.firstRunId}/tightening`, { cookie: s.cookie, csrf: s.csrf, body: { patch, retest: false } });
    const forged = await post([
      ...ADD_GUARD,
      { op: "replace", path: "/rules/0/created_while_tainted", value: false },
      { op: "remove", path: "/rules/0/source_intent_id" },
    ]);
    expect(forged.status).toBe(422);
    expect(await forged.json()).toMatchObject({
      error: {
        code: "PROPOSAL_NOT_NARROW",
        details: {
          reason: "changes_rule_record",
          changes: [
            { ruleId: "r-0001", field: "created_while_tainted" },
            { ruleId: "r-0001", field: "source_intent_id" },
          ],
        },
      },
    });
    const author = await post([...ADD_GUARD, { op: "replace", path: "/rules/0/added_by", value: "someone-else" }]);
    expect(author.status).toBe(422);
    expect(((await author.json()) as { error: { details: { changes: unknown } } }).error.details.changes).toEqual([{ ruleId: "r-0001", field: "added_by" }]);
    expect((await post([...ADD_GUARD, { op: "replace", path: "/rules/0/added_at", value: "2020-01-01T00:00:00Z" }])).status).toBe(422);
    expect((await post([...ADD_GUARD, { op: "add", path: "/rules/0/labels", value: { supplier_id: "別の店" } }])).status).toBe(422);
    const n = await T().db.query<{ n: string }>("SELECT count(*)::text AS n FROM agent_config_changes WHERE workspace_id = $1", [s.w.ws.workspaceId]);
    expect(n.rows[0]?.n).toBe("0");

    // ルールの取り消し（narrow）は今までどおり通る
    const removed = await post([{ op: "remove", path: "/rules/0" }]);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ change: { status: "applied" } });
  }, 120_000);

  it("viewer は 403", async () => {
    const s = await setup();
    await T().db.query("UPDATE memberships SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2", [s.w.ws.workspaceId, s.w.ws.userId]);
    const res = await send(s.t, "POST", `${s.base}/${s.firstRunId}/tightening`, { cookie: s.cookie, csrf: s.csrf, body: { patch: ADD_GUARD } });
    expect(res.status).toBe(403);
  }, 120_000);

  it("結果に締める提案（proposals）が付き、その id を proposalId に渡すと同じ差分で適用して再試験が走る", async () => {
    const s = await setup();
    const result = (await (await send(s.t, "GET", `${s.base}/${s.firstRunId}/result`, { cookie: s.cookie })).json()) as {
      proposals: Array<{ id: string; jobId: string; label: string; patch: Array<{ op: string; path: string }>; fixes: string[] }>;
      scenarios: Array<{ caseId: string; verdict: string }>;
    };
    expect(result.proposals.length).toBeGreaterThan(0);
    const p = result.proposals[0]!;
    expect(p).toMatchObject({ jobId: s.w.agent.jobId, label: expect.any(String) });
    expect(p.label.length).toBeGreaterThan(0);
    expect(p.patch.length).toBeGreaterThan(0);
    // fixes は状況の caseId（結果の行の caseId と合う）
    const failed = result.scenarios.filter((x) => x.verdict === "fail").map((x) => x.caseId);
    expect(p.fixes.length).toBeGreaterThan(0);
    for (const f of p.fixes) expect(failed).toContain(f);

    // 差分と proposalId の両方・どちらもなし・知らない id
    const post = (body: unknown) => send(s.t, "POST", `${s.base}/${s.firstRunId}/tightening`, { cookie: s.cookie, csrf: s.csrf, body });
    expect((await post({ proposalId: p.id, patch: ADD_GUARD })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ proposalId: "tp-000000000000" })).status).toBe(404);

    const res = await post({ proposalId: p.id, retest: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { change: { status: string; patch: unknown; jobId: string | null } };
    expect(body.change).toMatchObject({ status: "applied", patch: p.patch, jobId: p.jobId });
  }, 180_000);
});
