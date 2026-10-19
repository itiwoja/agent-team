// 合格証（FR-067・BR-81・D-78・ADR-039）：中身の組み立て、試験の集合のハッシュ、有効かの判定、切れる理由
// 純粋関数（I/O・時刻・乱数なし。発行日時・今のポリシーなどは引数で受ける）。ハッシュは kernel の正規形（canonical）で計算する

import { hashCanonical } from "@open-team/kernel";
import type { ChangeClass, Hex64, IsoDateTime, JsonObject, ToolHash, Uuid } from "@open-team/kernel";
import { CASE_SOURCES } from "@open-team/sim-core";
import type { CaseSource, RevokeReason, Scenario } from "@open-team/sim-core";

/** 使うツールの tool_hash の1件（packages/db の ToolHashEntry と同じ形。db に依存しないようここにも置く：純粋なパッケージは db を import しない） */
export interface ToolHashEntry {
  /** 'mcp.<connector>.<tool>' */
  action: string;
  toolHash: ToolHash;
}

/** 合格証が切れる理由（superseded は入れ替えの印で、条件の変化ではないので判定には使わない） */
export type ExpiryReason = Exclude<RevokeReason, "superseded">;

// ---- 試験の集合のハッシュ ----

/** ハッシュに入れる試験1件。外された試験（removed_at あり）は渡さない */
export interface CaseSetEntry {
  source: CaseSource;
  /** シードを含む状況（rehearsal_cases.scenario。seed も中にある） */
  scenario: Scenario;
  /** incident のスナップショット（同じ状況の JSON でも開始時の状態が違えば別の試験） */
  simSnapshotId: Uuid | null;
}

function entryHash(e: CaseSetEntry): Hex64 {
  // seed は scenario の中にもあるが、シードを含むことを明示するため外にも入れる（kernel の caseSetHash の説明：シードを含む試験集合）
  return hashCanonical({ source: e.source, seed: e.scenario.seed, scenario: e.scenario, simSnapshotId: e.simSnapshotId });
}

/**
 * 試験の集合の正準化ハッシュ。試験ごとのハッシュを昇順に並べてから全体をハッシュする（入力の順・DB の取り出し順に依存しない）。
 * 同じ試験を2件持つと2件として数える（重複を消さない。件数が変われば別の集合）
 */
export function caseSetHash(entries: readonly CaseSetEntry[]): Hex64 {
  const hashes = entries.map(entryHash).sort();
  return hashCanonical({ v: 1, cases: hashes });
}

/** ツール tool_hash の集合の正準形（action の昇順・重複は同じ値なら1件。同じ action で値が違えばそのまま残して不一致にする） */
export function normalizeToolHashes(entries: readonly ToolHashEntry[]): ToolHashEntry[] {
  const seen = new Set<string>();
  const out: ToolHashEntry[] = [];
  for (const e of entries) {
    const key = `${e.action}\u0000${e.toolHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ action: e.action, toolHash: e.toolHash });
  }
  return out.sort((a, b) => (a.action < b.action ? -1 : a.action > b.action ? 1 : a.toolHash < b.toolHash ? -1 : a.toolHash > b.toolHash ? 1 : 0));
}

// ---- 中身の組み立て ----

export interface CertificateCaseResult {
  caseId: string;
  source: CaseSource;
  /** オラクルの合否（executionVerdict の結果） */
  verdict: "pass" | "fail";
}

export interface CertificateInput {
  jobId: Uuid;
  /** 実効ポリシーの policyHash（D-19） */
  policyHash: Hex64;
  toolHashes: readonly ToolHashEntry[];
  modelId: string;
  /** 試験の集合（外されていないもの）。ハッシュはここから出す */
  cases: readonly CaseSetEntry[];
  /** 試験ごとの結果。cases と同じ件数が要る */
  results: readonly CertificateCaseResult[];
  /** 費用（USD の10進の文字列。db の UsdDecimal） */
  costUsd: string;
  /** 発行日時（呼び出し側の時刻） */
  issuedAt: IsoDateTime;
}

/** 合格証のハッシュ以外の中身（監査ログに入れる payload の元。rehearsal_certificates の列と対応） */
export interface CertificateContent {
  jobId: Uuid;
  policyHash: Hex64;
  toolHashes: ToolHashEntry[];
  modelId: string;
  caseSetHash: Hex64;
  caseCount: number;
  summary: JsonObject;
  costUsd: string;
  issuedAt: IsoDateTime;
}
export interface Certificate extends CertificateContent {
  certificateHash: Hex64;
}

export type CertificateBuild =
  | { ok: true; certificate: Certificate }
  | { ok: false; reason: "no_cases" | "result_mismatch" | "not_all_passed"; failedCaseIds: string[] };

/** 結果の要約（決まった形。出どころごとの件数と合格数） */
export function summarizeCases(results: readonly CertificateCaseResult[]): JsonObject {
  const bySource: Record<string, number> = Object.fromEntries(CASE_SOURCES.map((s) => [s, 0]));
  for (const r of results) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  return {
    caseCount: results.length,
    passed: results.filter((r) => r.verdict === "pass").length,
    bySource,
  };
}

/** 合格証のハッシュ（中身の正規形）。監査ログのハッシュチェーンに入れる値 */
export function certificateHashOf(content: CertificateContent): Hex64 {
  return hashCanonical(content);
}

/**
 * 合格証を組み立てる。試験が全件合格のときだけ作る（BR-81）。試験が0件のときは作らない
 * （何も試していない合格証でルールの auto を許さない。締める側）
 */
export function buildCertificate(input: CertificateInput): CertificateBuild {
  if (input.cases.length === 0 || input.results.length === 0) return { ok: false, reason: "no_cases", failedCaseIds: [] };
  if (input.cases.length !== input.results.length) return { ok: false, reason: "result_mismatch", failedCaseIds: [] };
  const failed = input.results.filter((r) => r.verdict !== "pass").map((r) => r.caseId);
  if (failed.length > 0) return { ok: false, reason: "not_all_passed", failedCaseIds: failed };
  const content: CertificateContent = {
    jobId: input.jobId,
    policyHash: input.policyHash,
    toolHashes: normalizeToolHashes(input.toolHashes),
    modelId: input.modelId,
    caseSetHash: caseSetHash(input.cases),
    caseCount: input.cases.length,
    summary: summarizeCases(input.results),
    costUsd: input.costUsd,
    issuedAt: input.issuedAt,
  };
  return { ok: true, certificate: { ...content, certificateHash: certificateHashOf(content) } };
}

// ---- 有効か・切れる理由 ----

/** 判定に使う合格証の項目（rehearsal_certificates の行から取る） */
export interface CertificateRef {
  jobId: Uuid;
  policyHash: Hex64;
  toolHashes: readonly ToolHashEntry[];
  modelId: string;
  caseSetHash: Hex64;
  /** 切れた印（revoked_at があれば切れている） */
  revokedAt?: IsoDateTime | null;
  revokeReason?: RevokeReason | null;
}

/** 今の状態 */
export interface CertificateCurrent {
  /** 渡したときは、別の仕事の合格証を「有効」にしない（締める側） */
  jobId?: Uuid;
  policyHash: Hex64;
  toolHashes: readonly ToolHashEntry[];
  modelId: string;
  /** 今の試験の集合のハッシュ（caseSetHash(外されていない試験)） */
  caseSetHash: Hex64;
  /**
   * 合格証を出したときの定義 → 今の定義を classify() にかけた分類。policyHash が同じなら省略してよい。
   * policyHash が違うのに null・省略なら、広げていないと言い切れないので widen として切る（締める側）
   */
  policyChange?: ChangeClass | null;
}

/** 切れる理由を、優先順（widen → tool_hash → model → case_added）で全部返す。空なら切れていない */
export function expiryReasons(cert: CertificateRef, current: CertificateCurrent): ExpiryReason[] {
  const reasons: ExpiryReason[] = [];
  // 締める変更（narrow）・neutral では切れない。policyHash の違いだけでも切れない（分類が widen か、分類できないときだけ）
  if (cert.policyHash !== current.policyHash) {
    const cls = current.policyChange ?? null;
    if (cls === null || cls === "widen") reasons.push("widen");
  }
  const a = normalizeToolHashes(cert.toolHashes);
  const b = normalizeToolHashes(current.toolHashes);
  if (a.length !== b.length || a.some((e, i) => e.action !== b[i]!.action || e.toolHash !== b[i]!.toolHash)) reasons.push("tool_hash");
  if (cert.modelId !== current.modelId) reasons.push("model");
  // 追加だけでなく、外した・差し替えた場合も集合が変わったので切る（外すのはユーザーの操作。裏付けのない許可を残さない）
  if (cert.caseSetHash !== current.caseSetHash) reasons.push("case_added");
  return reasons;
}

export type CertificateStatus =
  | { valid: true }
  | { valid: false; reason: "missing" }
  | { valid: false; reason: "revoked"; revokeReason: RevokeReason | null }
  | { valid: false; reason: "expired"; expiry: ExpiryReason[] };

/** 合格証が有効か（decide() の Flags.certificateValid に渡す値の元。BR-81）。ない・切れた印がある・条件が変わった → 無効 */
export function certificateStatus(cert: CertificateRef | null, current: CertificateCurrent): CertificateStatus {
  if (cert === null) return { valid: false, reason: "missing" };
  if (current.jobId !== undefined && current.jobId !== cert.jobId) return { valid: false, reason: "missing" };
  if (cert.revokedAt !== undefined && cert.revokedAt !== null) {
    return { valid: false, reason: "revoked", revokeReason: cert.revokeReason ?? null };
  }
  const expiry = expiryReasons(cert, current);
  return expiry.length > 0 ? { valid: false, reason: "expired", expiry } : { valid: true };
}

export function isCertificateValid(cert: CertificateRef | null, current: CertificateCurrent): boolean {
  return certificateStatus(cert, current).valid;
}
