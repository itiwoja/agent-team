import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classify } from "@open-team/kernel";
import {
  buildCertificate,
  caseSetHash,
  certificateHashOf,
  certificateStatus,
  expiryReasons,
  isCertificateValid,
  normalizeToolHashes,
  type CaseSetEntry,
  type CertificateInput,
  type CertificateRef,
  type ToolHashEntry,
} from "./certificate.ts";
import { BUYER, BUYER_R, CTX, F01, F03, H, def, guard, scenarioOf } from "./test-helpers.ts";

const POLICY = "p".repeat(64);
const TOOLS: ToolHashEntry[] = [
  { action: "mcp.supplier.place_order", toolHash: H("a") },
  { action: "mcp.bank.register_payee", toolHash: H("d") },
];
const caseA: CaseSetEntry = { source: "generated", scenario: scenarioOf([F01], 1), simSnapshotId: null };
const caseB: CaseSetEntry = { source: "user", scenario: scenarioOf([F03], 2, "user"), simSnapshotId: null };
const caseC: CaseSetEntry = { source: "incident", scenario: scenarioOf([], 3), simSnapshotId: "snap-1" };

const input = (over: Partial<CertificateInput> = {}): CertificateInput => ({
  jobId: "job-1",
  policyHash: POLICY,
  toolHashes: TOOLS,
  modelId: "gemini-x",
  cases: [caseA, caseB, caseC],
  results: [
    { caseId: "c1", source: "generated", verdict: "pass" },
    { caseId: "c2", source: "user", verdict: "pass" },
    { caseId: "c3", source: "incident", verdict: "pass" },
  ],
  costUsd: "0.1200",
  issuedAt: "2026-10-08T18:02:00+09:00",
  ...over,
});

describe("caseSetHash", () => {
  it("同じ集合なら順に依存せず同じ。64桁の16進", () => {
    const h = caseSetHash([caseA, caseB, caseC]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(caseSetHash([caseC, caseA, caseB])).toBe(h);
  });
  it("シードが違えば別の集合（状況の JSON が同じでも）", () => {
    const other: CaseSetEntry = { ...caseA, scenario: scenarioOf([F01], 99) };
    expect(caseSetHash([other])).not.toBe(caseSetHash([caseA]));
  });
  it("試験の追加・除去・出どころ・スナップショットの違いで変わる。同じ試験の重複も件数として数える", () => {
    const base = caseSetHash([caseA, caseB]);
    expect(caseSetHash([caseA, caseB, caseC])).not.toBe(base);
    expect(caseSetHash([caseA])).not.toBe(base);
    expect(caseSetHash([caseA, caseA])).not.toBe(caseSetHash([caseA]));
    expect(caseSetHash([{ ...caseA, source: "user" }])).not.toBe(caseSetHash([caseA]));
    expect(caseSetHash([{ ...caseC, simSnapshotId: "snap-2" }])).not.toBe(caseSetHash([caseC]));
  });
  it("空の集合にもハッシュがある", () => {
    expect(caseSetHash([])).toMatch(/^[0-9a-f]{64}$/);
  });
  it("性質：どの並べ替えでも同じ", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([caseA, caseB, caseC], { minLength: 0 }), (subset) => {
        const sorted = [...subset].sort((x, y) => x.scenario.seed - y.scenario.seed);
        expect(caseSetHash([...subset].reverse())).toBe(caseSetHash(sorted));
      }),
    );
  });
});

describe("buildCertificate", () => {
  it("全件合格で作る。中身の要約・ハッシュ（中身の正規形）・ツールの並びの正規化", () => {
    const r = buildCertificate(input({ toolHashes: [...TOOLS].reverse() }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.certificate;
    expect(c.toolHashes.map((t) => t.action)).toEqual(["mcp.bank.register_payee", "mcp.supplier.place_order"]);
    expect(c.caseCount).toBe(3);
    expect(c.caseSetHash).toBe(caseSetHash([caseA, caseB, caseC]));
    expect(c.summary).toEqual({ caseCount: 3, passed: 3, bySource: { generated: 1, user: 1, incident: 1 } });
    const { certificateHash, ...content } = c;
    expect(certificateHash).toBe(certificateHashOf(content));
    // ツールの渡し順が違っても同じ合格証
    const again = buildCertificate(input());
    expect(again.ok && again.certificate.certificateHash).toBe(certificateHash);
  });
  it("1件でも不合格なら作らない（失敗した試験を返す）", () => {
    const r = buildCertificate(input({ results: [{ caseId: "c1", source: "generated", verdict: "pass" }, { caseId: "c2", source: "user", verdict: "fail" }, { caseId: "c3", source: "incident", verdict: "pass" }] }));
    expect(r).toEqual({ ok: false, reason: "not_all_passed", failedCaseIds: ["c2"] });
  });
  it("試験が0件・結果の件数が合わないときは作らない", () => {
    expect(buildCertificate(input({ cases: [], results: [] }))).toMatchObject({ ok: false, reason: "no_cases" });
    expect(buildCertificate(input({ results: [{ caseId: "c1", source: "generated", verdict: "pass" }] }))).toMatchObject({ ok: false, reason: "result_mismatch" });
  });
  it("発行日時・費用・モデルが違えばハッシュも違う", () => {
    const a = buildCertificate(input());
    const b = buildCertificate(input({ issuedAt: "2026-10-09T00:00:00+09:00" }));
    expect(a.ok && b.ok && a.certificate.certificateHash !== b.certificate.certificateHash).toBe(true);
  });
});

describe("合格証の有効・切れる理由", () => {
  const built = buildCertificate(input());
  if (!built.ok) throw new Error("fixture");
  const cert: CertificateRef = built.certificate;
  const now = { policyHash: POLICY, toolHashes: TOOLS, modelId: "gemini-x", caseSetHash: cert.caseSetHash };

  it("何も変わらなければ有効", () => {
    expect(certificateStatus(cert, now)).toEqual({ valid: true });
    expect(isCertificateValid(cert, now)).toBe(true);
  });
  it("合格証がない → 無効（missing）", () => {
    expect(certificateStatus(null, now)).toEqual({ valid: false, reason: "missing" });
  });
  it("別の仕事の合格証は有効にしない", () => {
    expect(isCertificateValid(cert, { ...now, jobId: "job-2" })).toBe(false);
    expect(isCertificateValid(cert, { ...now, jobId: "job-1" })).toBe(true);
  });
  it("切れた印（revokedAt）がある → 無効（理由を引き継ぐ）", () => {
    expect(certificateStatus({ ...cert, revokedAt: "2026-10-09T00:00:00+09:00", revokeReason: "model" }, now)).toEqual({ valid: false, reason: "revoked", revokeReason: "model" });
  });
  it("tool_hash の変化・1件の増減で切れる（並べ替えでは切れない）", () => {
    expect(expiryReasons(cert, { ...now, toolHashes: [...TOOLS].reverse() })).toEqual([]);
    expect(expiryReasons(cert, { ...now, toolHashes: [{ action: TOOLS[0]!.action, toolHash: H("e") }, TOOLS[1]!] })).toEqual(["tool_hash"]);
    expect(expiryReasons(cert, { ...now, toolHashes: [TOOLS[0]!] })).toEqual(["tool_hash"]);
    expect(expiryReasons(cert, { ...now, toolHashes: [...TOOLS, { action: "mcp.mail.send", toolHash: H("c") }] })).toEqual(["tool_hash"]);
  });
  it("モデルの変更で切れる", () => {
    expect(expiryReasons(cert, { ...now, modelId: "gemini-y" })).toEqual(["model"]);
  });
  it("試験の集合が変わると切れる（追加も、外した・差し替えた場合も）", () => {
    expect(expiryReasons(cert, { ...now, caseSetHash: caseSetHash([caseA, caseB, caseC, { ...caseA, scenario: scenarioOf([F01], 7) }]) })).toEqual(["case_added"]);
    expect(expiryReasons(cert, { ...now, caseSetHash: caseSetHash([caseA, caseB]) })).toEqual(["case_added"]);
  });
  it("policyHash の違いだけでは切れない：classify が narrow・neutral なら有効、widen なら切れる", () => {
    const changed = { ...now, policyHash: "q".repeat(64) };
    expect(expiryReasons(cert, { ...changed, policyChange: "narrow" })).toEqual([]);
    expect(expiryReasons(cert, { ...changed, policyChange: "neutral" })).toEqual([]);
    expect(expiryReasons(cert, { ...changed, policyChange: "widen" })).toEqual(["widen"]);
  });
  it("policyHash が違うのに分類がない → 広げていないと言い切れないので切れる（締める側）", () => {
    expect(expiryReasons(cert, { ...now, policyHash: "q".repeat(64) })).toEqual(["widen"]);
    expect(expiryReasons(cert, { ...now, policyHash: "q".repeat(64), policyChange: null })).toEqual(["widen"]);
  });
  it("policyHash が同じなら分類が widen と渡されても切れない（変更なし）", () => {
    expect(expiryReasons(cert, { ...now, policyChange: "widen" })).toEqual([]);
  });
  it("複数が重なれば優先順（widen → tool_hash → model → case_added）で全部返し、status は expired", () => {
    const r = certificateStatus(cert, { policyHash: "q".repeat(64), policyChange: "widen", toolHashes: [], modelId: "z", caseSetHash: "0".repeat(64) });
    expect(r).toEqual({ valid: false, reason: "expired", expiry: ["widen", "tool_hash", "model", "case_added"] });
  });

  it("kernel の classify と組み合わせる：ガード追加（narrow）では切れず、ルール追加（widen）では切れる", () => {
    const narrow = classify({ before: BUYER_R, after: def((d) => (d.jobs[0].guards = [guard("items[].quantity", { max: 20 })]), BUYER_R), ctx: CTX });
    expect(narrow.classification).toBe("narrow");
    expect(expiryReasons(cert, { ...now, policyHash: "q".repeat(64), policyChange: narrow.classification })).toEqual([]);
    const widen = classify({ before: BUYER, after: BUYER_R, ctx: CTX });
    expect(widen.classification).toBe("widen");
    expect(expiryReasons(cert, { ...now, policyHash: "q".repeat(64), policyChange: widen.classification })).toEqual(["widen"]);
  });
});

describe("normalizeToolHashes", () => {
  it("action の昇順・同じ組の重複は1件・同じ action で値が違えば両方残す", () => {
    const n = normalizeToolHashes([TOOLS[0]!, TOOLS[1]!, TOOLS[0]!, { action: TOOLS[0]!.action, toolHash: H("f") }]);
    expect(n.map((e) => `${e.action}:${e.toolHash.slice(7, 8)}`)).toEqual(["mcp.bank.register_payee:d", "mcp.supplier.place_order:a", "mcp.supplier.place_order:f"]);
  });
});
