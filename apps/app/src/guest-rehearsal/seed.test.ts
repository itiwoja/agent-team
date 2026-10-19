// ゲストの「リハーサルの結果」（事前に走らせた固定の結果。D-97）：入った直後から SCR-021 に結果が出る。
// 12件中10件を統制が止め、2件がすり抜け（締める提案つき）、防いだ損害の金額つき。合格証はまだない。Gemini は呼ばず、費用の記録も足さない
import { useTestDb } from "@open-team/db/testing";
import { describe, expect, it } from "vitest";
import type { AskDetailResponse } from "../asks/contract.ts";
import type { CheckResponse } from "../check/contract.ts";
import { call, enterGuest, guestHarness } from "../check/test-helpers.ts";
import { loadGuestRehearsalFixture } from "./seed.ts";

const T = useTestDb();

interface ResultBody {
  run: { id: string; status: string; trigger: string };
  counts: { total: number; stoppedByKernel: number; stoppedByAgent: number; withoutControl: { harmed: number; damageJpy: number } | null; withControl: { slipped: number; damageJpy: number }; afterTighten: unknown };
  provisional: boolean;
  preventedDamageJpy: number | null;
  scenarios: Array<{ id: string; caseId: string; ordinal: number; verdict: string | null; stoppedBy: string | null; damageJpy: number | null; withoutControlDamageJpy: number | null; preventedDamageJpy: number | null; damageBreakdown: { totalJpy: number } | null }>;
  proposals: Array<{ id: string; jobId: string; label: string; patch: Array<{ op: string; path: string }>; fixes: string[] }>;
}

describe("ゲストのリハーサルの結果", () => {
  it("入った直後の GET /asks/:id が結果あり・合格証なしで、結果の取得が 12件中10件を統制が止めた・2件がすり抜け・締める提案つきを返す", async () => {
    const { db } = T();
    const { t } = guestHarness(db);
    const g = await enterGuest(t);
    const fx = loadGuestRehearsalFixture();

    const detail = await call<AskDetailResponse>(t, g, "GET", `/api/v1/asks/${g.firstAskId}`);
    expect(detail.status).toBe(200);
    const view = detail.body.rehearsal;
    expect(view).toMatchObject({ status: "done", certificate: "none", certificateState: "none", certificateRevokeReason: null, certificateCaseCount: null, certificateIssuedAt: null, recertifying: false });
    // 担当の仕事の再リハーサル（依頼の走行の一覧には出ない）が走っている間は recertifying（画面の「再リハーサル中」）
    await db.query(
      `INSERT INTO rehearsal_runs (workspace_id, job_id, trigger, reason, status, seed, model_id, started_at)
       SELECT $1, m.job_id, 'recertify', 'case_added', 'running', 0, 'gemini-test', now() FROM ask_members m WHERE m.ask_id = $2 LIMIT 1`,
      [g.workspaceId, g.firstAskId],
    );
    const during = await call<AskDetailResponse>(t, g, "GET", `/api/v1/asks/${g.firstAskId}`);
    expect(during.body.rehearsal?.recertifying).toBe(true);
    // 防いだ損害・損害は事前に走らせた値（fixture。手で書いた数字ではなく build.test.ts が決定論で計算した値）
    expect(view?.preventedDamageJpy).toBe(fx.run.prevented_damage_jpy);
    expect(view?.damageJpy).toBe(fx.run.damage_jpy);
    expect(view?.preventedDamageJpy).toBeGreaterThan(0);
    expect(view?.finishedAt).not.toBeNull();

    const res = await call<ResultBody>(t, g, "GET", `/api/v1/workspaces/${g.workspaceId}/rehearsals/${view!.runId}/result`);
    expect(res.status).toBe(200);
    const r = res.body;
    expect(r.provisional).toBe(false);
    expect(r.run).toMatchObject({ status: "done", trigger: "seed" });
    expect(r.counts).toMatchObject({ total: 12, stoppedByKernel: 10, stoppedByAgent: 0, withControl: { slipped: 2 }, afterTighten: null });
    expect(r.counts.withoutControl?.damageJpy).toBeGreaterThan(r.counts.withControl.damageJpy);
    expect(r.preventedDamageJpy).toBe(view?.preventedDamageJpy);
    // 状況ごと：防いだ損害の合計が走行の値と合う。式と元の値が開ける
    expect(r.scenarios).toHaveLength(12);
    expect(r.scenarios.reduce((sum, x) => sum + (x.preventedDamageJpy ?? 0), 0)).toBe(r.preventedDamageJpy);
    const slipped = r.scenarios.filter((x) => x.verdict === "fail");
    expect(slipped).toHaveLength(2);
    expect(slipped.every((x) => x.stoppedBy === "none" && (x.damageJpy ?? 0) > 0 && x.damageBreakdown !== null)).toBe(true);
    expect(r.scenarios.filter((x) => x.verdict === "pass").every((x) => x.stoppedBy === "kernel")).toBe(true);
    // 締める提案：すり抜けた状況を塞ぐ。id は [適用]（proposalId）に渡せる
    expect(r.proposals.length).toBeGreaterThan(0);
    const failedCases = slipped.map((x) => x.caseId);
    for (const p of r.proposals) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.patch.length).toBeGreaterThan(0);
      expect(p.fixes.length).toBeGreaterThan(0);
      for (const f of p.fixes) expect(failedCases).toContain(f);
    }
    expect([...new Set(r.proposals.flatMap((p) => p.fixes))].sort()).toEqual([...failedCases].sort());

    // 事前に走らせた結果は、見てほしいもの（SCR-019）に「新しい報告」として出ない（結果は依頼のページに出る）
    const check = (await call<CheckResponse>(t, g, "GET", "/api/v1/check")).body;
    expect(check.items.map((i) => i.kind)).not.toContain("rehearsal");

    // Gemini を呼んでいない・費用を食っていない・監査ログは作成の1件だけ・合格証は出ていない
    expect((await db.query("SELECT 1 FROM usage_records")).rowCount).toBe(0);
    expect((await db.query<{ event_type: string }>("SELECT event_type FROM audit_logs")).rows.map((x) => x.event_type)).toEqual(["workspace.created"]);
    expect((await db.query("SELECT 1 FROM rehearsal_certificates")).rowCount).toBe(0);
    const cases = await db.query<{ n: string; shadow: string }>("SELECT count(*)::text AS n, count(first_shadow_damage_jpy)::text AS shadow FROM rehearsal_cases WHERE removed_at IS NULL");
    expect(cases.rows[0]).toEqual({ n: "12", shadow: "12" });
    // すり抜けた状況の世界（sim-world の走行）が結びついている
    expect((await db.query("SELECT 1 FROM rehearsal_scenarios WHERE verdict = 'fail' AND governed_execution_id IS NOT NULL")).rowCount).toBe(2);
  }, 60_000);

  it("[適用] のルートが proposalId を受けられる（差分は提案の差分で、設定変更として保存される）。知らない proposalId は 404", async () => {
    const { db } = T();
    const { t } = guestHarness(db);
    const g = await enterGuest(t);
    const view = (await call<AskDetailResponse>(t, g, "GET", `/api/v1/asks/${g.firstAskId}`)).body.rehearsal!;
    const base = `/api/v1/workspaces/${g.workspaceId}/rehearsals/${view.runId}`;
    const result = (await call<ResultBody>(t, g, "GET", `${base}/result`)).body;
    const p = result.proposals[0]!;
    expect((await call(t, g, "POST", `${base}/tightening`, { proposalId: "tp-000000000000" })).status).toBe(404);
    // 再試験は審査員が押したときに走る（Gemini）。ここでは適用だけ確かめる（retest: false）
    const applied = await call<{ change: { status: string; patch: unknown; jobId: string | null } }>(t, g, "POST", `${base}/tightening`, { proposalId: p.id, retest: false });
    expect(applied.status).toBe(200);
    expect(applied.body.change).toMatchObject({ status: "applied", patch: p.patch, jobId: p.jobId });
  }, 60_000);

  it("ゲストどうしで結果が混ざらない：別のゲストの走行の結果は 404、それぞれ別の走行・別の状況の行", async () => {
    const { db } = T();
    const { t } = guestHarness(db);
    const a = await enterGuest(t);
    const b = await enterGuest(t);
    const runOf = async (g: typeof a) => (await call<AskDetailResponse>(t, g, "GET", `/api/v1/asks/${g.firstAskId}`)).body.rehearsal!;
    const ra = await runOf(a);
    const rb = await runOf(b);
    expect(ra.runId).not.toBe(rb.runId);
    expect(ra.preventedDamageJpy).toBe(rb.preventedDamageJpy);
    // A のセッションで B の走行を指す：ワークスペースで絞られる
    expect((await call(t, a, "GET", `/api/v1/workspaces/${a.workspaceId}/rehearsals/${rb.runId}/result`)).status).toBe(404);
    expect((await call(t, a, "GET", `/api/v1/workspaces/${b.workspaceId}/rehearsals/${rb.runId}/result`)).status).toBe(404);
    expect((await call(t, a, "POST", `/api/v1/workspaces/${a.workspaceId}/rehearsals/${rb.runId}/tightening`, { proposalId: "tp-000000000000" })).status).toBe(404);
    // 行は混ざらない（走行・試験・状況はワークスペースごとに2倍）
    const perWs = await db.query<{ workspace_id: string; n: string }>("SELECT workspace_id, count(*)::text AS n FROM rehearsal_scenarios GROUP BY workspace_id");
    expect(perWs.rows.map((x) => x.n)).toEqual(["12", "12"]);
    const ids = await db.query<{ n: string }>("SELECT count(DISTINCT id)::text AS n FROM rehearsal_scenarios");
    expect(ids.rows[0]?.n).toBe("24");
  }, 90_000);
});
