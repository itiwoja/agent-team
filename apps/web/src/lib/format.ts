/** $0.003（1セント未満は小数3桁、それ以上は2桁）。壊れた値は null */
export function formatUsd(v: string | number): string | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return `$${n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`;
}

/** 7:02（今日）／10/8 18:02（それ以外） */
export function formatTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
