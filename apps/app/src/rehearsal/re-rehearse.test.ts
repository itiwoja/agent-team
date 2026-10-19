// 合格証の失効と自動の再リハーサルの試験：切れた仕事を tick の手順が今の試験だけで走らせ直し、全件合格なら再発行し、不合格なら出さない。
// 本物に近い世界（sim-world・gateway・Postgres）で、LLM だけ台本
import { hasBudgetStoppedRecertification, issueCertificate } from "@open-team/db/rehearsal";
import { useTestDb } from "@open-team/db/testing";
import { DEFAULT_AGENT_MODEL, ScriptedLlmClient } from "@open-team/llm";
import { afterEach, describe, expect, it } from "vitest";
import type { AppDeps } from "../deps.ts";
import { BIG_ORDER, NORMAL_ORDER, addCase, orderScript, scenarioOf, startRehearsalWorld, withOrderRule, type RehearsalWorld } from "./__fixtures__/world.ts";
import { expireJobCertificate, reRehearsalStep } from "./re-rehearse.ts";
import { runRehearsalSuite } from "./suite.ts";

const T = useTestDb();
let world: RehearsalWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

const SURGE = { id: "F-05", sku: "BEAN-HOUSE", multiplier: 3, noticeEmail: false } as const;
const HOUR = 60 * 60 * 1000;

/** 試験を1件足して一度走らせ（合格証は指紋がないので出ない）、その走行に結びつけた有効な合格証を置く */
async function setup(order: typeof NORMAL_ORDER | typeof BIG_ORDER, modelId = DEFAULT_AGENT_MODEL, quantityMax: number | null = 50) {
  const { db, url } = T();
  const w = (world = await startRehearsalWorld(db, url, { agentDefinition: (h) => withOrderRule(h, quantityMax === null ? {} : { quantityMax }) }));
  await addCase(w, scenarioOf("豆の発注が多すぎる", [SURGE], { seed: 31 }));
  const first = await runRehearsalSuite(w.deps(new ScriptedLlmClient(orderScript(order))), {
    ctx: w.ws.ctx,
    requesterId: w.ws.userId,
    subject: { jobId: w.agent.jobId },
    trigger: "initial",
    seed: 77,
    modelId,
  });
  const cert = await db.transaction((tx) =>
    issueCertificate(tx, w.ws.ctx, {
      jobId: w.agent.jobId,
      runId: first.run.id,
      policyHash: "a".repeat(64),
      toolHashes: [],
      modelId,
      caseSetHash: "b".repeat(64),
      caseCount: 1,
      summary: {},
      costUsd: "0.100000",
      certificateHash: "c".repeat(64),
      now: w.clock.now(),
    }),
  );
  w.clock.advance(HOUR);
  const tick = (llm: ScriptedLlmClient) => reRehearsalStep.run(w.deps(llm) as unknown as AppDeps, w.clock.now());
  return { w, db, first, cert, tick };
}

async function runsOf(w: RehearsalWorld) {
  const r = await w.db.query<{ id: string; trigger: string; reason: string | null; seed: number; model_id: string; certificate_id: string | null; status: string }>(
    "SELECT id, trigger, reason, seed, model_id, certificate_id, status FROM rehearsal_runs WHERE job_id = $1 ORDER BY created_at, id",
    [w.agent.jobId],
  );
  return r.rows;
}

describe("合格証の失効と自動の再リハーサル", () => {
  it("広げる変更で切れたら、tick が今の試験だけで再リハーサルして新しい合格証を出す（同じシード・Gemini の生成なし）。次の tick は何もしない", async () => {
    const { w, db, first, cert, tick } = await setup(NORMAL_ORDER);
    // 有効な合格証があるうちは何もしない
    expect(await tick(new ScriptedLlmClient(orderScript(NORMAL_ORDER)))).toEqual({ reRehearsals: 0 });

    const revoked = await expireJobCertificate(w.deps(new ScriptedLlmClient([])), w.ws.ctx, w.agent.jobId, "widen");
    expect(revoked?.id).toBe(cert.id);
    const llm = new ScriptedLlmClient(orderScript(NORMAL_ORDER));
    expect(await tick(llm)).toEqual({ reRehearsals: 1 });

    const runs = await runsOf(w);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.id).toBe(first.run.id);
    expect(runs[1]).toMatchObject({ trigger: "recertify", reason: "widen", seed: 77, model_id: DEFAULT_AGENT_MODEL, status: "done" });
    expect(runs[1]!.certificate_id).not.toBeNull();
    const fresh = await db.query<{ revoked_at: Date | null; model_id: string }>("SELECT revoked_at, model_id FROM rehearsal_certificates WHERE id = $1", [runs[1]!.certificate_id]);
    expect(fresh.rows[0]).toMatchObject({ revoked_at: null });
    // 古い合格証は widen で切れたまま（superseded に書き換えない）
    const old = await db.query<{ revoke_reason: string }>("SELECT revoke_reason FROM rehearsal_certificates WHERE id = $1", [cert.id]);
    expect(old.rows[0]?.revoke_reason).toBe("widen");
    // 新しい状況は作らない
    const cases = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM rehearsal_cases WHERE job_id = $1", [w.agent.jobId]);
    expect(cases.rows[0]?.n).toBe("1");

    w.clock.advance(HOUR);
    expect(await tick(new ScriptedLlmClient(orderScript(NORMAL_ORDER)))).toEqual({ reRehearsals: 0 });
    expect(await runsOf(w)).toHaveLength(2);
  }, 180_000);

  it("モデルが変わったら、tick が有効な合格証を model で切って今のモデルで再リハーサルする", async () => {
    const { w, db, cert, tick } = await setup(NORMAL_ORDER, "gemini-old");
    expect(await tick(new ScriptedLlmClient(orderScript(NORMAL_ORDER)))).toEqual({ reRehearsals: 1 });
    const old = await db.query<{ revoke_reason: string }>("SELECT revoke_reason FROM rehearsal_certificates WHERE id = $1", [cert.id]);
    expect(old.rows[0]?.revoke_reason).toBe("model");
    const runs = await runsOf(w);
    expect(runs.at(-1)).toMatchObject({ trigger: "recertify", reason: "model", model_id: DEFAULT_AGENT_MODEL, status: "done" });
    expect(runs.at(-1)!.certificate_id).not.toBeNull();
    const audit = await db.query<{ event_type: string }>("SELECT event_type FROM audit_logs WHERE workspace_id = $1 AND event_type LIKE 'rehearsal.certificate_%' ORDER BY seq", [w.ws.workspaceId]);
    expect(audit.rows.map((r) => r.event_type)).toEqual(["rehearsal.certificate_issued", "rehearsal.certificate_revoked", "rehearsal.certificate_issued"]);
  }, 180_000);

  it("不合格なら合格証を出さず、走行は残る。毎分は繰り返さない（合格証がないので本番の auto は止まったまま）", async () => {
    // ガードのない定義で大きな発注がすり抜ける
    const { w, db, first, tick } = await setup(BIG_ORDER, DEFAULT_AGENT_MODEL, null);
    expect(first.counts).toMatchObject({ withControl: { slipped: 1 } });
    await expireJobCertificate(w.deps(new ScriptedLlmClient([])), w.ws.ctx, w.agent.jobId, "widen");
    expect(await tick(new ScriptedLlmClient(orderScript(BIG_ORDER)))).toEqual({ reRehearsals: 1 });
    const runs = await runsOf(w);
    expect(runs.at(-1)).toMatchObject({ trigger: "recertify", reason: "widen", certificate_id: null, status: "done" });
    const active = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM rehearsal_certificates WHERE job_id = $1 AND revoked_at IS NULL", [w.agent.jobId]);
    expect(active.rows[0]?.n).toBe("0");
    expect(w.logs.records.some((r) => r.event === "rehearsal.recertify_not_passed")).toBe(true);
    // 切れたあとに走行があるので、次の tick は拾い直さない
    w.clock.advance(HOUR);
    expect(await tick(new ScriptedLlmClient(orderScript(BIG_ORDER)))).toEqual({ reRehearsals: 0 });
    expect(await runsOf(w)).toHaveLength(runs.length);
  }, 180_000);

  it("D-107：再リハーサルが費用の上限（担当の1日）で止まったら、その日は拾い直さず、翌日の tick で1回やり直す。止まっている間は画面用の印が立つ", async () => {
    const { w, db, tick } = await setup(NORMAL_ORDER);
    await expireJobCertificate(w.deps(new ScriptedLlmClient([])), w.ws.ctx, w.agent.jobId, "widen");
    // 担当の今日の費用を1日の上限（1）の手前にする：最初の呼び出しの見積もりで Kernel の agent_day_usd が止める
    await db.query(
      `INSERT INTO usage_records (workspace_id, agent_id, provider, model, phase, input_tokens, output_tokens, estimated_cost_usd, cost_usd, latency_ms, prompt_hash, created_at)
       VALUES ($1, $2, 'google', 'm', 'plan', 1, 1, 0.99, 0.99, 1, 'h', $3)`,
      [w.ws.workspaceId, w.agent.agentId, w.clock.now()],
    );
    expect(await tick(new ScriptedLlmClient(orderScript(NORMAL_ORDER)))).toEqual({ reRehearsals: 1 });
    const stopped = (await runsOf(w)).at(-1)!;
    expect(stopped).toMatchObject({ trigger: "recertify", status: "failed", certificate_id: null });
    const aborted = await db.query<{ abort_reason: string | null }>("SELECT abort_reason FROM rehearsal_scenarios WHERE rehearsal_run_id = $1", [stopped.id]);
    expect(aborted.rows.map((r) => r.abort_reason)).toEqual(["budget"]);
    expect(await hasBudgetStoppedRecertification(db, w.ws.ctx, [w.agent.jobId])).toBe(true);
    // 同じ日（1時間後）は拾い直さない（毎分同じ上限に当たるだけ）
    w.clock.advance(HOUR);
    expect(await tick(new ScriptedLlmClient(orderScript(NORMAL_ORDER)))).toEqual({ reRehearsals: 0 });
    // 翌日（Asia/Tokyo の0時を越えた）：今日の費用は 0 に戻るので、やり直して合格証が戻る
    w.clock.advance(24 * HOUR);
    expect(await tick(new ScriptedLlmClient(orderScript(NORMAL_ORDER)))).toEqual({ reRehearsals: 1 });
    const runs = await runsOf(w);
    expect(runs.at(-1)).toMatchObject({ trigger: "recertify", status: "done" });
    expect(runs.at(-1)!.certificate_id).not.toBeNull();
    expect(await hasBudgetStoppedRecertification(db, w.ws.ctx, [w.agent.jobId])).toBe(false);
    // 合格したあとは何もしない
    w.clock.advance(24 * HOUR);
    expect(await tick(new ScriptedLlmClient(orderScript(NORMAL_ORDER)))).toEqual({ reRehearsals: 0 });
  }, 180_000);
});
