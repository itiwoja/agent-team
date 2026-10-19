import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkTighteningProposal, decide, compose, DEFAULT_CEILINGS, defaultWorkspacePolicy, EMPTY_TAINT } from "@open-team/kernel";
import type { AgentDefinitionInput, CandidateRule, Counters, Flags } from "@open-team/kernel";
import { applyJsonPatch, argLabel, findSplitLines, pointerEscape, proposeTightening, type PatchOp, type SlippedCase, type TightenHints } from "./tighten.ts";
import { BUYER, BUYER_R, CTX, H, PO, R1, T_PO, def, guard, order, poSubject, splitOrder } from "./test-helpers.ts";

const COUNTERS: Counters = { stepsUsed: 0, costUsd: 0, dayCostUsd: 0, agentDayCostUsd: 0, elapsedSec: 0, deniedCount: 0, repeatKey: null, repeatCount: 0, intentsCount: 0, unknownOutcomeKeys: [] };
const FLAGS: Flags = { killSwitchEngaged: false, taskStatus: "running", certificateValid: true };

const bounds = { "items[].quantity": { max: 60 } };
const hints: TightenHints = { bounds, approvedValues: { "r-1": { "items[].quantity": [20] } } };
// 定義のルール r-1（数量・単価が変わってよい）で、数量 200 の発注がすり抜けた
const slipRule: SlippedCase = { id: "s1", jobId: "reorder", subject: poSubject(order(200)), ruleId: "r-1" };

const polAfter = (after: AgentDefinitionInput) => compose({ ceilings: DEFAULT_CEILINGS, workspacePolicy: defaultWorkspacePolicy("guest"), agent: after }, "reorder").effective;

describe("applyJsonPatch", () => {
  const doc = { a: { "x/y": 1, list: [1, 2, 3] }, b: [{ k: 1 }] };
  it("add・replace・remove をオブジェクトと配列に当て、入力は変えない", () => {
    const ops: PatchOp[] = [
      { op: "add", path: "/a/list/-", value: 4 },
      { op: "add", path: "/a/list/0", value: 0 },
      { op: "replace", path: "/a/x~1y", value: 9 },
      { op: "remove", path: "/b/0/k" },
      { op: "add", path: "/c", value: { z: null } },
    ];
    expect(applyJsonPatch(doc, ops)).toEqual({ a: { "x/y": 9, list: [0, 1, 2, 3, 4] }, b: [{}], c: { z: null } });
    expect(doc).toEqual({ a: { "x/y": 1, list: [1, 2, 3] }, b: [{ k: 1 }] });
    expect(pointerEscape("a/b~c")).toBe("a~1b~0c");
  });
  it("ない場所への replace・remove、範囲外の添字、ルートは例外", () => {
    for (const op of [
      { op: "replace", path: "/nope", value: 1 },
      { op: "remove", path: "/a/nope" },
      { op: "remove", path: "/a/list/9" },
      { op: "add", path: "/a/list/9", value: 1 },
      { op: "add", path: "/nope/deeper", value: 1 },
      { op: "add", path: "", value: 1 },
    ] as PatchOp[]) {
      expect(() => applyJsonPatch(doc, [op])).toThrow(RangeError);
    }
  });
});

describe("proposeTightening", () => {
  it("定義のルールで数量 200 の発注がすり抜けた：ガード追加・固定に戻す・ルールの取り消しが残る（書き込みの自律度の引き戻しは案にしない）", () => {
    const r = proposeTightening({ before: BUYER_R, ctx: CTX, slipped: [slipRule], hints });
    expect(r.proposals.map((p) => p.kind)).toEqual(["add_guard", "option_to_fixed", "remove_rule"]);
    for (const p of r.proposals) {
      expect(p).toMatchObject({ classification: "narrow", fixes: ["s1"] });
      expect(p.id).toMatch(/^tp-[0-9a-f]{12}$/);
      expect(p.text.length).toBeGreaterThan(0);
    }
    expect(r.discarded).toEqual([]);
  });

  it("残った案を当てると、同じ書き込みは allow にならない（kernel の判定で確かめる）", () => {
    const r = proposeTightening({ before: BUYER_R, ctx: CTX, slipped: [slipRule], hints });
    // 前提：いまの定義では allow（rule_matched）
    expect(decide(polAfter(BUYER_R), slipRule.subject, COUNTERS, FLAGS, EMPTY_TAINT).decision).toBe("allow");
    for (const p of r.proposals) {
      const after = applyJsonPatch(BUYER_R, p.patch as PatchOp[]);
      expect(decide(polAfter(after), slipRule.subject, COUNTERS, FLAGS, EMPTY_TAINT).decision, p.kind).not.toBe("allow");
      expect(checkTighteningProposal({ before: BUYER_R, after, ctx: CTX }).ok).toBe(true);
    }
  });

  it("ガードの案の中身：ガードなし → 新しいガードを足す。許す範囲は hints の値", () => {
    const r = proposeTightening({ before: BUYER_R, ctx: CTX, slipped: [slipRule], hints });
    const add = r.proposals.find((p) => p.kind === "add_guard")!;
    expect(add.patch).toEqual([{ op: "add", path: "/jobs/0/guards/-", value: { action: PO, arg: "items[].quantity", max: 60 } }]);
    expect(add.text).toContain("60 以下");
    // 画面の文言は項目名を日本語にする（差分の arg は道筋のまま）
    expect(add.text).toBe("「1回の発注の数量」に 60 以下 のガードを付け、外れたら確認に回します");
    for (const p of r.proposals) expect(p.text).not.toMatch(/items\[/);
  });

  it("ルールの案の文に内部の ID（r-1）を出さない：中身が分かれば「「…」のルール」、なければ「以後も許可にしたルール（N番目）」（D-108）", () => {
    const named = proposeTightening({ before: BUYER_R, ctx: CTX, slipped: [slipRule], hints: { ...hints, ruleLabels: { "r-1": "山田珈琲への発注は以後も許可" } } });
    expect(named.proposals.find((p) => p.kind === "remove_rule")!.text).toBe("「山田珈琲への発注は以後も許可」のルールを取り消し、同じ書き込みを確認に回します");
    expect(named.proposals.find((p) => p.kind === "option_to_fixed")!.text).toBe(
      "「山田珈琲への発注は以後も許可」のルールの「1回の発注の数量」を、毎回変わってよいから承認した値に固定し直します",
    );
    const plain = proposeTightening({ before: BUYER_R, ctx: CTX, slipped: [slipRule], hints });
    expect(plain.proposals.find((p) => p.kind === "remove_rule")!.text).toBe("以後も許可にしたルール（1番目）を取り消し、同じ書き込みを確認に回します");
    for (const p of [...named.proposals, ...plain.proposals]) expect(p.text).not.toMatch(/r-1/);
    // 文が変わっても案の ID（差分のハッシュ）は同じ
    expect(named.proposals.map((p) => p.id)).toEqual(plain.proposals.map((p) => p.id));
  });

  it("argLabel：ガード・ルールに出る引数を平易な名前にし、単価には円を付ける。知らない引数は道筋のまま", () => {
    expect(argLabel("items[].quantity")).toBe("1回の発注の数量");
    expect(argLabel("items[1].unit_price")).toBe("単価");
    expect(argLabel("supplier_id")).toBe("仕入れ先");
    expect(argLabel("x.y")).toBe("x.y");
    const priceHints = { bounds: { "items[].unit_price": { max: 900 } } };
    const pricey: SlippedCase = { ...slipRule, subject: poSubject(order(10, 1200)) };
    const r = proposeTightening({ before: BUYER_R, ctx: CTX, slipped: [pricey], hints: priceHints });
    const add = r.proposals.find((p) => p.kind === "add_guard");
    expect(add?.text).toBe("「単価」に 900円 以下 のガードを付け、外れたら確認に回します");
  });

  it("job に guards が未設定でも足せる（配列ごと add）", () => {
    const noGuards = def((d) => delete d.jobs[0].guards, BUYER_R);
    const r = proposeTightening({ before: noGuards, ctx: CTX, slipped: [slipRule], hints });
    const add = r.proposals.find((p) => p.kind === "add_guard")!;
    expect(add.patch).toEqual([{ op: "add", path: "/jobs/0/guards", value: [{ action: PO, arg: "items[].quantity", max: 60 }] }]);
  });

  it("既存のガードがあれば範囲を狭める（max を下げる）。すでに狭ければ案を作らない", () => {
    const loose = def((d) => (d.jobs[0].guards = [guard("items[].quantity", { max: 500 })]), BUYER_R);
    const r = proposeTightening({ before: loose, ctx: CTX, slipped: [slipRule], hints });
    const narrow = r.proposals.find((p) => p.kind === "narrow_guard")!;
    expect(narrow.patch).toEqual([{ op: "replace", path: "/jobs/0/guards/0/max", value: 60 }]);
    expect(r.proposals.some((p) => p.kind === "add_guard")).toBe(false);
    // min だけのガードに max を足す
    const minOnly = def((d) => (d.jobs[0].guards = [guard("items[].quantity", { min: 1 })]), BUYER_R);
    const r2 = proposeTightening({ before: minOnly, ctx: CTX, slipped: [slipRule], hints });
    expect(r2.proposals.find((p) => p.kind === "narrow_guard")!.patch).toEqual([{ op: "add", path: "/jobs/0/guards/0/max", value: 60 }]);
    // 候補（in）のガードには数値を足さない
    const inGuard = def((d) => (d.jobs[0].guards = [guard("items[].quantity", { in: ["20"] })]), BUYER_R);
    expect(proposeTightening({ before: inGuard, ctx: CTX, slipped: [slipRule], hints }).proposals.some((p) => p.kind === "narrow_guard")).toBe(false);
  });

  it("範囲を外れていないすり抜け（hints の範囲内）にはガードの案を作らない", () => {
    const small: SlippedCase = { ...slipRule, subject: poSubject(order(30)) };
    const r = proposeTightening({ before: BUYER_R, ctx: CTX, slipped: [small], hints });
    expect(r.proposals.map((p) => p.kind)).toEqual(["option_to_fixed", "remove_rule"]);
  });

  it("min を下回ってすり抜けたものにも min のガードを足す", () => {
    const low: SlippedCase = { ...slipRule, subject: poSubject(order(0)) };
    const r = proposeTightening({ before: BUYER_R, ctx: CTX, slipped: [low], hints: { bounds: { "items[].quantity": { min: 1 } } } });
    expect(r.proposals.find((p) => p.kind === "add_guard")!.patch).toEqual([{ op: "add", path: "/jobs/0/guards/-", value: { action: PO, arg: "items[].quantity", min: 1 } }]);
  });

  it("option_to_fixed：承認された値の材料がなければ作らない（値を作り出さない）。ルールの取り消しは残る", () => {
    const r = proposeTightening({ before: BUYER_R, ctx: CTX, slipped: [slipRule], hints: { bounds } });
    expect(r.proposals.map((p) => p.kind)).toEqual(["add_guard", "remove_rule"]);
  });

  it("option_to_fixed の差分：free から外し、match に承認した値を入れる（P-04 と同じ形）", () => {
    const r = proposeTightening({ before: BUYER_R, ctx: CTX, slipped: [slipRule], hints });
    const fixed = r.proposals.find((p) => p.kind === "option_to_fixed")!;
    expect(fixed.patch).toEqual([
      { op: "replace", path: "/rules/0/free", value: ["items[].unit_price"] },
      { op: "add", path: "/rules/0/match/items[].quantity", value: [20] },
    ]);
  });

  it("読み取りが auto で通ったすり抜けは、mcp_read を approve に引き戻す案で塞ぐ。書き込みの自律度の案は作らない", () => {
    const readTool = { ...T_PO, classification: "read" as const, argRoles: {} };
    const slip: SlippedCase = {
      id: "s2",
      jobId: "reorder",
      subject: { kind: "tool_call", actionType: "mcp_call", action: "mcp.supplier.list_products", args: {}, paths: [], tool: readTool, origin: "agent" },
      ruleId: null,
    };
    const autoRead = def((d) => (d.autonomy = { mcp_read: "auto" }));
    expect(decide(polAfter(autoRead), slip.subject, COUNTERS, FLAGS, EMPTY_TAINT).decision).toBe("allow");
    const r = proposeTightening({ before: autoRead, ctx: CTX, slipped: [slip] });
    expect(r.proposals.map((p) => p.kind)).toEqual(["autonomy_to_approve"]);
    expect(r.proposals[0]!.patch).toEqual([{ op: "add", path: "/autonomy/mcp_read", value: "approve" }]);
    const after = applyJsonPatch(autoRead, r.proposals[0]!.patch as PatchOp[]);
    expect(decide(polAfter(after), slip.subject, COUNTERS, FLAGS, EMPTY_TAINT).decision).toBe("approve");
    // 書き込みの自律度は上限表で auto にできない：ルールなしの書き込みには案がない
    const writeSlip: SlippedCase = { id: "s4", jobId: "reorder", subject: poSubject(order(200)), ruleId: null };
    expect(proposeTightening({ before: BUYER, ctx: CTX, slipped: [writeSlip] })).toEqual({ proposals: [], discarded: [] });
  });

  it("autonomy が未設定の定義には /autonomy ごと足す。すでに approve・deny なら案を作らない", () => {
    const readTool = { ...T_PO, classification: "read" as const, argRoles: {} };
    const slip: SlippedCase = {
      id: "s2",
      jobId: "reorder",
      subject: { kind: "tool_call", actionType: "mcp_call", action: "mcp.supplier.list_products", args: {}, paths: [], tool: readTool, origin: "agent" },
      ruleId: null,
    };
    const noAutonomy = def((d) => delete d.autonomy);
    const r = proposeTightening({ before: noAutonomy, ctx: CTX, slipped: [slip] });
    for (const p of r.proposals) expect(applyJsonPatch(noAutonomy, p.patch as PatchOp[])).toBeDefined();
    expect(r.proposals.length + r.discarded.length).toBe(1);
    const approved = def((d) => (d.autonomy = { mcp_read: "approve" }));
    expect(proposeTightening({ before: approved, ctx: CTX, slipped: [slip] })).toEqual({ proposals: [], discarded: [] });
  });

  it("候補のルール（定義にない）で通ったすり抜けは、ガードだけが塞ぐ。ルールの取り消し・固定は出ない（BR-57）", () => {
    const cand: CandidateRule[] = [{ action: PO, match: { supplier_id: "supplier-01", "items[].sku": ["BEAN"] }, free: ["items[].quantity", "items[].unit_price"], tool_hash: H("a") }];
    const slip: SlippedCase = { id: "s3", jobId: "reorder", subject: poSubject(order(200)), ruleId: "cand-1" };
    const r = proposeTightening({ before: BUYER, ctx: CTX, slipped: [slip], candidateRules: cand, hints });
    expect(r.proposals.map((p) => p.kind)).toEqual(["add_guard"]);
    expect(r.discarded).toEqual([]);
  });

  it("classify が narrow 以外の案は捨てる：ガードを広げる・指示を変えるは出ない（出したとしても捨てる）", () => {
    // 既存ガードが max 30、hints が max 60（広い）→ 狭めないので案なし。すり抜けは max30 を超えるが guard で止まるはずなので allow にならない状況は作れない
    const tight = def((d) => (d.jobs[0].guards = [guard("items[].quantity", { max: 30 })]), BUYER_R);
    const r = proposeTightening({ before: tight, ctx: CTX, slipped: [{ ...slipRule, subject: poSubject(order(20)) }], hints: { bounds: { "items[].quantity": { max: 10 } } } });
    // 20 は max 30 のガードを通るが hints の max 10 は超える → max を 10 に狭める案（narrow）
    expect(r.proposals.map((p) => p.kind)).toContain("narrow_guard");
    for (const p of r.proposals) expect(p.classification).toBe("narrow");
  });

  it("複数のすり抜けに同じ案が効くときは fixes をまとめる。1件ずつにしか効かない案は別々に残る", () => {
    const a: SlippedCase = { ...slipRule, id: "s-a", subject: poSubject(order(200)) };
    const b: SlippedCase = { ...slipRule, id: "s-b", subject: poSubject(order(300)) };
    const r = proposeTightening({ before: BUYER_R, ctx: CTX, slipped: [a, b], hints });
    const add = r.proposals.filter((p) => p.kind === "add_guard");
    expect(add).toHaveLength(1);
    expect(add[0]!.fixes).toEqual(["s-a", "s-b"]);
    expect(r.proposals.find((p) => p.kind === "remove_rule")!.fixes).toEqual(["s-a", "s-b"]);
  });

  it("仕事が定義にない・action がない書き込みは案を作らない。すり抜けが0件なら空", () => {
    expect(proposeTightening({ before: BUYER_R, ctx: CTX, slipped: [{ ...slipRule, jobId: "ghost" }], hints })).toEqual({ proposals: [], discarded: [] });
    const noAction = { ...slipRule, subject: { ...slipRule.subject, action: undefined } } as SlippedCase;
    expect(proposeTightening({ before: BUYER_R, ctx: CTX, slipped: [noAction], hints }).proposals).toEqual([]);
    expect(proposeTightening({ before: BUYER_R, ctx: CTX, slipped: [], hints })).toEqual({ proposals: [], discarded: [] });
  });

  it("入力の定義・hints は変えない。同じ入力は同じ結果（id も同じ）", () => {
    const before = structuredClone(BUYER_R);
    const r1 = proposeTightening({ before, ctx: CTX, slipped: [slipRule], hints });
    expect(before).toEqual(BUYER_R);
    expect(proposeTightening({ before, ctx: CTX, slipped: [slipRule], hints })).toEqual(r1);
  });

  describe("分割行（D-82）", () => {
    const capBySku = { BEAN: 60 };
    const split = splitOrder([50, 50, 50]);
    it("findSplitLines：どの行も上限以内で合計が上限を超えるものを見つける", () => {
      expect(findSplitLines(split, { sku: "items[].sku", quantity: "items[].quantity" }, capBySku)).toEqual([{ sku: "BEAN", rows: 3, total: 150, cap: 60 }]);
      // 1行で超えるのは分割ではない（行ごとのガードで塞がる）
      expect(findSplitLines(splitOrder([200]), { sku: "items[].sku", quantity: "items[].quantity" }, capBySku)).toEqual([]);
      // 合計が上限以内
      expect(findSplitLines(splitOrder([20, 30]), { sku: "items[].sku", quantity: "items[].quantity" }, capBySku)).toEqual([]);
      // 1行でも上限を超える行があれば分割だけの問題ではない
      expect(findSplitLines(splitOrder([100, 10]), { sku: "items[].sku", quantity: "items[].quantity" }, capBySku)).toEqual([]);
      // 上限が分からない sku・数量が数でない行・容れ物が配列でない
      expect(findSplitLines(splitOrder([50, 50], 1, "OTHER"), { sku: "items[].sku", quantity: "items[].quantity" }, capBySku)).toEqual([]);
      expect(findSplitLines({ items: [{ sku: "BEAN", quantity: "50" }, { sku: "BEAN", quantity: 70 }] } as never, { sku: "items[].sku", quantity: "items[].quantity" }, capBySku)).toEqual([]);
      expect(findSplitLines({ items: "x" } as never, { sku: "items[].sku", quantity: "items[].quantity" }, capBySku)).toEqual([]);
    });
    const slip: SlippedCase = { id: "s-split", jobId: "reorder", subject: poSubject(split), ruleId: "r-1" };
    // 小分けの発注を一度承認して [以後も許可] を押したルール（sku は行ごとに固定、数量は free）。行ごとのガードは max 60
    const guarded = def((d) => {
      d.rules = [{ ...R1, match: { supplier_id: "supplier-01", "items[].sku": ["BEAN", "BEAN", "BEAN"] } }];
      d.jobs[0].guards = [guard("items[].quantity", { max: 60 })];
    });
    it("行ごとのガード（max 60）は通るので、ガードの案では塞がらない。残るのは固定に戻す・ルールの取り消し（承認への引き戻し）だけ", () => {
      expect(decide(polAfter(guarded), slip.subject, COUNTERS, FLAGS, EMPTY_TAINT).decision).toBe("allow");
      const r = proposeTightening({ before: guarded, ctx: CTX, slipped: [slip], hints });
      expect(r.proposals.map((p) => p.kind)).toEqual(["option_to_fixed", "remove_rule"]);
      expect(r.discarded).toEqual([]);
      for (const p of r.proposals) {
        const after = applyJsonPatch(guarded, p.patch as PatchOp[]);
        expect(decide(polAfter(after), slip.subject, COUNTERS, FLAGS, EMPTY_TAINT).decision).not.toBe("allow");
      }
    });
  });

  it("性質：残った案はすべて、当てた定義が checkTighteningProposal を通り、すり抜けた書き込みが allow にならない", () => {
    fc.assert(
      fc.property(fc.integer({ min: 61, max: 5000 }), fc.integer({ min: 100, max: 9000 }), fc.constantFrom(BUYER_R, def((d) => (d.jobs[0].guards = [guard("items[].quantity", { max: 500 })]), BUYER_R)), (qty, price, base) => {
        const slip: SlippedCase = { id: "p", jobId: "reorder", subject: poSubject(order(qty, price)), ruleId: "r-1" };
        const r = proposeTightening({ before: base, ctx: CTX, slipped: [slip], hints });
        for (const p of r.proposals) {
          const after = applyJsonPatch(base, p.patch as PatchOp[]);
          const d = decide(polAfter(after), slip.subject, COUNTERS, FLAGS, EMPTY_TAINT);
          expect(d.decision).not.toBe("allow");
          expect(p.classification).toBe("narrow");
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe("フィクスチャの前提", () => {
  it("R1 は数量と単価が free", () => {
    expect(R1.free).toEqual(["items[].quantity", "items[].unit_price"]);
  });
});
