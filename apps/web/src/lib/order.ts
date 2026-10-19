// SCR-019 の並び順（A-92）と、SSE（check.upsert・check.remove）の畳み込み
import type { CheckItem } from "../api";

const KIND_RANK: Record<CheckItem["kind"], number> = { approval: 0, question: 1, report: 2 };

/** 開いた状態で出す行が3つ以上あるとき、送る前の確認の中でそれらを先に置く（ask-and-check.md §危ない承認は開いて並べる） */
export const OPEN_FIRST_THRESHOLD = 3;

const isOpenApproval = (i: CheckItem): boolean => i.kind === "approval" && i.approval.openReason !== null;

/**
 * 送る前の確認 → 質問 → 報告。同じ種類の中は新しい順。
 * 仕事を止めているものほど上に置く。元の配列は変えない
 */
export function sortCheckItems(items: readonly CheckItem[]): CheckItem[] {
  const openCount = items.filter(isOpenApproval).length;
  const openFirst = openCount >= OPEN_FIRST_THRESHOLD;
  return [...items].sort((a, b) => {
    const k = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (k !== 0) return k;
    if (openFirst && a.kind === "approval") {
      const o = Number(isOpenApproval(b)) - Number(isOpenApproval(a));
      if (o !== 0) return o;
    }
    const t = Date.parse(b.at) - Date.parse(a.at);
    if (Number.isFinite(t) && t !== 0) return t;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** check.upsert（行が増えた・変わった）・check.remove（行が消えた）を一覧に当てる。知らない事象は何もしない */
export function applyCheckEvent(items: readonly CheckItem[], type: string, data: unknown): CheckItem[] {
  if (!data || typeof data !== "object") return [...items];
  if (type === "check.upsert") {
    const item = (data as { item?: CheckItem }).item;
    if (!item?.key) return [...items];
    const rest = items.filter((i) => i.key !== item.key);
    return sortCheckItems([...rest, item]);
  }
  if (type === "check.remove") {
    const key = (data as { key?: string }).key;
    return key ? items.filter((i) => i.key !== key) : [...items];
  }
  return [...items];
}

/** ○ や選択肢で消した行（サーバーに反映されるまで画面から隠す） */
export function withoutKeys(items: readonly CheckItem[], hidden: ReadonlySet<string>): CheckItem[] {
  return hidden.size === 0 ? [...items] : items.filter((i) => !hidden.has(i.key));
}
