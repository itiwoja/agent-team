// 全体（全ワークスペース）の今日の費用（BR-62 の全体1日 $10。SO §3.12 の checkSpend・canStartWork が使う）。
// ワークスペースごとの費用は repo の側（ワークスペースで絞る）。金額は整数のマイクロドルで比べる（浮動小数で足さない：T-117）

import type { Queryable } from "../client.ts";
import type { UsdDecimal } from "../types.ts";

/** 「1日」の区切り（SO I-08。全体の $10 も Asia/Tokyo の0時） */
export const BUDGET_TIME_ZONE = "Asia/Tokyo";

const USD_RE = /^(-?)(\d+)(?:\.(\d{1,6}))?$/;

/** '0.950000' → 950000（文字列のまま10進で読む。小数7桁以上・指数表記は例外） */
export function usdToMicro(usd: UsdDecimal): number {
  const m = USD_RE.exec(usd.trim());
  if (!m) throw new RangeError(`USD の形ではない：${usd}`);
  const micro = Number(m[2]) * 1_000_000 + Number((m[3] ?? "").padEnd(6, "0"));
  if (!Number.isSafeInteger(micro)) throw new RangeError(`USD が大きすぎる：${usd}`);
  return m[1] === "-" && micro !== 0 ? -micro : micro;
}

/** 950000 → '0.950000' */
export function microToUsd(micro: number): UsdDecimal {
  if (!Number.isSafeInteger(micro)) throw new RangeError(`マイクロドルが整数ではない：${micro}`);
  const abs = Math.abs(micro);
  const whole = Math.floor(abs / 1_000_000);
  const frac = String(abs % 1_000_000).padStart(6, "0");
  return `${micro < 0 ? "-" : ""}${whole}.${frac}`;
}

/** now を含む timeZone の1日 [start, end)（夏時間でもずれない SQL：DB §4.10） */
export async function dayRange(q: Queryable, now: Date, timeZone: string = BUDGET_TIME_ZONE): Promise<{ start: Date; end: Date }> {
  const r = await q.query<{ start: Date; end: Date }>(
    `SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2) AS start,
            ((date_trunc('day', $1::timestamptz AT TIME ZONE $2) + interval '1 day') AT TIME ZONE $2) AS "end"`,
    [now, timeZone],
  );
  const row = r.rows[0];
  if (!row) throw new Error("日の範囲を計算できなかった");
  return row;
}

/** 全ワークスペースの今日（timeZone の0時から）の費用。小数6桁の文字列 */
export async function getPlatformDayCostUsd(q: Queryable, now: Date, timeZone: string = BUDGET_TIME_ZONE): Promise<UsdDecimal> {
  const r = await q.query<{ usd: string }>(
    `WITH d AS (
       SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2) AS start,
              ((date_trunc('day', $1::timestamptz AT TIME ZONE $2) + interval '1 day') AT TIME ZONE $2) AS "end"
     )
     SELECT COALESCE(sum(u.cost_usd), 0)::numeric(16,6)::text AS usd
       FROM usage_records u, d
      WHERE u.created_at >= d.start AND u.created_at < d."end"`,
    [now, timeZone],
  );
  return r.rows[0]?.usd ?? "0.000000";
}
