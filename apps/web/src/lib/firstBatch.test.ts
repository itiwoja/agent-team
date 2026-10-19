// 「まず3件 → 途中結果 → 残りは裏で」の1行（firstBatch.ts）の試験。純粋な関数。Issue #12
import { describe, expect, it } from "vitest";
import { FIRST_BATCH_SIZE, type FirstBatchInput, firstBatchNote } from "./firstBatch";

const base: FirstBatchInput = { trigger: "initial", active: true, scripted: false, done: 0, total: 12 };
const note = (over: Partial<FirstBatchInput>) => firstBatchNote({ ...base, ...over });

describe("firstBatchNote（最初の3件の進み具合の1行）", () => {
  it("FIRST_BATCH_SIZE は 3", () => {
    expect(FIRST_BATCH_SIZE).toBe(3);
  });

  it("判定が 0 件のとき、まず3件の文と約9分（1件3分の目安 × 3件）", () => {
    expect(note({ done: 0 })).toBe("まず3件の悪い日を試しています。途中の結果は約9分で出ます");
  });

  it("判定が 2 件のとき、残り1件分の約3分", () => {
    expect(note({ done: 2 })).toBe("まず3件の悪い日を試しています。途中の結果は約3分で出ます");
  });

  it("判定が 3 件で残りがあるとき、暫定の文と残り9件・約27分", () => {
    expect(note({ done: 3 })).toBe(
      "ここまでの数字は 3件分の暫定です。残りの悪い日 9件も裏で試しています（約27分）。安全チェックの結果は、すべて終わってから出ます",
    );
  });

  it("残りが 1 件（11件中 10 件判定）なら約3分", () => {
    expect(note({ done: 10, total: 11 })).toBe(
      "ここまでの数字は 10件分の暫定です。残りの悪い日 1件も裏で試しています（約3分）。安全チェックの結果は、すべて終わってから出ます",
    );
  });

  it("全件判定済み（残り 0）なら null", () => {
    expect(note({ done: 12, total: 12 })).toBeNull();
  });

  it("件数が 3 件以下（0 件を含む）なら null", () => {
    expect(note({ total: 3, done: 0 })).toBeNull();
    expect(note({ total: 1, done: 0 })).toBeNull();
    expect(note({ total: 0, done: 0 })).toBeNull();
  });

  it("件数が 4 件なら対象（判定 0 件で約9分）", () => {
    expect(note({ total: 4, done: 0 })).toBe("まず3件の悪い日を試しています。途中の結果は約9分で出ます");
  });

  it("件数が分からない（null）なら null", () => {
    expect(note({ total: null })).toBeNull();
  });

  it("走っていない（active: false）なら null", () => {
    expect(note({ active: false })).toBeNull();
  });

  it("trigger が initial 以外なら null", () => {
    for (const trigger of ["retest", "recertify", "user_case", "seed"]) {
      expect(note({ trigger })).toBeNull();
    }
  });

  it("台本で再現した走行（scripted: true）なら null", () => {
    expect(note({ scripted: true })).toBeNull();
  });

  it("判定数が件数を超えても total として扱い、残りが 0 なら null", () => {
    expect(note({ done: 15, total: 12 })).toBeNull();
  });

  it("判定数が負なら 0 として扱う", () => {
    expect(note({ done: -2 })).toBe(note({ done: 0 }));
  });

  it("どの出力にも「リハーサル」「合格証」「汚染」「オラクル」「締め」は含まれない", () => {
    const inputs: Partial<FirstBatchInput>[] = [
      { done: 0 },
      { done: 2 },
      { done: 3 },
      { done: 10, total: 11 },
      { done: -2 },
      { done: 15 },
      { total: 4, done: 1 },
    ];
    for (const over of inputs) {
      const s = note(over);
      if (s === null) continue;
      expect(s).not.toMatch(/リハーサル|合格証|汚染|オラクル|締め/);
    }
  });
});
