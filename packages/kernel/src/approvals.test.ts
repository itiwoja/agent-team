import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { APPROVAL_TTL_MS, computeApprovalExpiry, computeApproverIds, isApprovalExpired } from "./approvals.ts";
import type { ApproverInput } from "./approvals.ts";

// 時刻は JST（Asia/Tokyo：M-59）で書き、UTC で返ることを確かめる
const jst = (day: number, hh: number, mm = 0) => `2026-10-${String(day).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`;
const utc = (s: string) => new Date(Date.parse(s)).toISOString();

describe("computeApprovalExpiry（IA §3.7-1、intents.md:89、M-25：依頼の next_run_at）", () => {
  it("E-1：一回きりの依頼（next_run_at なし）、10:00 に作成 → 翌日 10:00、ttl", () => {
    expect(computeApprovalExpiry({ createdAt: jst(3, 10), askNextRunAt: null })).toEqual({ expiresAt: utc(jst(4, 10)), cause: "ttl" });
    expect(APPROVAL_TTL_MS).toBe(86_400_000);
  });

  it("E-2：毎日18時の依頼、10:00 に作成 → 同じ日の 18:00、next_run", () => {
    expect(computeApprovalExpiry({ createdAt: jst(3, 10), askNextRunAt: jst(3, 18) })).toEqual({ expiresAt: utc(jst(3, 18)), cause: "next_run" });
  });

  it("E-3：18:05 に作成（次は翌日 18:00）→ 翌日 18:00（24時間後の 18:05 より早い）", () => {
    expect(computeApprovalExpiry({ createdAt: jst(3, 18, 5), askNextRunAt: jst(4, 18) })).toEqual({ expiresAt: utc(jst(4, 18)), cause: "next_run" });
  });

  it("E-4：17:59 に作成 → 18:00（1分）", () => {
    expect(computeApprovalExpiry({ createdAt: jst(3, 17, 59), askNextRunAt: jst(3, 18) })).toEqual({ expiresAt: utc(jst(3, 18)), cause: "next_run" });
  });

  it("次の実行がちょうど24時間後なら ttl（早い方が同じ）、24時間より後なら ttl", () => {
    expect(computeApprovalExpiry({ createdAt: jst(3, 18), askNextRunAt: jst(4, 18) })).toEqual({ expiresAt: utc(jst(4, 18)), cause: "ttl" });
    expect(computeApprovalExpiry({ createdAt: jst(3, 10), askNextRunAt: jst(5, 18) })).toEqual({ expiresAt: utc(jst(4, 10)), cause: "ttl" });
  });

  it("作成の時刻以前の next_run_at（進め忘れた古い値）は使わない → ttl", () => {
    expect(computeApprovalExpiry({ createdAt: jst(3, 18, 5), askNextRunAt: jst(3, 18) })).toEqual({ expiresAt: utc(jst(4, 18, 5)), cause: "ttl" });
    expect(computeApprovalExpiry({ createdAt: jst(3, 18), askNextRunAt: jst(3, 18) }).cause).toBe("ttl");
  });

  it("時刻が解釈できなければ例外（期限を決められない承認は作らない）", () => {
    expect(() => computeApprovalExpiry({ createdAt: "きょう", askNextRunAt: null })).toThrow(TypeError);
    expect(() => computeApprovalExpiry({ createdAt: jst(3, 10), askNextRunAt: "あした" })).toThrow(TypeError);
  });

  it("性質：期限は作成より後で、作成から24時間以内。next_run のときは next_run_at と同じ時刻", () => {
    const base = Date.parse("2026-10-03T00:00:00Z");
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 * 86_400_000 }), fc.option(fc.integer({ min: -86_400_000, max: 3 * 86_400_000 })), (c, d) => {
        const createdAt = new Date(base + c).toISOString();
        const askNextRunAt = d === null ? null : new Date(base + c + d).toISOString();
        const r = computeApprovalExpiry({ createdAt, askNextRunAt });
        const e = Date.parse(r.expiresAt);
        expect(e).toBeGreaterThan(base + c);
        expect(e).toBeLessThanOrEqual(base + c + APPROVAL_TTL_MS);
        if (r.cause === "next_run") expect(r.expiresAt).toBe(askNextRunAt);
      }),
    );
  });
});

describe("isApprovalExpired（IA §3.9-4-2・§3.15 の境界）", () => {
  it("E-5：expires_at ちょうどは期限切れ（API-019 は 409 APPROVAL_NOT_PENDING）。1ミリ秒前は有効", () => {
    expect(isApprovalExpired("2026-10-03T09:00:00.000Z", "2026-10-03T09:00:00.000Z")).toBe(true);
    expect(isApprovalExpired("2026-10-03T09:00:00.000Z", "2026-10-03T08:59:59.999Z")).toBe(false);
  });
  it("E-6：バッチ（expires_at <= now）と同じ判定。タイムゾーンが違っても時刻で比べる", () => {
    expect(isApprovalExpired("2026-10-03T18:00:00+09:00", "2026-10-03T09:00:00Z")).toBe(true);
    expect(isApprovalExpired("2026-10-03T18:00:00+09:00", "2026-10-03T08:59:00Z")).toBe(false);
  });
  it("解釈できない時刻は期限切れとみなす（承認できない側）", () => {
    expect(isApprovalExpired("x", "2026-10-03T09:00:00Z")).toBe(true);
    expect(isApprovalExpired("2026-10-03T09:00:00Z", "y")).toBe(true);
  });
});

describe("computeApproverIds（BR-14）", () => {
  const roles: ApproverInput["roles"] = { owner1: "owner", owner2: "owner", maint: "maintainer", viewer: "viewer" };
  const approvers = (over: Partial<ApproverInput> = {}) =>
    computeApproverIds({ policyApprovers: [], requesterId: "maint", workspaceOwners: ["owner1", "owner2"], roles, ...over });

  it("ポリシーに approvers がなければ依頼者本人とワークスペースの owner（重複を除き、出た順）", () => {
    expect(approvers()).toEqual(["maint", "owner1", "owner2"]);
    expect(approvers({ requesterId: "owner1" })).toEqual(["owner1", "owner2"]);
  });

  it("0-H のゲスト：依頼者が唯一の owner なら本人だけ", () => {
    expect(computeApproverIds({ policyApprovers: [], requesterId: "g", workspaceOwners: ["g"], roles: { g: "owner" } })).toEqual(["g"]);
  });

  it("ポリシーに approvers があればその一覧（依頼者・owner は足さない）", () => {
    expect(approvers({ policyApprovers: ["owner2", "maint"] })).toEqual(["owner2", "maint"]);
  });

  it("maintainer 以上だけ残す（viewer・メンバーでない人は外す）", () => {
    expect(approvers({ requesterId: "viewer" })).toEqual(["owner1", "owner2"]);
    expect(approvers({ policyApprovers: ["viewer", "stranger", "maint"] })).toEqual(["maint"]);
    expect(approvers({ policyApprovers: ["viewer"] })).toEqual([]);
  });

  it("依頼者が分からない（定期の実行など）なら owner だけ。プロトタイプの名前は役割にならない", () => {
    expect(approvers({ requesterId: null })).toEqual(["owner1", "owner2"]);
    expect(approvers({ requesterId: "constructor", workspaceOwners: [] })).toEqual([]);
  });
});
