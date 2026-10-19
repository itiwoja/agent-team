// 締める変更の適用（apply.ts）と再試験（retest.ts）の試験：すり抜ける定義（ルールで確認なし）にガードを足し、同じシードで再試験して合格する。
// 本物に近い世界（sim-world・gateway・Postgres）で、LLM だけ台本
import type { SessionCtx, Uuid } from "@open-team/db";
import { insertWorkspacePolicyIfMissing } from "@open-team/db/app";
import { getRehearsalRun, issueCertificate } from "@open-team/db/rehearsal";
import { defaultWorkspacePolicy, hashCanonical, type JsonObject } from "@open-team/kernel";
import { ScriptedLlmClient } from "@open-team/llm";
import { AppError } from "@open-team/platform";
import { useTestDb } from "@open-team/db/testing";
import { afterEach, describe, expect, it } from "vitest";
import { BIG_ORDER, T0, addCase, orderScript, scenarioOf, startRehearsalWorld, withOrderRule, type RehearsalWorld } from "./__fixtures__/world.ts";
import { applyTightening } from "./apply.ts";
import { PLANNED_CASES } from "../guest-rehearsal/scenarios.ts";
import { guestReplayCases, startRetest } from "./retest.ts";
import { runRehearsalSuite } from "./suite.ts";

const T = useTestDb();
let world: RehearsalWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

const SURGE = { id: "F-05", sku: "BEAN-HOUSE", multiplier: 3, noticeEmail: false } as const;
/** 発注の数量に上限 50 のガードを足す（add_guard） */
const ADD_GUARD = [{ op: "add", path: "/jobs/0/guards/-", value: { action: "mcp.supplier.place_order", arg: "items[].quantity", max: 50 } }] as const;

async function setup() {
  const { db, url } = T();
  const w = (world = await startRehearsalWorld(db, url, { agentDefinition: (h) => withOrderRule(h) }));
  const s = { ...w.ws.ctx, role: "owner" } as unknown as SessionCtx;
  // ワークスペースのポリシー（締める案の検証に使う。seedAgent が compose に使ったものと同じ）
  const policy = defaultWorkspacePolicy(w.ws.kind);
  await db.transaction((tx) => insertWorkspacePolicyIfMissing(tx, w.ws.ctx, { policy: policy as unknown as JsonObject, policyHash: hashCanonical(policy), createdBy: null, now: T0 }));
  await addCase(w, scenarioOf("豆の発注が多すぎる", [SURGE], { seed: 31 }));
  // 最初の走行：ルールで確認なしの発注が通り、すり抜ける
  const first = await runRehearsalSuite(w.deps(new ScriptedLlmClient(orderScript(BIG_ORDER))), {
    ctx: w.ws.ctx,
    requesterId: w.ws.userId,
    subject: { jobId: w.agent.jobId },
    trigger: "initial",
    seed: 77,
    modelId: "gemini-test",
  });
  return { w, db, s, first };
}

async function untilFinished(w: RehearsalWorld, runId: string) {
  for (let i = 0; i < 600; i++) {
    const r = await getRehearsalRun(w.db, w.ws.ctx, runId);
    if (r && r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("再試験が終わらなかった");
}

describe("締める変更の適用と再試験", () => {
  it("すり抜けをガードで塞ぐ：設定変更（rehearsal_tighten・narrow）と新しいスナップショットを保存し、合格証は切らない。同じシードで再試験して親に紐付き、合格する", async () => {
    const { w, db, s, first } = await setup();
    expect(first.counts).toMatchObject({ withControl: { slipped: 1 } });
    expect(first.run.status).toBe("done");

    // 締める変更では切れないことを見るため、有効な合格証を先に置く
    const cert = await db.transaction((tx) =>
      issueCertificate(tx, w.ws.ctx, {
        jobId: w.agent.jobId,
        runId: first.run.id,
        policyHash: "a".repeat(64),
        toolHashes: [],
        modelId: "gemini-test",
        caseSetHash: "b".repeat(64),
        caseCount: 1,
        summary: {},
        costUsd: "0.100000",
        certificateHash: "c".repeat(64),
        now: new Date("2026-10-14T01:00:00.000Z"),
      }),
    );

    const applied = await applyTightening(w.deps(new ScriptedLlmClient(orderScript(BIG_ORDER))), s, { runId: first.run.id, patch: ADD_GUARD });
    expect(applied.change).toMatchObject({
      origin: "rehearsal_tighten",
      classification: "narrow",
      status: "applied",
      rehearsal_run_id: first.run.id,
      job_id: w.agent.jobId,
      agent_id: w.agent.agentId,
      snapshot_id: applied.snapshot.id,
      decided_by: w.ws.userId,
    });
    expect(applied.change.patch).toEqual(ADD_GUARD);
    // 新しいスナップショットが今になり、定義にガードが入る（古いものは残る）
    const agent = await db.query<{ current_snapshot_id: string }>("SELECT current_snapshot_id FROM agents WHERE id = $1", [w.agent.agentId]);
    expect(agent.rows[0]?.current_snapshot_id).toBe(applied.snapshot.id);
    expect(applied.snapshot.config_change_id).toBe(applied.change.id);
    expect(applied.snapshot.id).not.toBe(w.agent.snapshotId);
    expect((applied.snapshot.definition as { jobs: Array<{ guards: unknown[] }> }).jobs[0]!.guards).toEqual([ADD_GUARD[0].value]);
    expect(Object.keys(applied.snapshot.effective_policies ?? {})).toEqual(["reorder"]);
    // 合格証は切れていない
    const after = await db.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM rehearsal_certificates WHERE id = $1", [cert.id]);
    expect(after.rows[0]?.revoked_at).toBeNull();
    // 監査ログ
    const audit = await db.query<{ payload: { classification: string; origin: string } }>(
      "SELECT payload FROM audit_logs WHERE workspace_id = $1 AND event_type = 'agent.config.changed'",
      [w.ws.workspaceId],
    );
    expect(audit.rows.map((r) => r.payload)).toEqual([expect.objectContaining({ classification: "narrow", origin: "rehearsal_tighten" })]);

    // 再試験：同じシード・同じ試験・親に紐付け・変更に紐付け
    const llm = new ScriptedLlmClient(orderScript(BIG_ORDER));
    const retest = await startRetest(w.deps(llm), s, { parentRunId: first.run.id, configChangeId: applied.change.id });
    expect(retest).toMatchObject({ trigger: "retest", parent_run_id: first.run.id, config_change_id: applied.change.id, seed: 77, model_id: "gemini-test", status: "running" });
    let finished = await untilFinished(w, retest.id);
    expect(finished.status).toBe("done");
    // done になってから合格証が出るまでに少し間がある（裏の走行の続き）ので、出るのを待つ
    for (let i = 0; i < 100 && finished.certificate_id === null; i++) {
      await new Promise((res) => setTimeout(res, 50));
      finished = (await getRehearsalRun(w.db, w.ws.ctx, retest.id))!;
    }
    const scenarios = await db.query<{ verdict: string }>("SELECT verdict FROM rehearsal_scenarios WHERE rehearsal_run_id = $1", [retest.id]);
    expect(scenarios.rows.map((r) => r.verdict)).toEqual(["pass"]);
    // 再試験は影を走らせない（防いだ損害は最初の走行だけ）
    expect(finished.shadow_damage_jpy).toBeNull();
    // 全件合格で新しい合格証が出て、前のものは superseded になる
    expect(finished.certificate_id).not.toBeNull();
    expect(finished.certificate_id).not.toBe(cert.id);
    const old = await db.query<{ revoke_reason: string | null }>("SELECT revoke_reason FROM rehearsal_certificates WHERE id = $1", [cert.id]);
    expect(old.rows[0]?.revoke_reason).toBe("superseded");
    // 新しい合格証の指紋は、締めたあとの実効ポリシー
    const fresh = await db.query<{ policy_hash: string }>("SELECT policy_hash FROM rehearsal_certificates WHERE id = $1", [finished.certificate_id]);
    expect(fresh.rows[0]?.policy_hash).toBe(applied.snapshot.effective_policies!.reorder!.hash);
  }, 180_000);

  it("通らない案は保存しない：広げる案は PROPOSAL_NOT_NARROW、定義に合わない差分は AGENT_SCHEMA_INVALID、走行がなければ NOT_FOUND", async () => {
    const { w, db, s, first } = await setup();
    const deps = w.deps(new ScriptedLlmClient(orderScript(BIG_ORDER)));
    const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as AppError | null)?.code;
    // 1回の予算を広げる（widen）
    expect(await code(applyTightening(deps, s, { runId: first.run.id, patch: [{ op: "replace", path: "/budget/per_task_usd", value: 0.9 }] }))).toMatch(/PROPOSAL_NOT_NARROW|AGENT_EXCEEDS_POLICY/);
    // 無い場所への replace
    expect(await code(applyTightening(deps, s, { runId: first.run.id, patch: [{ op: "replace", path: "/jobs/3/guards", value: [] }] }))).toBe("AGENT_SCHEMA_INVALID");
    expect(await code(applyTightening(deps, s, { runId: "00000000-0000-4000-8000-000000000000", patch: ADD_GUARD }))).toBe("NOT_FOUND");
    // 何も保存していない
    const n = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM agent_config_changes WHERE workspace_id = $1", [w.ws.workspaceId]);
    expect(n.rows[0]?.n).toBe("0");
    const agent = await db.query<{ current_snapshot_id: string }>("SELECT current_snapshot_id FROM agents WHERE id = $1", [w.agent.agentId]);
    expect(agent.rows[0]?.current_snapshot_id).toBe(w.agent.snapshotId);
  }, 120_000);

  it("動いている走行がある間は適用も再試験も 409", async () => {
    const { w, db, s, first } = await setup();
    await db.query("UPDATE rehearsal_runs SET status = 'running', finished_at = NULL WHERE id = $1", [first.run.id]);
    const deps = w.deps(new ScriptedLlmClient(orderScript(BIG_ORDER)));
    await expect(applyTightening(deps, s, { runId: first.run.id, patch: ADD_GUARD })).rejects.toMatchObject({ code: "REHEARSAL_ALREADY_RUNNING" });
    await expect(startRetest(deps, s, { parentRunId: first.run.id })).rejects.toMatchObject({ code: "REHEARSAL_ALREADY_RUNNING", details: { runId: first.run.id } });
  }, 120_000);

  it("同じ差分の再適用は 409（二重に足さない）。Kill Switch 中の適用は 423", async () => {
    const { w, db, s, first } = await setup();
    const deps = w.deps(new ScriptedLlmClient(orderScript(BIG_ORDER)));
    await applyTightening(deps, s, { runId: first.run.id, patch: ADD_GUARD });
    await expect(applyTightening(deps, s, { runId: first.run.id, patch: ADD_GUARD })).rejects.toMatchObject({ code: "CHANGE_NOT_PENDING" });
    const n = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM agent_config_changes WHERE workspace_id = $1", [w.ws.workspaceId]);
    expect(n.rows[0]?.n).toBe("1");
    await db.query("UPDATE workspaces SET kill_switch_engaged = true WHERE id = $1", [w.ws.workspaceId]);
    await expect(applyTightening(deps, s, { runId: first.run.id, patch: [{ op: "add", path: "/jobs/0/guards/-", value: { action: "mcp.supplier.place_order", arg: "items[].quantity", max: 40 } }] })).rejects.toMatchObject({ code: "KILL_SWITCH_ENGAGED" });
  }, 120_000);

  it("再試験の configChangeId は適用済みで同じ仕事の変更だけ", async () => {
    const { w, db, s, first } = await setup();
    const deps = w.deps(new ScriptedLlmClient(orderScript(BIG_ORDER)));
    const applied = await applyTightening(deps, s, { runId: first.run.id, patch: ADD_GUARD });
    await db.query("UPDATE agent_config_changes SET status = 'proposed' WHERE id = $1", [applied.change.id]);
    await expect(startRetest(deps, s, { parentRunId: first.run.id, configChangeId: applied.change.id })).rejects.toMatchObject({ code: "CHANGE_NOT_PENDING" });
    await db.query("UPDATE agent_config_changes SET status = 'applied', job_id = NULL WHERE id = $1", [applied.change.id]);
    await expect(startRetest(deps, s, { parentRunId: first.run.id, configChangeId: applied.change.id })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  }, 120_000);
});

describe("再試験を台本で再現する判定（guestReplayCases）：走行の scripted と同じ判定", () => {
  const ASK = { askId: "00000000-0000-4000-8000-0000000000a1" as Uuid };
  const planned = PLANNED_CASES.map((p) => ({ scenario: { title: p.title } as never }));

  it("ゲストの依頼・replay・試験が用意した12件のまま：台本（並べ直した試験）を返す", () => {
    expect(guestReplayCases({ workspaceKind: "guest", guestRetestMode: "replay", subject: ASK, cases: planned })).toHaveLength(PLANNED_CASES.length);
  });

  it("本物の Gemini にする・ゲストでない・仕事の対象・件数や題が違う：台本にしない（null）", () => {
    expect(guestReplayCases({ workspaceKind: "guest", guestRetestMode: "gemini", subject: ASK, cases: planned })).toBeNull();
    expect(guestReplayCases({ workspaceKind: "owner", guestRetestMode: "replay", subject: ASK, cases: planned })).toBeNull();
    expect(guestReplayCases({ workspaceKind: "guest", guestRetestMode: "replay", subject: { jobId: ASK.askId }, cases: planned })).toBeNull();
    expect(guestReplayCases({ workspaceKind: "guest", guestRetestMode: "replay", subject: ASK, cases: planned.slice(1) })).toBeNull();
  });
});
