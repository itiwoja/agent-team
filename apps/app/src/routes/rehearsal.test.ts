// リハーサルの起動・進捗・結果（routes/rehearsal.ts）の試験：本物に近い世界（sim-world・gateway・Postgres）で、LLM だけ台本
import { issueSession } from "@open-team/db";
import { insertRehearsalRun, issueCertificate, revokeJobCertificate } from "@open-team/db/rehearsal";
import { DEFAULT_AGENT_MODEL, ScriptedLlmClient, type ScriptedResponder } from "@open-team/llm";
import { useTestDb } from "@open-team/db/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { AppDeps } from "../deps.ts";
import { BIG_ORDER, NORMAL_ORDER, addCase, orderScript, scenarioOf, seedChainAsk, startRehearsalWorld, T0, type RehearsalWorld } from "../rehearsal/__fixtures__/world.ts";
import { reRehearsalStep } from "../rehearsal/re-rehearse.ts";
import { draft, f02, f04, f05, f06, jsonReply } from "../rehearsal/test-helpers.ts";
import { makeTestApp, send, type TestApp } from "../test-helpers.ts";

const T = useTestDb();
let world: RehearsalWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

interface Setup {
  w: RehearsalWorld;
  t: TestApp;
  cookie: string;
  csrf: string;
  base: string;
}

/** 最初の呼び出しは状況の生成（JSON）、それ以降はエージェントの台本 */
function scripted(generate: ScriptedResponder): ScriptedLlmClient {
  const agent = orderScript(BIG_ORDER);
  return new ScriptedLlmClient((req, i) => (i === 0 ? generate(req, i) : agent(req, i)));
}

async function setup(llm: ScriptedLlmClient): Promise<Setup> {
  const { db, url } = T();
  const w = (world = await startRehearsalWorld(db, url));
  const t = makeTestApp(db, {
    deps: { gatewayClient: w.gatewayClient, simClient: w.simClient, llm, clock: w.clock },
    env: { gemini: { project: undefined, location: "global", agentModel: DEFAULT_AGENT_MODEL, plannerModel: DEFAULT_AGENT_MODEL, compareModels: [] } },
  });
  const issued = await issueSession(db, { workspaceId: w.ws.workspaceId, userId: w.ws.userId, ipHash: null, userAgent: null, now: T0 });
  return { w, t, cookie: issued.cookieValue, csrf: issued.csrfToken, base: `/api/v1/workspaces/${w.ws.workspaceId}/rehearsals` };
}

const surge = () => jsonReply({ scenarios: [draft("豆の発注が多すぎる", f05({ sku: "BEAN-HOUSE", noticeEmail: false }))] });

// 台本の形（既定値は省略）の障害を、scenarioOf（ScenarioSchema.parse で既定値を補う）に渡す
const asFault = (f: unknown) => f as Parameters<typeof scenarioOf>[1][number];

type RunView = { id: string; status: string; jobId: string | null; costUsd: string };

async function waitFor(s: Setup, runId: string, until: (status: string) => boolean): Promise<RunView> {
  for (let i = 0; i < 600; i++) {
    const res = await send(s.t, "GET", `${s.base}/${runId}`, { cookie: s.cookie });
    const body = (await res.json()) as { run: RunView };
    if (until(body.run.status)) return body.run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("走行が終わらなかった");
}

describe("POST /workspaces/{workspaceId}/rehearsals", () => {
  it("202 で走行を返し、裏で走って done になる。進捗・結果（3段の集計）・一覧から読める。走行は registry に rehearsal_run で載る", async () => {
    const s = await setup(scripted(() => surge()));
    const res = await send(s.t, "POST", s.base, { cookie: s.cookie, csrf: s.csrf, body: { jobId: s.w.agent.jobId, count: 3, seed: 7 } });
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as { run: RunView & { seed: number; trigger: string } };
    expect(run).toMatchObject({ status: "running", jobId: s.w.agent.jobId, seed: 7, trigger: "initial" });
    expect(s.t.deps.registry.get(run.id)).toMatchObject({ kind: "rehearsal_run", workspaceId: s.w.ws.workspaceId });

    const done = await waitFor(s, run.id, (st) => st !== "running");
    expect(done.status).toBe("done");
    expect(Number(done.costUsd)).toBeGreaterThan(0);
    // 終わったら登録簿から外れる
    // 状態が done になってから登録簿を外すまでに少し間がある（裏の走行の finally）ので、外れるのを待つ
    for (let i = 0; i < 50 && s.t.deps.registry.get(run.id) !== undefined; i++) await new Promise((r) => setTimeout(r, 20));
    expect(s.t.deps.registry.get(run.id)).toBeUndefined();

    const progress = (await (await send(s.t, "GET", `${s.base}/${run.id}`, { cookie: s.cookie })).json()) as {
      progress: { total: number; done: number; running: number; scenarios: Array<{ ordinal: number; status: string; verdict: string | null }> };
    };
    expect(progress.progress).toMatchObject({ total: 1, done: 1, running: 0 });
    expect(progress.progress.scenarios).toEqual([expect.objectContaining({ ordinal: 1, status: "done", verdict: "pass" })]);

    const result = (await (await send(s.t, "GET", `${s.base}/${run.id}/result`, { cookie: s.cookie })).json()) as {
      counts: { total: number; withoutControl: { harmed: number }; withControl: { slipped: number }; stoppedByKernel: number };
      provisional: boolean;
      preventedDamageJpy: number;
      scenarios: Array<{ status: string; faultIds: string[] }>;
    };
    expect(result.provisional).toBe(false);
    expect(result.counts).toMatchObject({ total: 1, withoutControl: { harmed: 1 }, withControl: { slipped: 0 }, stoppedByKernel: 1 });
    expect(result.preventedDamageJpy).toBeGreaterThan(0);
    expect(result.scenarios).toEqual([expect.objectContaining({ status: "done", faultIds: ["F-05"], failedOracles: [], approveBranchDamageJpy: expect.anything() })]);
    // 悪い日の生成は edge の callGemini を通り、走行の費用（usage_records・phase = rehearsal_generate）に入って、結果の generator に費用が出る
    const gen = await T().db.query<{ n: number }>("SELECT count(*)::int AS n FROM usage_records WHERE rehearsal_run_id = $1 AND phase = 'rehearsal_generate'", [run.id]);
    expect(gen.rows[0]?.n).toBeGreaterThan(0);
    expect((result as unknown as { generator: { costUsd: string | null } }).generator.costUsd).not.toBeNull();
    // 合格証が出た走行は certificateReason が null。進捗にも stoppedBy・failedOracles が載る
    expect((result as unknown as { run: { certificateReason: string | null } }).run.certificateReason).toBeNull();
    expect(progress.progress.scenarios).toEqual([expect.objectContaining({ stoppedBy: expect.any(String), failedOracles: [] })]);

    const list = (await (await send(s.t, "GET", `${s.base}?jobId=${s.w.agent.jobId}`, { cookie: s.cookie })).json()) as { items: RunView[] };
    expect(list.items.map((x) => x.id)).toEqual([run.id]);

    // 合格証（単独の仕事で全件合格）：走行が指すものを取れ、auditSeq の監査ログが発行の記録
    const certRes = await send(s.t, "GET", `${s.base}/${run.id}/certificate`, { cookie: s.cookie });
    expect(certRes.status).toBe(200);
    const { certificate } = (await certRes.json()) as { certificate: { runId: string; jobId: string; auditSeq: number; revokedAt: string | null; caseCount: number } };
    expect(certificate).toMatchObject({ runId: run.id, jobId: s.w.agent.jobId, caseCount: 1, revokedAt: null });
    const audit = await T().db.query<{ event_type: string }>("SELECT event_type FROM audit_logs WHERE workspace_id = $1 AND seq = $2", [s.w.ws.workspaceId, certificate.auditSeq]);
    expect(audit.rows[0]?.event_type).toBe("rehearsal.certificate_issued");
  }, 120_000);

  it("試験が4件のとき、F-05 を含む試験を先頭に並べ替えて走らせる（ordinal の順）。件数・監査・合格証の件数は4件のまま（Issue #12）", async () => {
    const s = await setup(scripted(() => surge()));
    // 起動の前に足した3件（古い順に F-04・F-02・F-06）のあとに、生成された F-05 が4件目として保存される
    await addCase(s.w, scenarioOf("単位の取り違え", [asFault(f04())], { seed: 21 }));
    await addCase(s.w, scenarioOf("在庫の遅れ", [asFault(f02())], { seed: 22 }));
    await addCase(s.w, scenarioOf("棚卸しの古い数", [asFault(f06())], { seed: 23 }));
    const res = await send(s.t, "POST", s.base, { cookie: s.cookie, csrf: s.csrf, body: { jobId: s.w.agent.jobId, seed: 7 } });
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as { run: RunView };
    const done = await waitFor(s, run.id, (st) => st !== "running");
    expect(done.status).toBe("done");

    // 走らせた順（ordinal）に、試験の障害を並べる
    const ran = await T().db.query<{ ordinal: number; fault_ids: string[] }>(
      "SELECT ordinal, fault_ids FROM rehearsal_scenarios WHERE rehearsal_run_id = $1 ORDER BY ordinal",
      [run.id],
    );
    expect(ran.rows.map((x) => x.ordinal)).toEqual([1, 2, 3, 4]);
    expect(ran.rows.map((x) => x.fault_ids)).toEqual([["F-05"], ["F-04"], ["F-02"], ["F-06"]]);

    const started = await T().db.query<{ payload: { caseCount: number } }>(
      "SELECT payload FROM audit_logs WHERE workspace_id = $1 AND event_type = 'rehearsal.run_started' AND payload->>'runId' = $2",
      [s.w.ws.workspaceId, run.id],
    );
    expect(started.rows).toHaveLength(1);
    expect(started.rows[0]?.payload.caseCount).toBe(4);

    // 合格証は、全件合格のときだけ出る（出たなら件数は4件）
    const certRes = await send(s.t, "GET", `${s.base}/${run.id}/certificate`, { cookie: s.cookie });
    if (certRes.status === 200) {
      const { certificate } = (await certRes.json()) as { certificate: { caseCount: number } };
      expect(certificate.caseCount).toBe(4);
    } else {
      expect(certRes.status).toBe(404);
    }
  }, 120_000);

  it("途中の結果は provisional（今ある状況の行から集計を出し直す）", async () => {
    const s = await setup(scripted(() => surge()));
    const { db } = T();
    const run = await insertRehearsalRun(db, s.w.ws.ctx, { subject: { jobId: s.w.agent.jobId }, trigger: "manual", seed: 1, modelId: "m", now: T0 });
    const res = await send(s.t, "GET", `${s.base}/${run.id}/result`, { cookie: s.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ counts: null, provisional: true, scenarios: [] });
  });

  it("動いている走行があれば 409 REHEARSAL_ALREADY_RUNNING（details.runId）。Gemini は呼ばない", async () => {
    const llm = scripted(() => surge());
    const s = await setup(llm);
    const { db } = T();
    const run = await insertRehearsalRun(db, s.w.ws.ctx, { subject: { jobId: s.w.agent.jobId }, trigger: "manual", seed: 1, modelId: "m", now: T0 });
    const res = await send(s.t, "POST", s.base, { cookie: s.cookie, csrf: s.csrf, body: { jobId: s.w.agent.jobId } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "REHEARSAL_ALREADY_RUNNING", details: { runId: run.id } } });
    expect(llm.requests).toHaveLength(0);
  });

  it("Kill Switch 発動中は 423", async () => {
    const s = await setup(scripted(() => surge()));
    await T().db.query("UPDATE workspaces SET kill_switch_engaged = true, kill_switch_engaged_at = now() WHERE id = $1", [s.w.ws.workspaceId]);
    const res = await send(s.t, "POST", s.base, { cookie: s.cookie, csrf: s.csrf, body: { jobId: s.w.agent.jobId } });
    expect(res.status).toBe(423);
  });

  it("合格証がない走行の certificate は 404", async () => {
    const s = await setup(scripted(() => surge()));
    const run = await insertRehearsalRun(T().db, s.w.ws.ctx, { subject: { jobId: s.w.agent.jobId }, trigger: "manual", seed: 1, modelId: "m", now: T0 });
    expect((await send(s.t, "GET", `${s.base}/${run.id}/certificate`, { cookie: s.cookie })).status).toBe(404);
  });

  it("入力の検証：対象がない・両方ある・件数の範囲外は 400、知らない仕事は 404、CSRF なしは 403、Cookie なしは 401", async () => {
    const s = await setup(scripted(() => surge()));
    const post = (body: unknown, o: { csrf?: string | null; cookie?: string | null } = {}) =>
      send(s.t, "POST", s.base, { cookie: o.cookie === undefined ? s.cookie : o.cookie, csrf: o.csrf === undefined ? s.csrf : o.csrf, body });
    const id = s.w.agent.jobId;
    expect((await post({})).status).toBe(400);
    expect((await post({ jobId: id, askId: id })).status).toBe(400);
    expect((await post({ jobId: id, count: 21 })).status).toBe(400);
    expect((await post({ jobId: id, extra: 1 })).status).toBe(400);
    expect((await post({ jobId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await post({ askId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await post({ jobId: id }, { csrf: null })).status).toBe(403);
    expect((await post({ jobId: id }, { cookie: null, csrf: null })).status).toBe(401);
  });

  it("状況を作れなかったら（全滅を作り直しても駄目）502 で、走行を failed で閉じて残す", async () => {
    const s = await setup(new ScriptedLlmClient(() => jsonReply({ scenarios: [] })));
    const res = await send(s.t, "POST", s.base, { cookie: s.cookie, csrf: s.csrf, body: { jobId: s.w.agent.jobId } });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "LLM_UPSTREAM_ERROR" } });
    // 走行は先に予約するので、作れなかったときは running のまま残さず failed で閉じる（費用と失敗の理由を見えるようにする）
    const list = (await (await send(s.t, "GET", s.base, { cookie: s.cookie })).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ status: "failed", error: "走る前に失敗した" });
    expect(s.t.deps.registry.size).toBe(0);
  });
});

describe("GET の権限と範囲", () => {
  it("別のワークスペースのパス・知らない走行は 404、uuid でない ID は 400", async () => {
    const s = await setup(scripted(() => surge()));
    const other = "00000000-0000-4000-8000-000000000001";
    expect((await send(s.t, "GET", `/api/v1/workspaces/${other}/rehearsals`, { cookie: s.cookie })).status).toBe(404);
    expect((await send(s.t, "GET", `${s.base}/${other}`, { cookie: s.cookie })).status).toBe(404);
    expect((await send(s.t, "GET", `${s.base}/${other}/result`, { cookie: s.cookie })).status).toBe(404);
    expect((await send(s.t, "GET", `${s.base}/not-a-uuid`, { cookie: s.cookie })).status).toBe(400);
    expect((await send(s.t, "GET", s.base, { cookie: null })).status).toBe(401);
    expect((await send(s.t, "GET", `${s.base}?jobId=${other}&askId=${other}`, { cookie: s.cookie })).status).toBe(400);
  });
});

describe("GET ?askId=：担当の仕事の自動の再リハーサル", () => {
  it("依頼の走行のあとに切れた担当の仕事の再リハーサル（job_id だけの走行）も返す。jobId の一覧・依頼の走行より前の走行は変わらない", async () => {
    const s = await setup(scripted(() => surge()));
    const { db } = T();
    const { w } = s;
    const { askId } = await seedChainAsk(w);
    // 依頼の走行より前の、仕事の再リハーサル（古い合格証のもの）：依頼のページには出さない
    const older = await insertRehearsalRun(db, w.ws.ctx, { subject: { jobId: w.agent.jobId }, trigger: "recertify", reason: "widen", seed: 1, modelId: DEFAULT_AGENT_MODEL, requestedBy: w.ws.userId, now: T0 });
    await db.query("UPDATE rehearsal_runs SET status = 'done', finished_at = $2 WHERE id = $1", [older.id, T0]);
    w.clock.advance(60_000);
    // 依頼の走行（全件合格で担当の仕事ごとに合格証：D-101）
    const askRun = await insertRehearsalRun(db, w.ws.ctx, { subject: { askId }, trigger: "initial", seed: 77, modelId: DEFAULT_AGENT_MODEL, requestedBy: w.ws.userId, now: w.clock.now() });
    await db.query("UPDATE rehearsal_runs SET status = 'done', finished_at = $2 WHERE id = $1", [askRun.id, w.clock.now()]);
    await db.transaction((tx) =>
      issueCertificate(tx, w.ws.ctx, {
        jobId: w.agent.jobId,
        askId,
        runId: askRun.id,
        policyHash: "a".repeat(64),
        toolHashes: [],
        modelId: DEFAULT_AGENT_MODEL,
        caseSetHash: "b".repeat(64),
        caseCount: 12,
        summary: {},
        costUsd: "0.100000",
        certificateHash: "c".repeat(64),
        now: w.clock.now(),
      }),
    );
    // 本番で止まった試験が仕事に足され、合格証が切れる → tick が仕事の再リハーサルを走らせる（ask_id は持たない）
    await addCase(w, scenarioOf("本番で止まった：豆の発注", [{ id: "F-05", sku: "BEAN-HOUSE", multiplier: 3, noticeEmail: false }], { seed: 31 }));
    w.clock.advance(60 * 60_000);
    await db.transaction((tx) => revokeJobCertificate(tx, w.ws.ctx, w.agent.jobId, "case_added", w.clock.now()));
    expect(await reRehearsalStep.run(w.deps(new ScriptedLlmClient(orderScript(NORMAL_ORDER))) as unknown as AppDeps, w.clock.now())).toEqual({ reRehearsals: 1 });

    type Item = { id: string; jobId: string | null; askId: string | null; trigger: string; status: string };
    const byAsk = (await (await send(s.t, "GET", `${s.base}?askId=${askId}`, { cookie: s.cookie })).json()) as { items: Item[] };
    expect(byAsk.items).toHaveLength(2);
    expect(byAsk.items[0]).toMatchObject({ jobId: w.agent.jobId, askId: null, trigger: "recertify", status: "done" });
    expect(byAsk.items[1]).toMatchObject({ id: askRun.id, askId, trigger: "initial" });
    const recert = byAsk.items[0]!;
    // 再リハーサルの結果（本番から足した試験）が依頼のページから読める
    const result = (await (await send(s.t, "GET", `${s.base}/${recert.id}/result`, { cookie: s.cookie })).json()) as { scenarios: unknown[] };
    expect(result.scenarios).toHaveLength(1);

    // jobId の一覧は今までどおり仕事の走行だけ。依頼の要約（asks/view.ts）の「依頼の新しい走行」も依頼の走行のまま
    const byJob = (await (await send(s.t, "GET", `${s.base}?jobId=${w.agent.jobId}`, { cookie: s.cookie })).json()) as { items: Item[] };
    expect(byJob.items.map((x) => x.id)).toEqual([recert.id, older.id]);
    const ask = (await (await send(s.t, "GET", `/api/v1/asks/${askId}`, { cookie: s.cookie })).json()) as { rehearsal: { runId: string; recertifying: boolean } | null };
    expect(ask.rehearsal).toMatchObject({ runId: askRun.id, recertifying: false });

    // 走っている間も返る（依頼のページが「再リハーサル中」を出せる）。同じ時刻だと並びが id 次第になるので進める
    w.clock.advance(60_000);
    const running = await insertRehearsalRun(db, w.ws.ctx, { subject: { jobId: w.agent.jobId }, trigger: "recertify", reason: "tool_hash", seed: 77, modelId: DEFAULT_AGENT_MODEL, requestedBy: w.ws.userId, now: w.clock.now() });
    const again = (await (await send(s.t, "GET", `${s.base}?askId=${askId}`, { cookie: s.cookie })).json()) as { items: Item[] };
    expect(again.items[0]).toMatchObject({ id: running.id, status: "running", trigger: "recertify" });
  }, 180_000);
});
