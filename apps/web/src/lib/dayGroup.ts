// 日付の小見出し用の純粋な関数：ISO 文字列の並びを「今日」「昨日」「10月3日」ごとにまとめる。
// 日付はローカルタイム基準。入力の順（新しい順）を保ち、同じラベルの行は1つにまとめる

export interface DayGroup<T> {
  label: string;
  items: T[];
}

/** ローカルの日付だけを取り出す（時刻を 0 時に揃える） */
const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** now から見た日付のラベル。今日／昨日／10月3日（別の年なら 2025年10月3日） */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "日付不明";
  const diff = Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / 86_400_000);
  if (diff === 0) return "今日";
  if (diff === 1) return "昨日";
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

/**
 * items を日付のラベルごとにまとめる。at で各行の ISO 文字列を取り出す。
 * 空の配列なら空の配列を返す
 */
export function groupByDay<T>(items: readonly T[], at: (item: T) => string, now: Date = new Date()): DayGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const label = dayLabel(at(item), now);
    const bucket = groups.get(label);
    if (bucket) bucket.push(item);
    else groups.set(label, [item]);
  }
  return [...groups].map(([label, group]) => ({ label, items: group }));
}
