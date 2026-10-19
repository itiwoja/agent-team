import { describe, expect, it } from "vitest";
import type { AskRehearsalView, RehearsalCounts, RehearsalRun, RehearsalScenarioRow } from "../api";
import { ApiError } from "../api";
import { actionErrorText, fromResultRow, askScenarioRows, certificateLabel, certificateTone, durationText, elapsedLine, elapsedParts, expectedSeconds, faultIdsText, fromEvent, generatedCount, isScriptedRun, REAL_RUN_NOTE, SCRIPTED_MARK, generatingLine, generatingParts, generatorText, interpretationText, mergeRetestRows, pickAskRuns, pickPreviousRun, rerunNote, retestProgress, scenarioLine, stoppedByText, upsertScenario, type ScenarioVM, type PlainSummaryInput, askHeadLine, notInCatalogText, plainPhaseLine, plainSummaryLines, revokeReasonLine, USER_CASE_EXAMPLES, userCasePlaceholder } from "./rehearsal";

const row = (over: Partial<ScenarioVM> = {}): ScenarioVM => ({ id: "s1", runId: "r", caseId: "c", ordinal: 1, status: "done", faultIds: ["F-03"], verdict: "pass", stoppedBy: "kernel", decision: "approve", damageJpy: 0, withoutControlDamageJpy: 184000, preventedDamageJpy: 184000, breakdown: null, withoutBreakdown: null, ...over });

describe("状況の行", () => {
  it("誰が止めたかと防いだ損害を出す", () => {
    expect(scenarioLine(row(), "振込先の変更")).toBe("F-03 振込先の変更 → Kernel が承認へ回した ¥184,000を防いだ");
  });
  it("すり抜けは損害を出す。タイトルがなければ障害カタログの名前", () => {
    expect(scenarioLine(row({ faultIds: ["F-04"], verdict: "fail", stoppedBy: "none", decision: null, preventedDamageJpy: 0, damageJpy: 50000 }), null)).toBe("F-04 単位・桁の取り違え → すり抜けた 損害 ¥50,000");
  });
  it("止めた主体ごとの文", () => {
    expect(scenarioLine(row({ decision: "deny", preventedDamageJpy: 0 }), "x")).toContain("Kernel が止めた");
    expect(scenarioLine(row({ stoppedBy: "agent", preventedDamageJpy: 0 }), "x")).toContain("エージェント自身が止めた");
  });
  it("障害が複数なら「・」でつなぐ。ID も題もなければ矢印を省く", () => {
    expect(faultIdsText(["F-04", "F-05"])).toBe("F-04・F-05");
    expect(scenarioLine(row({ faultIds: ["F-04", "F-05"] }), "単位の取り違えと急変")).toBe("F-04・F-05 単位の取り違えと急変 → Kernel が承認へ回した ¥184,000を防いだ");
    // 題がなければ先頭の障害のカタログの名前
    expect(scenarioLine(row({ faultIds: ["F-04", "F-05"], preventedDamageJpy: 0 }), null)).toBe("F-04・F-05 単位・桁の取り違え → Kernel が承認へ回した");
    expect(scenarioLine(row({ faultIds: [], preventedDamageJpy: 0 }), null)).toBe("Kernel が承認へ回した");
    expect(scenarioLine(row({ faultIds: [] }), "自分の悪い日")).toBe("自分の悪い日 → Kernel が承認へ回した ¥184,000を防いだ");
  });
});

describe("却下した書き込みの試験の注記（D-110）", () => {
  const base = { id: "s1", caseId: "c", ordinal: 1, status: "done", faultIds: [], verdict: "pass", stoppedBy: "none", stoppedByDecision: null, damageJpy: 0, withoutControlDamageJpy: 0, preventedDamageJpy: 0, damageBreakdown: null, withoutControlDamageBreakdown: null } as unknown as RehearsalScenarioRow;
  it("結果の行の注記を行のモデルに渡す。ない行（自分の悪い日など）は null", () => {
    const note = { text: "あなたが送らなかった発注と同じ宛先（山田珈琲）への発注が…", destination: "山田珈琲", ruleLabel: "山田珈琲への発注は以後も許可", sent: [], rejected: [] };
    expect(fromResultRow({ ...base, incidentNote: note }, "r").incidentNote).toEqual(note);
    expect(fromResultRow(base, "r").incidentNote).toBeNull();
  });
});

describe("再試験の間の行の置き換え（F-088）", () => {
  const prev = [row({ id: "p1", runId: "old", caseId: "c1", ordinal: 1 }), row({ id: "p2", runId: "old", caseId: "c2", ordinal: 2, verdict: "fail", stoppedBy: "none", preventedDamageJpy: 0, damageJpy: 50000 }), row({ id: "p3", runId: "old", caseId: "c3", ordinal: 3 })];
  it("前の行を順のまま薄く残し、同じ状況の新しい行の判定が出た位置から置き換える。前になかった状況は末尾", () => {
    const merged = mergeRetestRows(prev, [row({ id: "n2", runId: "new", caseId: "c2", ordinal: 1 }), row({ id: "n9", runId: "new", caseId: "c9", ordinal: 2 })]);
    expect(merged.map((r) => r.id)).toEqual(["p1", "n2", "p3", "n9"]);
    expect(merged.map((r) => r.stale === true)).toEqual([true, false, true, false]);
    expect(merged[1]?.verdict).toBe("pass");
  });
  it("判定の前（queued・running）の新しい行では置き換えず、前の行を薄く残したまま", () => {
    const merged = mergeRetestRows(prev, [row({ id: "n1", runId: "new", caseId: "c1", status: "done" }), row({ id: "n3", runId: "new", caseId: "c3", status: "running", verdict: null })]);
    expect(merged.map((r) => r.id)).toEqual(["n1", "p2", "p3"]);
    expect(merged[2]?.stale).toBe(true);
  });
  it("新しい行がまだなければ全部薄い。終わった件数は判定の前の行を数えない", () => {
    expect(mergeRetestRows(prev, []).every((r) => r.stale)).toBe(true);
    expect(retestProgress(prev, [])).toEqual({ done: 0, total: 3 });
    expect(retestProgress(prev, [row({ id: "n1", caseId: "c1" }), row({ id: "n2", caseId: "c2", status: "running", verdict: null })])).toEqual({ done: 1, total: 3 });
  });
});

describe("SSE の畳み込み", () => {
  it("rehearsal.scenario を行にして、同じ ID は置き換える", () => {
    const vm = fromEvent({ runId: "r", scenarioId: "s1", caseId: "c", ordinal: 2, status: "done", faultIds: ["F-02"], verdict: "pass", stoppedBy: { by: "kernel", decision: "approve" }, damageJpy: 0, shadowDamageJpy: 10, preventedDamageJpy: 10 });
    expect(vm).toMatchObject({ id: "s1", stoppedBy: "kernel", decision: "approve", preventedDamageJpy: 10 });
    const rows = upsertScenario(upsertScenario([], vm!), { ...vm!, verdict: "fail" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe("fail");
  });
  it("形の合わない事象は捨てる", () => {
    expect(fromEvent(null)).toBeNull();
    expect(fromEvent({ runId: 1 })).toBeNull();
  });
});

describe("件数と合格証の文", () => {
  const c: RehearsalCounts = { total: 12, withoutControl: { harmed: 9, damageJpy: 344000 }, withControl: { slipped: 2, damageJpy: 1 }, afterTighten: { slipped: 0, damageJpy: 0 }, stoppedByKernel: 9, stoppedByAgent: 1, byKernelRule: {} };
  const v = { certificateState: "valid" as const, certificateRevokeText: null, certificateCaseCount: 14, certificateIssuedAt: "2020-10-08T09:02:00Z" };
  it("済み・まだ・切れた・試しています・もう一度試しています", () => {
    expect(certificateLabel(v, false)).toMatch(/^安全チェック済み · 14件 · /);
    expect(certificateLabel(null, false)).toBe("まだ済んでいません");
    const revoked = { ...v, certificateState: "revoked" as const, certificateRevokeText: "ツールの説明が変わったため" };
    expect(certificateLabel(revoked, false)).toBe("もう一度試します（ツールの説明が変わったため） · 1分以内に自動で始まります");
    expect(certificateLabel(revoked, true)).toBe("もう一度試しています（ツールの説明が変わったため）");
    expect(certificateLabel(v, true)).toBe("試しています");
    // 再リハーサルが費用の上限で止まった（D-107）：「1分以内に始まります」とは書かない
    expect(certificateLabel({ ...revoked, recertifyStoppedByBudget: true }, false)).toBe("もう一度試します（ツールの説明が変わったため） · 費用の上限に達したため、やり直しは止まっています（明日、自動でやり直します）");
    expect(certificateLabel({ ...revoked, recertifyStoppedByBudget: false }, false)).toContain("1分以内に自動で始まります");
  });
  it("certificateTone：なし＝灰・合格＝緑・切れた／走行中＝琥珀（見た目の区分。文は certificateLabel）", () => {
    expect(certificateTone(null, false)).toBe("none");
    expect(certificateTone({ certificateState: "none" }, false)).toBe("none");
    expect(certificateTone({ certificateState: "valid" }, false)).toBe("valid");
    expect(certificateTone({ certificateState: "revoked" }, false)).toBe("revoked");
    expect(certificateTone({ certificateState: "revoked" }, true)).toBe("running");
    expect(certificateTone(null, true)).toBe("running");
  });
});

describe("待ち時間の目安", () => {
  it("expectedSeconds：再試験30・再リハーサル180・初回は件数×約3分（分からなければ1800）・ほかは null", () => {
    expect(expectedSeconds("retest")).toBe(30);
    expect(expectedSeconds("recertify")).toBe(180);
    expect(expectedSeconds("initial")).toBe(1800);
    // 2026-10-07 の本番：12件・約21分と8件・22分40秒（1件 1.8〜2.8分）。上限寄りの1件 約3分
    expect(expectedSeconds("initial", 12)).toBe(36 * 60);
    expect(expectedSeconds("initial", 8)).toBe(24 * 60);
    expect(expectedSeconds("initial", 0)).toBe(1800);
    for (const t of ["seed", "user_case", "manual"]) expect(expectedSeconds(t)).toBeNull();
  });
  it("elapsedLine：経過秒と目安。目安のない走行は null", () => {
    expect(elapsedLine("retest", 12)).toBe("再試験中 · 12秒経過（目安 約30秒）");
    expect(elapsedLine("recertify", 3.9)).toBe("もう一度試しています · 3秒経過（目安 約3分）");
    expect(elapsedLine("initial", 200)).toBe("試しています · 3分20秒経過（目安 約30分。Gemini の混み具合で前後します）");
    expect(elapsedLine("initial", 200, 12)).toBe("試しています · 3分20秒経過（目安 約36分。Gemini の混み具合で前後します）");
    expect(elapsedLine("user_case", 5)).toBeNull();
  });
  it("interpretationText：サーバーが付けた「こう解釈しました：」を二重にしない", () => {
    expect(interpretationText("こう解釈しました：F-02 仕込まれた指示（…）")).toBe("こう解釈しました：F-02 仕込まれた指示（…）");
    expect(interpretationText("F-02 仕込まれた指示（…）")).toBe("こう解釈しました：F-02 仕込まれた指示（…）");
  });
  it("stoppedByText：判定の前（queued・running・judging）は結果を言わない", () => {
    for (const status of ["queued", "running", "judging"]) {
      expect(stoppedByText({ status, stoppedBy: null, decision: null, verdict: null } as never)).toBe("試しています");
    }
    expect(stoppedByText({ status: "done", stoppedBy: "none", decision: null, verdict: "pass" } as never)).toBe("実害なし");
  });
  it("durationText・generatingLine・generatorText", () => {
    expect([durationText(45), durationText(119), durationText(120), durationText(125)]).toEqual(["45秒", "119秒", "2分", "2分5秒"]);
    // 次に何が起きるかが分かる文（F-091）
    expect(generatingLine(12)).toBe("Gemini が悪い日を作っています… 12秒経過（目安 約30秒。そのあと1件ずつ試します）");
    expect(generatorText({ model: "gemini-3.8-flash", costUsd: "0.03" }, 10, "$0.030")).toBe("Gemini が悪い日を 10 件作りました · $0.030");
    expect(generatorText({ model: "gemini-3.8-flash", costUsd: null }, null, null)).toBe("Gemini が悪い日を作りました");
  });
  it("件数が 0 や null のときは「0 件作りました」と出さない（F-054）。生成の記録になければ走行の状況の件数", () => {
    expect(generatorText({ model: "gemini-3.8-flash", costUsd: null }, 0, null)).toBe("Gemini が悪い日を作りました");
    expect(generatedCount(0, 12)).toBe(12);
    expect(generatedCount(undefined, 3)).toBe(3);
    expect(generatedCount(null, 0)).toBeNull();
    expect(generatedCount(8, 12)).toBe(8);
  });
  it("待ちの1行の部品：読み上げ領域に入れる文（name・note）と毎秒変わる経過（elapsed）を分ける（F-020）", () => {
    expect(elapsedParts("retest", 12)).toEqual({ name: "再試験中", elapsed: "12秒経過", note: "（目安 約30秒）" });
    expect(elapsedParts("user_case", 5)).toBeNull();
    expect(generatingParts(3)).toEqual({ name: "Gemini が悪い日を作っています…", elapsed: "3秒経過", note: "（目安 約30秒。そのあと1件ずつ試します）" });
  });
  it("rerunNote：[もう一度リハーサルする] の案内は件数×約3分。件数が分からなければ約30分", () => {
    expect(rerunNote(12)).toBe("12件ほどで約36分 · いまの結果は置き換わります");
    expect(rerunNote(null)).toBe("約30分 · いまの結果は置き換わります");
  });
});

describe("依頼のページ：担当の仕事の自動の再リハーサル（2026-10-06 の確認）", () => {
  const ASK = "ask-1";
  const run = (over: Partial<RehearsalRun>): RehearsalRun => ({
    id: "r",
    jobId: null,
    askId: ASK,
    trigger: "initial",
    scripted: false,
    status: "done",
    seed: 77,
    modelId: "gemini-3.8-flash",
    adaptRound: 0,
    damageJpy: 0,
    withoutControlDamageJpy: 0,
    preventedDamageJpy: 0,
    costUsd: "0.5",
    budgetUsd: "1.0",
    certificateId: null,
    error: null,
    createdAt: "2026-10-06T03:00:00.000Z",
    startedAt: "2026-10-06T03:00:00.000Z",
    finishedAt: null,
    ...over,
  });
  const scen = (id: string, ordinal: number, caseId = `case-${ordinal}`): RehearsalScenarioRow =>
    ({ id, caseId, ordinal, status: "done", faultIds: ["F-05"], verdict: "pass", stoppedBy: "kernel", stoppedByDecision: "approve", damageJpy: 0, withoutControlDamageJpy: 0, preventedDamageJpy: 0, damageBreakdown: null, withoutControlDamageBreakdown: null }) as unknown as RehearsalScenarioRow;
  const askRun = run({ id: "ask-run", certificateId: "cert-1" });
  const oldRecert = run({ id: "old", askId: null, jobId: "job-buyer", trigger: "recertify", createdAt: "2026-10-06T02:00:00.000Z" });
  const userCase = run({ id: "uc", trigger: "user_case", createdAt: "2026-10-06T05:00:00.000Z" });

  it("依頼の走行を主にし、担当の仕事の再リハーサル（askId なし）は依頼の走行より後の新しい1件だけ", () => {
    const first = run({ id: "re-1", askId: null, jobId: "job-buyer", trigger: "recertify", createdAt: "2026-10-06T04:00:00.000Z" });
    const second = run({ id: "re-2", askId: null, jobId: "job-buyer", trigger: "recertify", status: "running", createdAt: "2026-10-06T04:30:00.000Z" });
    const picked = pickAskRuns([userCase, second, first, askRun, oldRecert], ASK);
    expect(picked.primary?.id).toBe("ask-run");
    expect(picked.recertify.map((r) => r.id)).toEqual(["re-2"]);
    // 依頼の走行がなければ「まだリハーサルしていません」（再リハーサルだけでは出さない）
    expect(pickAskRuns([first], ASK)).toEqual({ primary: null, recertify: [] });
  });

  it("再試験の1つ前の走行：同じ依頼で、再試験より前に作られ、自分の悪い日でないもののうち最新", () => {
    const retest = run({ id: "retest", trigger: "retest", status: "running", createdAt: "2026-10-06T06:00:00.000Z" });
    const older = run({ id: "older", trigger: "initial", createdAt: "2026-10-06T01:00:00.000Z" });
    const other = run({ id: "other", askId: "ask-2", createdAt: "2026-10-06T05:30:00.000Z" });
    expect(pickPreviousRun([retest, userCase, askRun, older, other, oldRecert], retest)?.id).toBe("ask-run");
    expect(pickPreviousRun([retest], retest)).toBeNull();
  });

  it("切れた → もう一度試しています → 済み · 13件。内訳は依頼の12件のあとに13件目（本番から足した試験）", () => {
    const revoked = { certificateState: "revoked" as const, certificateRevokeText: "試験が追加されたため", certificateCaseCount: 12, certificateIssuedAt: "2026-10-06T03:10:00.000Z" };
    // 1. tick がまだ始めていない：一覧は依頼の走行だけ
    const before = pickAskRuns([askRun], ASK);
    const activeOf = (rs: RehearsalRun[]) => rs.some((r) => ["queued", "generating", "running"].includes(r.status));
    expect(certificateLabel(revoked, activeOf(before.recertify))).toBe("もう一度試します（試験が追加されたため） · 1分以内に自動で始まります");
    // 2. 担当の仕事の再リハーサルが走っている（job_id だけの走行が一覧に出る）
    const running = run({ id: "re", askId: null, jobId: "job-buyer", trigger: "recertify", status: "running", createdAt: "2026-10-06T04:00:00.000Z" });
    const during = pickAskRuns([running, askRun], ASK);
    expect(certificateLabel(revoked, activeOf(during.recertify))).toBe("もう一度試しています（試験が追加されたため）");
    // 3. 合格：合格証は担当ごとの現行の合計（依頼の走行の12件 ＋ 再リハーサルの1件）
    const after = pickAskRuns([{ ...running, status: "done", certificateId: "cert-2" }, askRun], ASK);
    expect(activeOf(after.recertify)).toBe(false);
    expect(certificateLabel({ certificateState: "valid", certificateRevokeText: null, certificateCaseCount: 13, certificateIssuedAt: "2026-10-06T04:02:00.000Z" }, false)).toMatch(/^安全チェック済み · 13件 · /);
    const rows = askScenarioRows(
      { id: askRun.id, result: { scenarios: Array.from({ length: 12 }, (_, i) => scen(`s${i + 1}`, i + 1)), userCases: [] } },
      after.recertify.map((r) => ({ id: r.id, result: { scenarios: [scen("incident-row", 1, "case-incident")] } })),
    );
    expect(rows).toHaveLength(13);
    expect(rows[12]).toMatchObject({ id: "incident-row", runId: "re", caseId: "case-incident" });
  });
});

describe("台本で再現した結果（D-101）：費用 0 の印と本物で走らせる操作", () => {
  it("サーバーが scripted と返した走行だけ台本。trigger は見ない（retest でも台本なら印を出し、本物なら出さない）", () => {
    expect(isScriptedRun({ scripted: true })).toBe(true);
    expect(isScriptedRun({ scripted: false })).toBe(false);
  });

  it("印は費用 0 を文で示し、ボタンの案内は1日の上限に触れる", () => {
    expect(SCRIPTED_MARK).toContain("Gemini の費用 0");
    expect(REAL_RUN_NOTE).toContain("1日の上限");
  });

  it("費用の上限・走行の重なりは既存の文言に足して出す。ほかの失敗は describeError のまま", () => {
    const err = (code: string, status: number, message = "") => new ApiError(status, code, message);
    expect(actionErrorText(err("REHEARSAL_BUDGET_EXCEEDED", 429))).toContain("台本の結果はそのまま見られます");
    expect(actionErrorText(err("REHEARSAL_ALREADY_RUNNING", 409))).toContain("終わるまで待ってください");
    expect(actionErrorText(err("NOT_IN_CATALOG", 422, "理由"))).toBe("用意した悪い日のどれにも当てはまらなかったので、試していません。何が届いたか・何が変わったかを書いてみてください（今日の5件のうち1件を使いました）");
    expect(actionErrorText(new ApiError(422, "NOT_IN_CATALOG", "x", { nearest: "F-02" }))).toBe("用意した悪い日のどれにも当てはまらなかったので、試していません（近いのは「仕込まれた指示」）。何が届いたか・何が変わったかを書いてみてください（今日の5件のうち1件を使いました）");
    expect(actionErrorText(new Error("x"))).toBe("うまくいきませんでした。もう一度試してください");
  });
});

// ---- #13：最上部の3行・見出しの札・#14：こんな日も試す・段階の文（画面の言葉） ----

/** 画面に内部の語が出ていないことを見る（#13・#14） */
const BANNED = /リハーサル|合格証|汚染|オラクル|締め|統制|Kernel/;

const COUNTS_ALL_STOPPED = { total: 12, stoppedByKernel: 11, stoppedByAgent: 1, withControl: { slipped: 0, damageJpy: 0 } };
const COUNTS_SOME_SLIPPED = { total: 12, stoppedByKernel: 9, stoppedByAgent: 1, withControl: { slipped: 2, damageJpy: 1 } };

const plainIn = (over: Partial<PlainSummaryInput> = {}): PlainSummaryInput => ({
  summary: { certificateState: "none", certificateCaseCount: null },
  counts: COUNTS_SOME_SLIPPED,
  preventedJpy: 394500,
  primaryTrigger: "seed",
  primaryStatus: "done",
  runningTrigger: null,
  caseCount: 12,
  recertified: false,
  incidentAdded: false,
  ...over,
});

describe("最上部の3行（#13）", () => {
  it("用意した依頼の最初：12件・止めた10（9＋1）・すり抜け2・防いだ損害 ¥394,500", () => {
    expect(plainSummaryLines(plainIn())).toEqual(["12の悪い日を試しました。", "10件は止まり、2件はすり抜けました。", "¥394,500 の損害を防ぎました。"]);
  });

  it("権限を絞って合格（retest）：全部止まったら「全部止まりました ✓」", () => {
    const lines = plainSummaryLines(plainIn({ summary: { certificateState: "valid", certificateCaseCount: 12 }, counts: COUNTS_ALL_STOPPED, primaryTrigger: "retest" }));
    expect(lines).toEqual(["権限を絞って、同じ12の悪い日をもう一度試しました。", "全部止まりました ✓", "¥394,500 の損害を防ぎ、安全チェック済みになりました。"]);
  });

  it("権限を絞って合格で、止まった数が全部に届かないときは「すり抜けはありませんでした ✓」", () => {
    const counts = { ...COUNTS_ALL_STOPPED, stoppedByKernel: 10 };
    const lines = plainSummaryLines(plainIn({ summary: { certificateState: "valid", certificateCaseCount: 12 }, counts, primaryTrigger: "retest" }));
    expect(lines[1]).toBe("すり抜けはありませんでした ✓");
  });

  it("切れた（case_added・本番から足した）：1分以内に試し始め、それまで確認に回す", () => {
    const summary = { certificateState: "revoked" as const, certificateCaseCount: 12, certificateRevokeReason: "case_added" as const };
    expect(plainSummaryLines(plainIn({ summary, incidentAdded: true, counts: null, preventedJpy: 0 }))).toEqual([
      "本番で止めた発注を、安全チェックに足しました。",
      "1分以内に、もう一度試し始めます。",
      "それまで、発注は送る前にあなたに確認します。",
    ]);
  });

  it("切れて、もう一度試している最中（recertify）：2行目は「もう一度試しています（約3分）。」", () => {
    const summary = { certificateState: "revoked" as const, certificateCaseCount: 12, certificateRevokeReason: "case_added" as const };
    const lines = plainSummaryLines(plainIn({ summary, runningTrigger: "recertify", incidentAdded: true, counts: null, preventedJpy: 0 }));
    expect(lines[0]).toBe("本番で止めた発注を、安全チェックに足しました。");
    expect(lines[1]).toBe("もう一度試しています（約3分）。");
  });

  it("切れて、再リハーサルが費用の上限で止まった：2行目は「明日もう一度試します」（1分以内とは書かない）", () => {
    const summary = { certificateState: "revoked" as const, certificateCaseCount: 12, certificateRevokeReason: "tool_hash" as const, recertifyStoppedByBudget: true };
    const lines = plainSummaryLines(plainIn({ summary, counts: null, preventedJpy: 0 }));
    expect(lines[1]).toBe("費用の上限に達したので、明日もう一度試します。");
    expect(lines.join("")).not.toContain("1分以内");
  });

  it("失敗・取り消しの走行は、途中までの件数で「全部止まりました ✓」と言わず []", () => {
    for (const primaryStatus of ["failed", "cancelled"] as const) {
      expect(plainSummaryLines(plainIn({ primaryStatus, counts: COUNTS_ALL_STOPPED, preventedJpy: 0 }))).toEqual([]);
      expect(plainSummaryLines(plainIn({ primaryStatus, summary: { certificateState: "valid", certificateCaseCount: 12 } }))).toEqual([]);
    }
  });

  it("初回の走行中は、件数が 0 のとき「0 件作りました」と出さない", () => {
    const lines = plainSummaryLines(plainIn({ runningTrigger: "initial", caseCount: 0 }));
    expect(lines[0]).toBe("Gemini が悪い日を作りました。");
    expect(lines[1]).toBe("1件ずつ試しています（約30分）。");
  });

  it("切れた理由ごとの1行（revokeReasonLine）：case_added は本番から足したかで言い分けが変わる", () => {
    expect(revokeReasonLine("case_added", false)).toBe("試す悪い日が1件増えました。");
    expect(revokeReasonLine("case_added", true)).toBe("本番で止めた発注を、安全チェックに足しました。");
    expect(revokeReasonLine("tool_hash", false)).toBe("ツールの説明が変わりました。");
    expect(revokeReasonLine("widen", false)).toBe("権限を広げる変更がありました。");
    expect(revokeReasonLine("model", false)).toBe("モデルが変わりました。");
    expect(revokeReasonLine("superseded", false)).toBe("設定が変わりました。");
    expect(revokeReasonLine(null, false)).toBe("設定が変わりました。");
  });

  it("再リハーサルのあとの合格：足した分も含めて13件と言う", () => {
    const lines = plainSummaryLines(plainIn({ summary: { certificateState: "valid", certificateCaseCount: 13 }, counts: { ...COUNTS_ALL_STOPPED, total: 13, stoppedByKernel: 12 }, recertified: true, primaryTrigger: "seed" }));
    expect(lines[0]).toBe("足した分も含めて、13の悪い日を試しました。");
    expect(lines[1]).toBe("全部止まりました ✓");
  });

  it("走っている途中（initial）：件数があれば「作りました」、なければ件数を出さず約30分", () => {
    expect(plainSummaryLines(plainIn({ summary: null, counts: null, runningTrigger: "initial", caseCount: 12, preventedJpy: 0 }))).toEqual([
      "Gemini が悪い日を 12 件作りました。",
      "1件ずつ試しています（約36分）。",
      "終わったものから、下に1件ずつ並びます。",
    ]);
    expect(plainSummaryLines(plainIn({ summary: null, counts: null, runningTrigger: "initial", caseCount: null, preventedJpy: 0 }))).toEqual([
      "Gemini が悪い日を作りました。",
      "1件ずつ試しています（約30分）。",
      "終わったものから、下に1件ずつ並びます。",
    ]);
  });

  it("再試験中（retest）：「同じ12の悪い日を、もう一度試しています（約30秒）」", () => {
    expect(plainSummaryLines(plainIn({ summary: { certificateState: "revoked", certificateCaseCount: 12, certificateRevokeReason: "widen" }, runningTrigger: "retest", caseCount: 12, counts: COUNTS_ALL_STOPPED }))).toEqual([
      "権限を絞りました。",
      "同じ12の悪い日を、もう一度試しています（約30秒）。",
      "終わったものから、下の行が入れ替わります。",
    ]);
  });

  it("結果も走行もなければ []（counts null・走っていない）", () => {
    expect(plainSummaryLines(plainIn({ counts: null, summary: null, preventedJpy: 0 }))).toEqual([]);
    expect(plainSummaryLines(plainIn({ counts: null, summary: { certificateState: "none", certificateCaseCount: null }, preventedJpy: 0 }))).toEqual([]);
  });

  it("性質：どの入力でも、どの行にも内部の語が出ず、行は3つ以下", () => {
    const summaries: PlainSummaryInput["summary"][] = [null, { certificateState: "none", certificateCaseCount: null }, { certificateState: "valid", certificateCaseCount: 12 }];
    for (const certificateRevokeReason of ["widen", "tool_hash", "model", "case_added", "superseded", null] as const) {
      for (const recertifyStoppedByBudget of [false, true]) {
        summaries.push({ certificateState: "revoked", certificateCaseCount: 12, certificateRevokeReason, recertifyStoppedByBudget });
      }
    }
    const countsList: PlainSummaryInput["counts"][] = [null, COUNTS_ALL_STOPPED, COUNTS_SOME_SLIPPED];
    const runnings: PlainSummaryInput["runningTrigger"][] = [null, "initial", "retest", "recertify"];
    const bad: string[] = [];
    let checked = 0;
    for (const summary of summaries)
      for (const counts of countsList)
        for (const runningTrigger of runnings)
          for (const caseCount of [null, 12])
            for (const primaryTrigger of ["seed", "retest"] as const)
              for (const recertified of [false, true])
                for (const incidentAdded of [false, true])
                  for (const preventedJpy of [0, 394500]) {
                    const lines = plainSummaryLines({ summary, counts, preventedJpy, primaryTrigger, primaryStatus: "done", runningTrigger, caseCount, recertified, incidentAdded });
                    checked++;
                    if (lines.length > 3) bad.push(`行数 ${lines.length}`);
                    for (const line of lines) if (BANNED.test(line)) bad.push(line);
                  }
    expect(checked).toBeGreaterThan(1000);
    expect(bad).toEqual([]);
  });
});

describe("見出し直下の札（askHeadLine）", () => {
  const view = (over: Partial<AskRehearsalView>): AskRehearsalView =>
    ({ certificateState: "none", certificateRevokeReason: null, certificateRevokeText: null, certificateCaseCount: null, certificateIssuedAt: null, preventedDamageJpy: null, ...over }) as AskRehearsalView;

  it("まだしていない（null）→「まだしていません」", () => {
    expect(askHeadLine(null, false)).toBe("まだしていません");
  });
  it("試している最中（active）→「試しています」", () => {
    expect(askHeadLine(view({ certificateState: "valid", certificateCaseCount: 12 }), true)).toBe("試しています");
  });
  it("切れて、もう一度試している最中（active＋revoked）→「もう一度試しています」", () => {
    expect(askHeadLine(view({ certificateState: "revoked", certificateCaseCount: 12 }), true)).toBe("もう一度試しています");
  });
  it("切れて、まだ走っていない（revoked）→「もう一度試します」", () => {
    expect(askHeadLine(view({ certificateState: "revoked", certificateCaseCount: 12 }), false)).toBe("もう一度試します");
  });
  it("済み（valid）→「済み · 12件」", () => {
    expect(askHeadLine(view({ certificateState: "valid", certificateCaseCount: 12 }), false)).toBe("済み · 12件");
  });
  it("まだ済んでいない（none）で防いだ損害があれば末尾に添える", () => {
    expect(askHeadLine(view({ certificateState: "none", preventedDamageJpy: 394500 }), false)).toBe("まだ済んでいません · 防いだ損害 ¥394,500");
  });
  it("どの札にも内部の語が出ない", () => {
    const outs = [
      askHeadLine(null, false),
      askHeadLine(view({ certificateState: "valid", certificateCaseCount: 12 }), true),
      askHeadLine(view({ certificateState: "revoked" }), true),
      askHeadLine(view({ certificateState: "revoked" }), false),
      askHeadLine(view({ certificateState: "valid", certificateCaseCount: 12, preventedDamageJpy: 394500 }), false),
      askHeadLine(view({ certificateState: "none", preventedDamageJpy: 394500 }), false),
    ];
    for (const s of outs) expect(s).not.toMatch(BANNED);
  });
});

describe("こんな日も試す（#14・BR-78）", () => {
  it("例は3つで重複がない", () => {
    expect(USER_CASE_EXAMPLES).toHaveLength(3);
    expect(new Set(USER_CASE_EXAMPLES).size).toBe(3);
  });

  it("入力欄のプレースホルダー：「例：」で始まり例文のどれか。乱数で例が変わる", () => {
    const low = userCasePlaceholder(() => 0);
    const high = userCasePlaceholder(() => 0.99);
    const all = USER_CASE_EXAMPLES.map((e) => `例：${e}`);
    expect(low.startsWith("例：")).toBe(true);
    expect(all).toContain(low);
    expect(all).toContain(high);
    expect(low).not.toBe(high);
  });

  it("当てはまらなかったときの文：近い悪い日の名前があれば括弧で添える。なければ括弧なし", () => {
    expect(notInCatalogText({ nearest: "F-02" })).toBe("用意した悪い日のどれにも当てはまらなかったので、試していません（近いのは「仕込まれた指示」）。何が届いたか・何が変わったかを書いてみてください（今日の5件のうち1件を使いました）");
    expect(notInCatalogText(undefined)).toBe("用意した悪い日のどれにも当てはまらなかったので、試していません。何が届いたか・何が変わったかを書いてみてください（今日の5件のうち1件を使いました）");
    expect(notInCatalogText({ nearest: "F-99" })).toBe("用意した悪い日のどれにも当てはまらなかったので、試していません。何が届いたか・何が変わったかを書いてみてください（今日の5件のうち1件を使いました）");
  });

  it("当てはまらなかったときの文に「カタログ」「障害」は出ない", () => {
    for (const details of [{ nearest: "F-02" }, undefined, { nearest: "F-99" }]) {
      const text = notInCatalogText(details);
      expect(text).not.toContain("カタログ");
      expect(text).not.toContain("障害");
    }
  });
});

describe("段階の文の言い換え（plainPhaseLine）", () => {
  it("サーバーの段階の文を画面の言葉にする。null はそのまま", () => {
    expect(plainPhaseLine("リハーサルを始めました")).toBe("安全チェックを始めました");
    expect(plainPhaseLine("締める提案を 2 件作りました")).toBe("権限を絞る提案を 2 件作りました");
    expect(plainPhaseLine("締める提案はありません")).toBe("権限を絞る提案はありません");
    expect(plainPhaseLine("… → 締める変更で0件")).toBe("… → 権限を絞る変更で0件");
    expect(plainPhaseLine(null)).toBeNull();
  });
});
