import { describe, expect, it } from "vitest";
import { certificateOfJobs } from "./view.ts";

const c = (o: Partial<{ revoked_at: Date | null; revoke_reason: string | null; case_count: number; issued_at: Date; rehearsal_run_id: string }> = {}) => ({
  revoked_at: null,
  revoke_reason: null,
  case_count: 5,
  issued_at: new Date("2026-10-03T00:00:00Z"),
  ...o,
});

describe("certificateOfJobs（依頼の現行の合格証）", () => {
  it("全担当が有効なら valid。件数は合計、発行は最も新しいもの", () => {
    expect(certificateOfJobs([c(), c({ case_count: 3, issued_at: new Date("2026-10-04T00:00:00Z") })], 2)).toEqual({
      state: "valid",
      revokeReason: null,
      caseCount: 8,
      issuedAt: "2026-10-04T00:00:00.000Z",
    });
  });
  it("同じ走行の合格証（依頼の走行は担当ごとに同じ試験で出す）の試験の数は1回だけ数え、別の走行の分は足す", () => {
    expect(certificateOfJobs([c({ case_count: 12, rehearsal_run_id: "r1" }), c({ case_count: 12, rehearsal_run_id: "r1" })], 2)).toMatchObject({ caseCount: 12 });
    expect(certificateOfJobs([c({ case_count: 12, rehearsal_run_id: "r1" }), c({ case_count: 1, rehearsal_run_id: "r2" })], 2)).toMatchObject({ caseCount: 13 });
  });
  it("1枚でも失効していれば revoked と理由", () => {
    const r = certificateOfJobs([c(), c({ revoked_at: new Date(), revoke_reason: "tool_hash" })], 2);
    expect(r).toMatchObject({ state: "revoked", revokeReason: "tool_hash" });
  });
  it("出していない担当があれば none（ある分の件数は残す）、1枚もなければ全部 null", () => {
    expect(certificateOfJobs([c()], 2)).toMatchObject({ state: "none", caseCount: 5 });
    expect(certificateOfJobs([], 2)).toEqual({ state: "none", revokeReason: null, caseCount: null, issuedAt: null });
  });
});
