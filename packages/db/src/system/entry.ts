// 入口の試行（entry_attempts。BR-65 の「同じ IP から1時間に5件」と、失敗が続く IP の待ち時間：15:231・498）
// IP は保存しない。同じ IP の見分け方（IPv4 は完全一致、IPv6 は先頭 /64：SO §3.5【提案】）にそろえてから HMAC にする（M-55）。
// ワークスペースをまたぐ表（IP で数える）なので system に置く

import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { Queryable } from "../client.ts";
import type { EntryOutcome, Uuid } from "../types.ts";

export const ENTRY_LIMITS = {
  /** 失敗が続く IP の数え方（直近10分。SO I-13） */
  wrongTokenWindowMs: 10 * 60 * 1000,
  /** この件数（今回を含む）から待たせる */
  wrongTokenThreshold: 5,
  wrongTokenMaxDelayMs: 10_000,
  /** 24時間より古い行は掃除が消す（DB §4.4） */
  retentionMs: 24 * 60 * 60 * 1000,
} as const;

function expandIpv6(ip: string): number[] | null {
  let s = ip;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    // 末尾の IPv4（::ffff:1.2.3.4 など）を2つの16ビットにする
    const p = tail.split(".").map((x) => Number(x));
    if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
    const [a, b, c, d] = p as [number, number, number, number];
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  let groups: string[];
  if (rest === null) {
    groups = head;
  } else {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<string>(fill).fill("0"), ...rest];
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => Number.parseInt(g, 16));
  return nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff) ? null : nums;
}

/**
 * 同じ IP として数える単位にそろえる。IPv4 はそのまま、IPv4 に写した IPv6（::ffff:a.b.c.d）は IPv4、
 * それ以外の IPv6 は先頭 /64（'2001:db8:1:1::/64'）。IP として読めない値は小文字にしただけで返す
 */
export function normalizeIp(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const kind = isIP(s);
  if (kind === 4) return s;
  if (kind !== 6) return s;
  const g = expandIpv6(s);
  if (!g) return s;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const v6 = g[6] ?? 0;
    const v7 = g[7] ?? 0;
    return `${v6 >> 8}.${v6 & 0xff}.${v7 >> 8}.${v7 & 0xff}`;
  }
  return `${g.slice(0, 4).map((n) => n.toString(16)).join(":")}::/64`;
}

/** 入口の試行・セッションに残す IP（HMAC-SHA256 の16進64桁）。secret は app の秘密（例 SESSION_COOKIE_SECRET） */
export function hashIp(ip: string, secret: string): string {
  if (secret.length < 16) throw new RangeError("IP の HMAC の鍵が短すぎる");
  return createHmac("sha256", secret).update(`ip:${normalizeIp(ip)}`, "utf8").digest("hex");
}

/** 入口の試行を1行足す */
export async function recordEntryAttempt(
  q: Queryable,
  i: { ipHash: string; outcome: EntryOutcome; workspaceId?: Uuid | null; now: Date },
): Promise<void> {
  await q.query("INSERT INTO entry_attempts (ip_hash, outcome, workspace_id, created_at) VALUES ($1, $2, $3, $4)", [
    i.ipHash,
    i.outcome,
    i.workspaceId ?? null,
    i.now,
  ]);
}

/** 同じ IP の、since より後（created_at > since。ちょうどは数えない）の試行の数 */
export async function countEntryAttempts(
  q: Queryable,
  i: { ipHash: string; outcomes: readonly EntryOutcome[]; since: Date },
): Promise<number> {
  const r = await q.query<{ n: number }>(
    "SELECT count(*) AS n FROM entry_attempts WHERE ip_hash = $1 AND outcome = ANY($2::text[]) AND created_at > $3",
    [i.ipHash, [...i.outcomes], i.since],
  );
  return r.rows[0]?.n ?? 0;
}

/** 失敗が続く IP の待ち時間：直近10分の失敗が5件目から 1・2・4・8・10秒（上限）。429 にはしない（SO §3.4、I-13） */
export function wrongTokenDelayMs(failuresInWindow: number): number {
  if (failuresInWindow < ENTRY_LIMITS.wrongTokenThreshold) return 0;
  const exp = failuresInWindow - ENTRY_LIMITS.wrongTokenThreshold;
  return Math.min(1000 * 2 ** Math.min(exp, 10), ENTRY_LIMITS.wrongTokenMaxDelayMs);
}

/** トークン違いを残し、直近10分の失敗の数（今回を含む）と待ち時間を返す（DB §4.3 の2） */
export async function recordWrongToken(q: Queryable, i: { ipHash: string; now: Date }): Promise<{ failures: number; delayMs: number }> {
  await recordEntryAttempt(q, { ipHash: i.ipHash, outcome: "wrong_token", workspaceId: null, now: i.now });
  const failures = await countEntryAttempts(q, {
    ipHash: i.ipHash,
    outcomes: ["wrong_token"],
    since: new Date(i.now.getTime() - ENTRY_LIMITS.wrongTokenWindowMs),
  });
  return { failures, delayMs: wrongTokenDelayMs(failures) };
}
