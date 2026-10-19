import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  GUEST_USER_CASES_PER_DAY,
  MAX_CASES_PER_JOB,
  activeCases,
  countOnSameJstDay,
  planAddCase,
  userCaseQuota,
  type CaseRecord,
} from "./cases.ts";

const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + n * 60_000).toISOString().replace(".000Z", "Z");
function mk(over: Partial<CaseRecord> & { n: number }): CaseRecord {
  const { n, ...rest } = over;
  return { id: `c${String(n).padStart(3, "0")}`, jobId: "job-1", source: "incident", reasonCode: "guard_exceeded", createdAt: at(n), removedAt: null, ...rest };
}
const fill = (count: number, src: Partial<CaseRecord> = {}) => Array.from({ length: count }, (_, i) => mk({ n: i + 1, ...src }));

describe("planAddCase（仕事ごとに20件）", () => {
  it("上限に収まるならそのまま足す", () => {
    expect(planAddCase(fill(19), mk({ n: 100 }))).toEqual({ ok: true, merges: [], activeAfter: 20 });
    expect(planAddCase([], mk({ n: 1 }))).toEqual({ ok: true, merges: [], activeAfter: 1 });
  });
  it("21件目：同じ reasonCode の古い incident 2件を新しい1件にまとめる", () => {
    const existing = fill(20);
    const r = planAddCase(existing, mk({ n: 100 }));
    expect(r).toEqual({ ok: true, merges: [{ reasonCode: "guard_exceeded", keepId: "c002", mergedIds: ["c001"] }], activeAfter: 20 });
  });
  it("reasonCode が違う incident はまとめず、最も古い incident を含む組からまとめる", () => {
    const existing = [
      mk({ n: 1, reasonCode: "unknown_outcome_pending" }),
      mk({ n: 2, reasonCode: "guard_exceeded" }),
      mk({ n: 3, reasonCode: "guard_exceeded" }),
      mk({ n: 4, reasonCode: "unknown_outcome_pending" }),
      ...fill(16).map((c, i) => mk({ n: 10 + i, reasonCode: `x-${i}` })),
    ];
    const r = planAddCase(existing, mk({ n: 100, reasonCode: "y" }));
    expect(r).toEqual({ ok: true, merges: [{ reasonCode: "unknown_outcome_pending", keepId: "c004", mergedIds: ["c001"] }], activeAfter: 20 });
  });
  it("generated・user はまとめない。まとめられる incident がなければ追加せず limit_reached（黙って捨てない）", () => {
    const generated = fill(20, { source: "generated", reasonCode: null });
    expect(planAddCase(generated, mk({ n: 100 }))).toEqual({ ok: false, reason: "limit_reached", activeCount: 20 });
    const distinct = fill(20).map((c, i) => ({ ...c, reasonCode: `r-${i}` }));
    expect(planAddCase(distinct, mk({ n: 100, reasonCode: "new" }))).toMatchObject({ ok: false, reason: "limit_reached" });
  });
  it("新しい incident が既存と同じ reasonCode ならそれもまとめの対象（新しいほうが残る）", () => {
    const existing = fill(20).map((c, i) => ({ ...c, reasonCode: i === 0 ? "dup" : `r-${i}` }));
    const r = planAddCase(existing, mk({ n: 100, reasonCode: "dup" }));
    expect(r).toEqual({ ok: true, merges: [{ reasonCode: "dup", keepId: "c100", mergedIds: ["c001"] }], activeAfter: 20 });
  });
  it("外された試験・ほかの仕事の試験は数えない", () => {
    const existing = [...fill(20, { removedAt: at(500) }), ...fill(20, { jobId: "job-2" }).map((c) => ({ ...c, id: `o${c.id}` }))];
    expect(planAddCase(existing, mk({ n: 100 }))).toEqual({ ok: true, merges: [], activeAfter: 1 });
    expect(activeCases(existing)).toHaveLength(20);
  });
  it("まとめが連鎖するときは残る1件に集約する（まとめた先がさらにまとめられても、外す id が漏れない）", () => {
    // すでに21件ある（上限を超えたまま）ところへ1件足す → 2回まとめる：c001→c002、c002→c003
    const r = planAddCase(fill(21), mk({ n: 100 }));
    expect(r).toEqual({ ok: true, merges: [{ reasonCode: "guard_exceeded", keepId: "c003", mergedIds: ["c002", "c001"] }], activeAfter: 20 });
  });
  it("同じ id の試験は足せない", () => {
    expect(() => planAddCase([mk({ n: 1 })], mk({ n: 1 }))).toThrow(TypeError);
  });
  it("性質：ok なら外した id は重ならず、残りは20件以下で、まとめるのは incident だけ", () => {
    const rc = fc.constantFrom("a", "b", "c", "d");
    fc.assert(
      fc.property(
        fc.array(fc.record({ src: fc.constantFrom("generated", "user", "incident"), rc }), { minLength: 0, maxLength: 20 }),
        fc.constantFrom("generated", "user", "incident"),
        rc,
        (xs, src, r) => {
          const existing = xs.map((x, i) => mk({ n: i + 1, source: x.src, reasonCode: x.src === "incident" ? x.rc : null }));
          const added = mk({ n: 500, source: src, reasonCode: src === "incident" ? r : null });
          const plan = planAddCase(existing, added);
          if (!plan.ok) {
            expect(activeCases(existing).length).toBeGreaterThanOrEqual(MAX_CASES_PER_JOB);
            return;
          }
          const merged = plan.merges.flatMap((m) => m.mergedIds);
          expect(new Set(merged).size).toBe(merged.length);
          expect(plan.activeAfter).toBe(existing.length + 1 - merged.length);
          expect(plan.activeAfter).toBeLessThanOrEqual(MAX_CASES_PER_JOB);
          const all = new Map([...existing, added].map((c) => [c.id, c]));
          for (const m of plan.merges) {
            expect(merged).not.toContain(m.keepId);
            for (const id of m.mergedIds) {
              expect(all.get(id)?.source).toBe("incident");
              expect(all.get(id)?.reasonCode).toBe(m.reasonCode);
            }
          }
        },
      ),
    );
  });
});

describe("ゲストの1日の上限", () => {
  it("ゲストは5件まで。オーナーは無制限", () => {
    expect(userCaseQuota({ workspaceKind: "guest", usedToday: 0 })).toEqual({ allowed: true, remaining: GUEST_USER_CASES_PER_DAY });
    expect(userCaseQuota({ workspaceKind: "guest", usedToday: 4 })).toEqual({ allowed: true, remaining: 1 });
    expect(userCaseQuota({ workspaceKind: "guest", usedToday: 5 })).toEqual({ allowed: false, remaining: 0 });
    expect(userCaseQuota({ workspaceKind: "guest", usedToday: 9 })).toEqual({ allowed: false, remaining: 0 });
    expect(userCaseQuota({ workspaceKind: "owner", usedToday: 99 })).toEqual({ allowed: true, remaining: null });
  });
  it("数が壊れていたら不可", () => {
    for (const usedToday of [-1, 1.5, Number.NaN]) expect(userCaseQuota({ workspaceKind: "guest", usedToday }).allowed).toBe(false);
  });
  it("JST の同じ日だけ数える（日付は JST の 0:00 で替わる）", () => {
    const now = "2026-10-08T12:00:00+09:00";
    const times = ["2026-10-08T00:00:00+09:00", "2026-10-07T15:00:00Z", "2026-10-08T23:59:59+09:00", "2026-10-07T23:59:59+09:00", "2026-10-09T00:00:00+09:00"];
    // 2026-10-07T15:00:00Z は JST の 10/08 0:00
    expect(countOnSameJstDay(times, now)).toBe(3);
    expect(countOnSameJstDay([], now)).toBe(0);
  });
  it("今の時刻の形が壊れていたら例外", () => {
    expect(() => countOnSameJstDay([], "昨日")).toThrow(RangeError);
  });
});
