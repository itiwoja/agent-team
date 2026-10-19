import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CERTIFICATE_MISSING_NOTE,
  OPEN_ROWS_FIRST_THRESHOLD,
  RISK_REASON_CODES,
  buildConfirmPresentation,
  destinationMatchesAnyRule,
  guardFailureOf,
  guardReasonLine,
  mcpRiskScore,
  riskLevelOf,
  sortCheckItems,
} from "./risk.ts";
import type { ConfirmPresentationInput, GuardDecisionDetail, McpRiskInput } from "./risk.ts";
import { evaluateGuard } from "./guards.ts";
import { addTaintSource, taintFromInputs, taintOnTeamMessage } from "./taint.ts";
import { EMPTY_TAINT } from "./types.ts";
import type { DirectTaintSource, EffectiveRule, Json, JsonObject, MergedGuard, ToolHash, ToolInfo } from "./types.ts";

// ---- フィクスチャ ----
const PO = "mcp.supplier.place_order";
const H: ToolHash = `sha256:${"a".repeat(64)}`;
const T_PO: ToolInfo = {
  classification: "write",
  status: "ok",
  connectorEnabled: true,
  scope: null,
  toolHash: H,
  argRoles: { supplier_id: "destination", "items[].sku": "option", "items[].quantity": "option", "items[].unit_price": "option", note: "content" },
};
const R0: EffectiveRule = {
  id: "r-1",
  action: PO,
  tool_hash: H,
  match: { supplier_id: "supplier-01", "items[].sku": ["BEAN-HOUSE"] },
  free: ["items[].quantity", "items[].unit_price"],
};
const AT = "2026-10-03T09:00:00.000Z";
const MAIL: DirectTaintSource = { kind: "mcp_read", connectorId: "c-mail", connectorSlug: "mail", connectorName: "メール", tool: "list_inbox", at: AT };
const mailRead = addTaintSource(EMPTY_TAINT, MAIL);
const handoff = taintFromInputs([{ taskId: "t-inbox", agentName: "受信箱係", taint: mailRead }], AT);
const viaMessage = taintOnTeamMessage(EMPTY_TAINT, { messageId: "m1", fromTaskId: "t-inbox", fromAgentName: "受信箱係", tainted: true, upstream: [MAIL] }, AT);
const risk = (over: Partial<McpRiskInput> = {}) =>
  mcpRiskScore({ tainted: false, matchesAnyRule: true, containsProfileValue: false, origin: "deliver", scopeSelf: false, ...over });
const G_QTY: MergedGuard = { action: PO, arg: "items[].quantity", max: 20, empty: false };
const guardDetail = (over: Partial<GuardDecisionDetail> = {}): GuardDecisionDetail => ({
  kind: "guard",
  argPath: "items[0].quantity",
  value: 200,
  found: true,
  guard: G_QTY,
  ...over,
});
const present = (over: Partial<ConfirmPresentationInput> = {}) =>
  buildConfirmPresentation({
    confirmType: "intent",
    reasonCode: "approval_required",
    guard: null,
    unknownItemKey: null,
    firstDestination: false,
    destinationText: "山田珈琲（supplier-01）",
    gains: [],
    actionNoun: null,
    taint: null,
    ...over,
  });

describe("mcpRiskScore（intents.md:109-117、M-24。ルールベース）", () => {
  it("加点の表：tainted +2、宛先がルールに一致しない +2、プロフィールの値 +2、origin = agent +1、scope: self −1", () => {
    expect(risk({ tainted: true }).reasons).toEqual([{ code: "tainted", points: 2, detail: null }]);
    expect(risk({ matchesAnyRule: false }).reasons).toEqual([{ code: "destination_not_in_rules", points: 2, detail: null }]);
    expect(risk({ containsProfileValue: true }).reasons).toEqual([{ code: "profile_value_in_content", points: 2, detail: null }]);
    expect(risk({ origin: "agent" }).reasons).toEqual([{ code: "agent_direct_call", points: 1, detail: null }]);
    expect(risk({ scopeSelf: true }).reasons).toEqual([{ code: "scope_self", points: -1, detail: null }]);
    expect(RISK_REASON_CODES).toHaveLength(5);
  });

  it("E-7：汚染＋ルールに一致しない宛先＋エージェントが直接 → 5、high", () => {
    expect(risk({ tainted: true, matchesAnyRule: false, origin: "agent" })).toMatchObject({ score: 5, level: "high" });
  });

  it("E-8・AR-12：scope: self だけ → −1、low（負も low）", () => {
    expect(risk({ scopeSelf: true })).toMatchObject({ score: -1, level: "low" });
  });

  it("E-9：汚染だけ → 2、medium。境界 1 → low、3 → medium、4 → high", () => {
    expect(risk({ tainted: true })).toMatchObject({ score: 2, level: "medium" });
    expect([riskLevelOf(1), riskLevelOf(2), riskLevelOf(3), riskLevelOf(4), riskLevelOf(0), riskLevelOf(-1)]).toEqual([
      "low",
      "medium",
      "medium",
      "high",
      "low",
      "low",
    ]);
  });

  it("TA-27：汚染＋ルール不一致 → 4、high", () => {
    expect(risk({ tainted: true, matchesAnyRule: false })).toMatchObject({ score: 4, level: "high" });
  });

  it("TA-28：汚染＋ルール一致＋origin = agent → 3、medium", () => {
    expect(risk({ tainted: true, matchesAnyRule: true, origin: "agent" })).toMatchObject({ score: 3, level: "medium" });
  });

  it("性質：score は理由の点数の合計、level は score だけで決まる", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.constantFrom("agent" as const, "deliver" as const), fc.boolean(), (t, m, p, o, s) => {
        const r = risk({ tainted: t, matchesAnyRule: m, containsProfileValue: p, origin: o, scopeSelf: s });
        expect(r.score).toBe(r.reasons.reduce((a, x) => a + x.points, 0));
        expect(r.level).toBe(riskLevelOf(r.score));
      }),
    );
  });
});

describe("destinationMatchesAnyRule（リスクの「宛先がどのルールにも一致しない」）", () => {
  const args = (supplier: string, sku = "SUGAR") => ({ supplier_id: supplier, items: [{ sku, quantity: 500, unit_price: 2400 }] });
  it("宛先だけを比べる（option・content が違っても宛先が同じなら一致）。正規化して比べる", () => {
    expect(destinationMatchesAnyRule([R0], PO, args("supplier-01"), T_PO, true)).toBe(true);
    expect(destinationMatchesAnyRule([R0], PO, args(" supplier-01 "), T_PO, true)).toBe(true);
    expect(destinationMatchesAnyRule([R0], PO, args("supplier-99"), T_PO, true)).toBe(false);
  });
  it("無効なルール（rules.enabled = false・tool_hash が古い・別の action）は数えない", () => {
    expect(destinationMatchesAnyRule([R0], PO, args("supplier-01"), T_PO, false)).toBe(false);
    expect(destinationMatchesAnyRule([{ ...R0, tool_hash: `sha256:${"f".repeat(64)}` }], PO, args("supplier-01"), T_PO, true)).toBe(false);
    expect(destinationMatchesAnyRule([{ ...R0, action: "mcp.mail.send" }], PO, args("supplier-01"), T_PO, true)).toBe(false);
    expect(destinationMatchesAnyRule([], PO, args("supplier-01"), T_PO, true)).toBe(false);
  });
});

describe("guardReasonLine（UI §4.6.3-3、ask-and-check.md:128）", () => {
  it("C19-06・U-8：max 20、値 200、単位「個」→「いつもの上限（20個）を超えています：200個」、200個が太字", () => {
    expect(guardReasonLine(guardDetail(), "個")).toEqual({ text: "いつもの上限（20個）を超えています：200個", bold: ["200個"] });
  });

  it("C19-07：max 800、値 2400、単位「円」→ 3桁区切り「いつもの上限（800円）を超えています：2,400円」", () => {
    const d = guardDetail({ argPath: "items[0].unit_price", value: 2400, guard: { action: PO, arg: "items[].unit_price", max: 800, empty: false } });
    expect(guardReasonLine(d, "円").text).toBe("いつもの上限（800円）を超えています：2,400円");
  });

  it("下限・桁数・候補・見つからない・型・空の範囲の文（単位なしも）", () => {
    const g = (over: Partial<MergedGuard>): MergedGuard => ({ action: PO, arg: "x", empty: false, ...over });
    expect(guardReasonLine(guardDetail({ value: 0, guard: g({ min: 1 }) }), null)).toEqual({ text: "いつもの下限（1）を下回っています：0", bold: ["0"] });
    expect(guardReasonLine(guardDetail({ value: 1000, guard: g({ max_digits: 3 }) }), "個").text).toBe("いつもの桁数（3桁）を超えています：1,000個");
    expect(guardReasonLine(guardDetail({ value: "1eft-pad", guard: g({ in: ["left-pad", "lodash"] }) }), null)).toEqual({
      text: "いつもの候補にない値です：1eft-pad",
      bold: ["1eft-pad"],
    });
    expect(guardReasonLine(guardDetail({ value: null, found: false }), "個")).toEqual({ text: "確かめる値（items[].quantity）が見つかりません", bold: [] });
    expect(guardReasonLine(guardDetail({ value: "20" }), "個")).toEqual({ text: "いつもの範囲に入らない値です：20", bold: ["20"] });
    expect(guardReasonLine(guardDetail({ value: 5, guard: g({ min: 10, max: 5, empty: true }) }), "個").text).toBe("いつもの範囲に入らない値です：5個");
  });

  it("guardFailureOf は evaluateGuard と同じ順（空 → 見つからない → 型 → 下限 → 上限 → 桁数 → 候補。KC §3.6 の1が空）", () => {
    const g = (over: Partial<MergedGuard>): MergedGuard => ({ action: PO, arg: "x", empty: false, ...over });
    // 空のガードは値が見つからなくても empty（evaluateGuard は empty を先に返す）
    expect(guardFailureOf(guardDetail({ found: false, value: null, guard: g({ empty: true }) }))).toBe("empty");
    expect(guardFailureOf(guardDetail({ found: false, value: null, guard: g({ max: 20 }) }))).toBe("not_found");
    expect(guardFailureOf(guardDetail({ value: 3, guard: g({ empty: true }) }))).toBe("empty");
    expect(guardFailureOf(guardDetail({ value: "3", guard: g({ max: 1 }) }))).toBe("type");
    expect(guardFailureOf(guardDetail({ value: -1, guard: g({ min: 0, max: 1 }) }))).toBe("below_min");
    expect(guardFailureOf(guardDetail({ value: 21, guard: g({ max: 20 }) }))).toBe("above_max");
    expect(guardFailureOf(guardDetail({ value: 1000, guard: g({ max_digits: 3 }) }))).toBe("too_many_digits");
    expect(guardFailureOf(guardDetail({ value: 3, guard: g({ in: ["a"] }) }))).toBe("type");
    expect(guardFailureOf(guardDetail({ value: " b ", guard: g({ in: ["a"] }) }))).toBe("not_in");
  });

  it("壊れたガード（合成していない・文字列でない候補・有限でない境界）も evaluateGuard と同じく empty（例外にしない）", () => {
    const broken = [
      { action: PO, arg: "x", in: [1 as unknown as string], empty: false },
      { action: PO, arg: "x", max: Number.NaN, empty: false },
      { action: PO, arg: "x", empty: false },
    ] as MergedGuard[];
    for (const guard of broken) {
      expect(evaluateGuard(guard, { x: "a" })).toMatchObject({ ok: false, reason: "empty" });
      expect(guardFailureOf(guardDetail({ value: "a", guard }))).toBe("empty");
    }
  });

  it("性質：evaluateGuard の外れの理由を detail から決め直すと同じ理由になる（firstGuardViolation の detail から文を作るため）", () => {
    const arbGuard = fc.record(
      {
        min: fc.constantFrom(0, 1, 10),
        max: fc.constantFrom(0, 5, 20, Number.NaN),
        max_digits: fc.constantFrom(1, 2, 3),
        in: fc.constantFrom<string[]>([], ["a"], [" a ", "b"]),
        empty: fc.boolean(),
      },
      { requiredKeys: ["empty"] },
    );
    const arbValue = fc.oneof(fc.integer({ min: -5, max: 2000 }), fc.constantFrom<Json>("a", " b ", "20", null, true, [1], { a: 1 }));
    const arbArgs = fc.oneof(
      arbValue.map((v): JsonObject => ({ x: v })),
      fc.constant<JsonObject>({}),
      fc.array(fc.oneof(arbValue.map((v): Json => ({ q: v })), fc.constant<Json>({}), fc.constant<Json>(3)), { maxLength: 3 }).map((items): JsonObject => ({ items })),
    );
    fc.assert(
      fc.property(arbGuard, fc.constantFrom("x", "items[].q"), arbArgs, (gv, arg, args) => {
        const guard = { action: PO, arg, ...gv } as MergedGuard;
        const r = evaluateGuard(guard, args);
        if (r.ok) return;
        expect(guardFailureOf({ kind: "guard", argPath: r.path, value: r.value, found: r.found, guard })).toBe(r.reason);
      }),
      { numRuns: 500 },
    );
  });

  it("大きな数・小数・負の数の3桁区切り", () => {
    const g: MergedGuard = { action: PO, arg: "x", max: 1000000.5, empty: false };
    expect(guardReasonLine(guardDetail({ value: 1234567.25, guard: g }), null).text).toBe("いつもの上限（1,000,000.5）を超えています：1,234,567.25");
    const lo: MergedGuard = { action: PO, arg: "x", min: -1000, empty: false };
    expect(guardReasonLine(guardDetail({ value: -12345, guard: lo }), null).text).toBe("いつもの下限（-1,000）を下回っています：-12,345");
  });
});

describe("buildConfirmPresentation（BR-70・D-59、UI §4.6.3、IA §3.11）", () => {
  it("C19-16：approval_required・汚染なし・初めてでない → 閉じたまま。理由の行も汚染の行もない", () => {
    expect(present()).toEqual({ open: false, reasonLines: [], secondLines: [], taintLine: null, certificateNote: null });
  });

  it("C19-06・U-8：guard_exceeded は開いた状態、1行目の上に上限の理由（単位は manifest の units）", () => {
    const p = present({ reasonCode: "guard_exceeded", guard: guardDetail(), units: { "items[].quantity": "個" } });
    expect(p.open).toBe(true);
    expect(p.reasonLines).toEqual([{ text: "いつもの上限（20個）を超えています：200個", bold: ["200個"] }]);
  });

  it("guard_exceeded で detail がなくても開いて出す。単位がなければ付けない", () => {
    expect(present({ reasonCode: "guard_exceeded" }).reasonLines).toEqual([{ text: "いつもの範囲に入らない値です", bold: [] }]);
    expect(present({ reasonCode: "guard_exceeded", guard: guardDetail(), units: { other: "円" } }).reasonLines[0]?.text).toBe(
      "いつもの上限（20）を超えています：200",
    );
  });

  it("C19-08・U-9：unknown_outcome_pending は開いた状態「前の発注が届いたか分かっていません」と前の行へのリンク", () => {
    const p = present({ reasonCode: "unknown_outcome_pending", actionNoun: "発注", unknownItemKey: "question:i-0" });
    expect(p.open).toBe(true);
    expect(p.reasonLines).toEqual([{ text: "前の発注が届いたか分かっていません", bold: [], link: { label: "前の発注を見る", itemKey: "question:i-0" } }]);
    // 操作の名前がなければ「送信」、行のキーがなければリンクなし
    expect(present({ reasonCode: "unknown_outcome_pending" }).reasonLines).toEqual([{ text: "前の送信が届いたか分かっていません", bold: [] }]);
  });

  it("C19-11：widen の設定変更は開いた状態「このエージェントができることが増えます」、2行目に増えることを1行ずつ", () => {
    const p = present({ confirmType: "config_change", reasonCode: null, gains: ["仕入れ先に発注する", "在庫を見る"], destinationText: null });
    expect(p.open).toBe(true);
    expect(p.reasonLines).toEqual([{ text: "このエージェントができることが増えます", bold: [] }]);
    expect(p.secondLines).toEqual(["できることが増えます：仕入れ先に発注する", "できることが増えます：在庫を見る"]);
  });

  it("C19-09・E-10：初めての宛先は開いた状態「初めての送り先です」、宛先が太字", () => {
    const p = present({ firstDestination: true });
    expect(p.open).toBe(true);
    expect(p.reasonLines).toEqual([{ text: "初めての送り先です", bold: ["山田珈琲（supplier-01）"] }]);
  });

  it("C19-10：guard_exceeded かつ初めての宛先 → 理由が2行（ガード → 初めての送り先の順）", () => {
    const p = present({ reasonCode: "guard_exceeded", guard: guardDetail(), firstDestination: true, units: { "items[].quantity": "個" } });
    expect(p.reasonLines.map((l) => l.text)).toEqual(["いつもの上限（20個）を超えています：200個", "初めての送り先です"]);
  });

  it("TA-23・U-10・C19-12：汚染だけの行は閉じたまま、宛先の下に汚染の1行", () => {
    const p = present({ taint: mailRead });
    expect(p.open).toBe(false);
    expect(p.taintLine).toBe("外から読んだ内容（メール）のあとの送信です");
  });

  it("C19-13・C19-14：受け渡し・連絡の汚染の文", () => {
    expect(present({ taint: handoff }).taintLine).toBe("受信箱係が読んだメールのあとの送信です");
    expect(present({ taint: viaMessage }).taintLine).toBe("受信箱係からの連絡のあとの送信です");
  });

  it("TA-26：汚染＋guard_exceeded → 開いた状態、1行目の上に上限の理由、汚染の行も出す", () => {
    const p = present({ reasonCode: "guard_exceeded", guard: guardDetail(), taint: mailRead, units: { "items[].quantity": "個" } });
    expect(p.open).toBe(true);
    expect(p.reasonLines).toHaveLength(1);
    expect(p.taintLine).toBe("外から読んだ内容（メール）のあとの送信です");
  });

  it("U-13：用意した依頼の行（初めての宛先＋受け渡しの汚染）→ 開いた状態「初めての送り先です」＋「受信箱係が読んだメールのあとの送信です」", () => {
    const p = present({ firstDestination: true, taint: handoff });
    expect(p.open).toBe(true);
    expect(p.reasonLines.map((l) => l.text)).toEqual(["初めての送り先です"]);
    expect(p.taintLine).toBe("受信箱係が読んだメールのあとの送信です");
  });

  it("C19-15：certificate_missing だけ → 閉じたまま・理由の行なし。開いた中の文を返す", () => {
    const p = present({ reasonCode: "certificate_missing" });
    expect(p).toEqual({ open: false, reasonLines: [], secondLines: [], taintLine: null, certificateNote: CERTIFICATE_MISSING_NOTE });
    expect(CERTIFICATE_MISSING_NOTE).toBe("安全チェックがまだなので確認に回しています");
  });

  it("汚染されていない taint の値（EMPTY_TAINT）は汚染の行を出さない", () => {
    expect(present({ taint: EMPTY_TAINT }).taintLine).toBeNull();
  });

  it("性質：open は理由の行があるときだけ。汚染・certificate_missing だけでは開かない（毎回開くと読まずに押す：D-59）", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("approval_required", "guard_exceeded", "unknown_outcome_pending", "certificate_missing", null),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom(null, mailRead, handoff),
        (reasonCode, first, widen, taint) => {
          const p = present({
            reasonCode: reasonCode as ConfirmPresentationInput["reasonCode"],
            guard: reasonCode === "guard_exceeded" ? guardDetail() : null,
            firstDestination: first,
            confirmType: widen ? "config_change" : "intent",
            taint,
          });
          const triggers = reasonCode === "guard_exceeded" || reasonCode === "unknown_outcome_pending" || first || widen;
          expect(p.open).toBe(triggers);
          expect(p.open).toBe(p.reasonLines.length > 0);
          expect(p.taintLine !== null).toBe(taint !== null);
        },
      ),
    );
  });
});

describe("sortCheckItems（IA §3.11-5、UI §4.6.2、ask-and-check.md:96-97・136、A-92）", () => {
  type Item = { kind: "confirm" | "question" | "report"; at: string; key: string; open?: boolean };
  const at = (hh: number, mm = 0) => `2026-10-03T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`;
  const keys = (items: Item[]) => sortCheckItems(items).map((x) => x.key);

  it("C19-02：報告 10:00・送る前の確認 9:00・質問 11:00 → 送る前の確認 → 質問 → 報告", () => {
    expect(keys([{ kind: "report", at: at(10), key: "r" }, { kind: "confirm", at: at(9), key: "c" }, { kind: "question", at: at(11), key: "q" }])).toEqual([
      "c",
      "q",
      "r",
    ]);
  });

  it("C19-03：同じ種類の中は新しい順（10:00 が上）。同じ時刻は key の昇順、読めない時刻は後ろ", () => {
    expect(keys([{ kind: "confirm", at: at(9), key: "a" }, { kind: "confirm", at: at(10), key: "b" }])).toEqual(["b", "a"]);
    expect(keys([{ kind: "report", at: at(9), key: "z" }, { kind: "report", at: at(9), key: "y" }, { kind: "report", at: "?", key: "x" }])).toEqual([
      "y",
      "z",
      "x",
    ]);
  });

  it("C19-04・U-11：送る前の確認5件のうち開いた行2件 → 新しい順のまま（開いた行を先に寄せない）", () => {
    const items: Item[] = [1, 2, 3, 4, 5].map((h) => ({ kind: "confirm", at: at(h), key: `c${h}`, open: h === 1 || h === 2 }));
    expect(keys(items)).toEqual(["c5", "c4", "c3", "c2", "c1"]);
  });

  it("C19-05・U-12：開いた行が3件 → 開いた3件が先（その中も新しい順）、残り2件があと。質問・報告はそのあと", () => {
    expect(OPEN_ROWS_FIRST_THRESHOLD).toBe(3);
    const items: Item[] = [
      ...[1, 2, 3, 4, 5].map((h): Item => ({ kind: "confirm", at: at(h), key: `c${h}`, open: h <= 3 })),
      { kind: "question", at: at(23), key: "q" },
      { kind: "report", at: at(0), key: "r", open: true },
    ];
    expect(keys(items)).toEqual(["c3", "c2", "c1", "c5", "c4", "q", "r"]);
  });

  it("元の配列は変えない", () => {
    const items: Item[] = [{ kind: "report", at: at(1), key: "r" }, { kind: "confirm", at: at(2), key: "c" }];
    sortCheckItems(items);
    expect(items.map((x) => x.key)).toEqual(["r", "c"]);
  });
});
