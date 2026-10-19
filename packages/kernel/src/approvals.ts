// 承認の期限（IA §3.7-1、intents.md:89、BR-60）と承認者（BR-14）
// 期限は「作成から24時間」と「そのタスクの依頼の次の実行（asks.next_run_at）」の早い方（M-25：定期のトリガーは仕事ではなく依頼が持つ）
// 時刻は引数で受け取り、UTC の ISO 8601 で返す（純粋関数。Date.now・引数なしの new Date は使わない）

import type { IsoDateTime } from "./types.ts";

/** 承認の期限（A-05：24時間） */
export const APPROVAL_TTL_MS = 24 * 60 * 60_000;

export type ApprovalExpiryCause = "ttl" | "next_run";
export interface ApprovalExpiry {
  expiresAt: IsoDateTime;
  /** approvals.expiry_cause。next_run で切れたものは期限切れのときに superseded として数える（IA §8-21） */
  cause: ApprovalExpiryCause;
}

function parseTime(value: IsoDateTime, name: string): number {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`${name} が ISO 8601 の時刻でない`);
  return ms;
}

/**
 * 承認の期限（intents.md:89「min(作成から24時間, 同じ仕事の次の実行の予定時刻)」を M-25 で依頼の next_run_at にしたもの）。
 * askNextRunAt が作成より後で24時間より前なら next_run、それ以外は ttl（ちょうど24時間後は ttl）。
 * 作成の時刻以前の next_run_at（進め忘れた古い値）は使わない（すぐ期限切れにしない。置き換えは次の実行の開始で起きる：BR-60）。
 * 時刻が解釈できなければ例外（期限を決められない承認は作らない）
 */
export function computeApprovalExpiry(i: { createdAt: IsoDateTime; askNextRunAt: IsoDateTime | null }): ApprovalExpiry {
  const created = parseTime(i.createdAt, "createdAt");
  const ttl = created + APPROVAL_TTL_MS;
  if (i.askNextRunAt !== null) {
    const next = parseTime(i.askNextRunAt, "askNextRunAt");
    if (next > created && next < ttl) return { expiresAt: new Date(next).toISOString(), cause: "next_run" };
  }
  return { expiresAt: new Date(ttl).toISOString(), cause: "ttl" };
}

/**
 * 承認の期限が切れているか（IA §3.9-4-2・§3.15 の境界：now = expires_at ちょうどで期限切れ。API-019 は now < expires_at だけ通す）。
 * 時刻が解釈できなければ切れているとみなす（承認できない側に倒す）
 */
export function isApprovalExpired(expiresAt: IsoDateTime, now: IsoDateTime): boolean {
  const e = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  const n = typeof now === "string" ? Date.parse(now) : Number.NaN;
  if (!Number.isFinite(e) || !Number.isFinite(n)) return true;
  return n >= e;
}

export type MemberRole = "owner" | "maintainer" | "viewer";

export interface ApproverInput {
  /** 実効ポリシーの approvers（ユーザー ID）。空配列は BR-14 の既定（KC §2.3） */
  policyApprovers: readonly string[];
  /** 依頼者（タスク・依頼を作ったユーザー）。定期の実行などで分からなければ null */
  requesterId: string | null;
  workspaceOwners: readonly string[];
  /** ワークスペースのメンバーのロール（ユーザー ID → ロール）。ここにない人はメンバーでない */
  roles: Readonly<Record<string, MemberRole>>;
}

/**
 * 承認者（BR-14）：ポリシーに approvers があればその一覧、なければ依頼者本人とワークスペースの owner。
 * どちらも maintainer 以上（owner・maintainer）だけ残す。重複を除き、最初に出た順。作成時に approvals.approver_ids に固める
 */
export function computeApproverIds(i: ApproverInput): string[] {
  const base = i.policyApprovers.length > 0 ? [...i.policyApprovers] : [...(i.requesterId === null ? [] : [i.requesterId]), ...i.workspaceOwners];
  const out: string[] = [];
  for (const id of base) {
    if (typeof id !== "string" || out.includes(id)) continue;
    const role = Object.hasOwn(i.roles, id) ? i.roles[id] : undefined;
    if (role === "owner" || role === "maintainer") out.push(id);
  }
  return out;
}
