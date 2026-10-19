// 最初の3件の並べ替え（first-batch.ts）の試験。純粋な関数。Issue #12
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FIRST_BATCH_FAULTS, FIRST_BATCH_SIZE, orderFirstBatch } from "./first-batch.ts";

const c = (id: string, ...f: string[]) => ({ id, fault_ids: f });
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

describe("orderFirstBatch（最初の3件の並べ替え）", () => {
  it("定数：最初に出す件数は 3、先頭に走らせる障害は F-05・F-03・F-01 の順", () => {
    expect(FIRST_BATCH_SIZE).toBe(3);
    expect(FIRST_BATCH_FAULTS).toEqual(["F-05", "F-03", "F-01"]);
  });

  it("3件以下（0件・1件・3件）は元の順のまま返し、新しい配列を返す", () => {
    const empty: ReturnType<typeof c>[] = [];
    expect(orderFirstBatch(empty)).toEqual([]);
    expect(orderFirstBatch(empty)).not.toBe(empty);

    const one = [c("a", "F-04")];
    expect(ids(orderFirstBatch(one))).toEqual(["a"]);
    expect(orderFirstBatch(one)).not.toBe(one);

    const three = [c("a", "F-04"), c("b", "F-05"), c("c", "F-01")];
    expect(ids(orderFirstBatch(three))).toEqual(["a", "b", "c"]);
    expect(orderFirstBatch(three)).not.toBe(three);
  });

  it("件数が多くても元の配列は変えない", () => {
    const cases = [c("a", "F-04"), c("b", "F-05"), c("c", "F-02"), c("d", "F-03"), c("e", "F-01"), c("f", "F-06")];
    const before = ids(cases);
    orderFirstBatch(cases);
    expect(ids(cases)).toEqual(before);
  });

  it("F-05・F-03・F-01 を含む試験を F-05 → F-03 → F-01 の順で先頭3件にし、残りは元の順", () => {
    const cases = [c("a", "F-04"), c("b", "F-05"), c("c", "F-02"), c("d", "F-03"), c("e", "F-01"), c("f", "F-06")];
    expect(ids(orderFirstBatch(cases))).toEqual(["b", "d", "e", "a", "c", "f"]);
  });

  it("F-05・F-03・F-01 のどれも含まなければ、元の順のまま", () => {
    const cases = [c("a", "F-04"), c("b", "F-02"), c("c", "F-02"), c("d", "F-06")];
    expect(ids(orderFirstBatch(cases))).toEqual(["a", "b", "c", "d"]);
  });

  it("同じ障害を含む試験が複数あれば、元の順で最初のものを選ぶ", () => {
    const cases = [c("a", "F-01"), c("b", "F-01"), c("c", "F-03"), c("d", "F-05")];
    expect(ids(orderFirstBatch(cases))).toEqual(["d", "c", "a", "b"]);
  });

  it("障害が1種類（F-05 だけ）なら、その最初の試験が先頭に来て残りは元の順で2件埋める", () => {
    const cases = [c("a", "F-02"), c("b", "F-04"), c("c", "F-05"), c("d", "F-06"), c("e", "F-02")];
    expect(ids(orderFirstBatch(cases))).toEqual(["c", "a", "b", "d", "e"]);
  });

  it("1件が複数の障害を含んでも、同じ試験は2回選ばない", () => {
    // x は F-01 と F-03 を両方含む。F-05 で w、F-03 で x を選んだあと、F-01 は x しかないので選べず、埋め草に y が入る
    const cases = [c("x", "F-01", "F-03"), c("y", "F-03"), c("z", "F-04"), c("w", "F-05")];
    expect(ids(orderFirstBatch(cases))).toEqual(["w", "x", "y", "z"]);
  });

  it("複数の障害を含む1件しか F-03 を持たないとき、その1件は F-03 で選ばれ、F-01 は埋め草に回る", () => {
    const cases = [c("x", "F-01", "F-03"), c("p", "F-04"), c("q", "F-02"), c("r", "F-05")];
    const got = ids(orderFirstBatch(cases));
    expect(got).toEqual(["r", "x", "p", "q"]);
    expect(new Set(got).size).toBe(got.length);
  });

  it("入力と同じ要素・同じ件数（重複・欠落なし）を返す（任意の入力）", () => {
    const faults = ["F-01", "F-02", "F-03", "F-04", "F-05", "F-06"];
    // id が一意な配列（orderFirstBatch は id が一意である前提）
    const arb = fc.uniqueArray(
      fc.record({ id: fc.string({ minLength: 1, maxLength: 4 }), fault_ids: fc.subarray(faults, { minLength: 0, maxLength: 3 }) }),
      { minLength: 0, maxLength: 12, selector: (c) => c.id },
    );
    fc.assert(
      fc.property(arb, (cases) => {
        const out = orderFirstBatch(cases);
        expect(out).toHaveLength(cases.length);
        expect(ids(out).slice().sort()).toEqual(ids(cases).slice().sort());
        expect(new Set(ids(out)).size).toBe(cases.length);
      }),
    );
  });
});
