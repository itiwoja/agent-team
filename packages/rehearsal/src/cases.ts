// 試験の集合の管理（FR-065・066・BR-78・80・A-106・A-107）：出どころ、仕事ごとの上限20件、超えたときのまとめ方、ゲストの1日の上限
// 純粋関数（I/O・時刻・乱数なし。今の時刻は引数で受ける）。DB への反映（removed_at・removed_reason = 'merged'）は呼び出し側

import type { IsoDateTime } from "@open-team/kernel";
import { jstDateOf, parseIso } from "@open-team/sim-core";
import type { CaseSource } from "@open-team/sim-core";

/** 仕事ごとの試験の上限（A-107） */
export const MAX_CASES_PER_JOB = 20;
/** ゲストの自分の言葉の悪い日（source = user）の1日の上限（A-106・BR-78） */
export const GUEST_USER_CASES_PER_DAY = 5;

/** 管理に使う試験1件の項目（rehearsal_cases の行から取る） */
export interface CaseRecord {
  id: string;
  jobId: string;
  source: CaseSource;
  /** incident のとき Kernel の reasonCode（まとめる単位）。ほかは null */
  reasonCode: string | null;
  createdAt: IsoDateTime;
  /** 外された時刻。外されていなければ null */
  removedAt: IsoDateTime | null;
}

/** 外されていない試験（合格証の対象・上限の数え方の対象） */
export function activeCases<T extends Pick<CaseRecord, "removedAt">>(cases: readonly T[]): T[] {
  return cases.filter((c) => c.removedAt === null);
}

/**
 * 同じ reasonCode の古い incident を、新しいほうの1件にまとめる（removed_reason = 'merged'）。
 * 呼び出し側は、まとめた試験の stopped_writes を残す1件に足す（O-08 が見る止まった書き込みを減らさない：締める側）
 */
export interface CaseMerge {
  reasonCode: string;
  /** 残す試験（新しいほう） */
  keepId: string;
  /** まとめて外す試験（古いほう。removed_reason = 'merged'） */
  mergedIds: string[];
}

export type AddCasePlan =
  | { ok: true; merges: CaseMerge[]; activeAfter: number }
  /** まとめても20件に収まらない（まとめられる incident が尽きた）。試験を黙って捨てない：追加せず理由を返す */
  | { ok: false; reason: "limit_reached"; activeCount: number };

const byAge = (a: CaseRecord, b: CaseRecord): number =>
  parseIso(a.createdAt) - parseIso(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * 試験を1件足すときの計画。同じ仕事の外されていない試験が上限（20件）を超えるなら、
 * 「同じ reasonCode の incident が2件以上ある組」のうち最も古い incident を含む組から、古い2件を新しい1件にまとめ、
 * 収まるまで繰り返す。generated・user はまとめない（まとめるのは本番の停止＝回帰の試験だけ。15:196）。
 * 足す試験は existing に入れない（同じ id があれば例外）
 */
export function planAddCase(existing: readonly CaseRecord[], added: CaseRecord): AddCasePlan {
  if (existing.some((c) => c.id === added.id)) throw new TypeError(`planAddCase: 試験の id ${added.id} が既にある`);
  let pool = [...activeCases(existing).filter((c) => c.jobId === added.jobId), added];
  const merges: CaseMerge[] = [];
  while (pool.length > MAX_CASES_PER_JOB) {
    const groups = new Map<string, CaseRecord[]>();
    for (const c of pool) {
      if (c.source !== "incident" || c.reasonCode === null) continue;
      const list = groups.get(c.reasonCode);
      if (list) list.push(c);
      else groups.set(c.reasonCode, [c]);
    }
    const mergeable = [...groups.entries()]
      .filter(([, list]) => list.length >= 2)
      .map(([reasonCode, list]) => ({ reasonCode, list: [...list].sort(byAge) }))
      .sort((a, b) => byAge(a.list[0]!, b.list[0]!));
    const target = mergeable[0];
    if (target === undefined) return { ok: false, reason: "limit_reached", activeCount: pool.length - 1 };
    const [older, newer] = [target.list[0]!, target.list[1]!];
    merges.push({ reasonCode: target.reasonCode, keepId: newer.id, mergedIds: [older.id] });
    pool = pool.filter((c) => c.id !== older.id);
  }
  return { ok: true, merges: foldMerges(merges), activeAfter: pool.length };
}

/** 同じ keepId・同じ reasonCode のまとめを1つにし、まとめた先がさらにまとめられたら最後の残る1件へつなぐ */
function foldMerges(merges: readonly CaseMerge[]): CaseMerge[] {
  const out: CaseMerge[] = [];
  for (const original of merges) {
    let m = original;
    // 先に残すことにした試験が、あとで古いほうとしてまとめられたら、その試験がまとめた分も新しい残す先へ移す
    const absorbed = out.find((o) => o.keepId === m.mergedIds[0]);
    if (absorbed) {
      out.splice(out.indexOf(absorbed), 1);
      m = { reasonCode: m.reasonCode, keepId: m.keepId, mergedIds: [...m.mergedIds, ...absorbed.mergedIds] };
    }
    const same = out.find((o) => o.keepId === m.keepId);
    if (same) same.mergedIds.push(...m.mergedIds);
    else out.push({ ...m, mergedIds: [...m.mergedIds] });
  }
  return out;
}

// ---- ゲストの1日の上限 ----

/** now と同じ JST の日に作られたものの数（外された試験・解釈できなかった入力も数える：費用がかかっているので外しても戻さない） */
export function countOnSameJstDay(createdAts: readonly IsoDateTime[], now: IsoDateTime): number {
  const today = jstDateOf(parseIso(now));
  return createdAts.filter((t) => jstDateOf(parseIso(t)) === today).length;
}

export interface UserCaseQuota {
  allowed: boolean;
  /** 残り件数。オーナー（上限なし）は null */
  remaining: number | null;
}

/**
 * 自分の言葉の悪い日（FR-065）を足してよいか。ゲストは1日5件まで（A-106）。
 * usedToday は今日（JST）の user の試験の数（countOnSameJstDay で数える）。数が壊れていたら不可（締める側）
 */
export function userCaseQuota(input: { workspaceKind: "owner" | "guest"; usedToday: number }): UserCaseQuota {
  if (input.workspaceKind === "owner") return { allowed: true, remaining: null };
  if (!Number.isInteger(input.usedToday) || input.usedToday < 0) return { allowed: false, remaining: 0 };
  const remaining = Math.max(0, GUEST_USER_CASES_PER_DAY - input.usedToday);
  return { allowed: remaining > 0, remaining };
}
