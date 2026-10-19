// 定期の依頼の次の時刻（asks.next_run_at。D-70 の「毎日18時」。毎分の tick が next_run_at <= now の依頼を始める：DB §4.12）
// 0-H の依頼のトリガーは Asia/Tokyo の毎日の時刻だけ（cron の日・月・曜日は '*'）。JST は夏時間がないので +09:00 で計算する。
// それ以外の cron・タイムゾーンは 0-H では作らない（例外。設定プランナーの検証で先に弾く）

import { parseCronSchedule } from "@open-team/kernel";

const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class UnsupportedScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedScheduleError";
  }
}

/** after より後（ちょうどは含まない）の最初の実行の時刻 */
export function nextScheduledRun(trigger: { cron: string; timezone: string }, after: Date): Date {
  if (trigger.timezone !== "Asia/Tokyo") throw new UnsupportedScheduleError(`タイムゾーン ${trigger.timezone} の定期は 0-H では扱わない`);
  const fields = trigger.cron.trim().split(/\s+/);
  if (fields.length !== 5 || fields[2] !== "*" || fields[3] !== "*" || fields[4] !== "*") {
    throw new UnsupportedScheduleError(`毎日の時刻でない cron は 0-H では扱わない：${trigger.cron}`);
  }
  const parsed = parseCronSchedule(trigger.cron);
  if (parsed === null) throw new UnsupportedScheduleError(`cron を読めない：${trigger.cron}`);
  const t = after.getTime();
  if (!Number.isFinite(t)) throw new RangeError("after が正しい Date ではない");
  // JST の0時（UTC の値）
  const dayStart = Math.floor((t + TOKYO_OFFSET_MS) / DAY_MS) * DAY_MS - TOKYO_OFFSET_MS;
  for (let d = 0; d < 2; d++) {
    for (const h of parsed.hours) {
      for (const m of parsed.minutes) {
        const at = dayStart + d * DAY_MS + (h * 60 + m) * 60_000;
        if (at > t) return new Date(at);
      }
    }
  }
  // 毎日の時刻なので2日のうちに必ず見つかる
  throw new UnsupportedScheduleError(`次の時刻が見つからない：${trigger.cron}`);
}
