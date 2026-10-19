// 依頼の一覧（`/asks`）の純粋な部分：状態の言い方・絞り込みの区分・検索の当たり方
import type { AskStatus, AskSummary } from "../api";

/** 依頼の状態の1語（依頼のページ・エージェントの画面と同じ語） */
export const ASK_STATUS_TEXT: Record<AskStatus, string> = {
  generating: "生成中",
  running: "動いています",
  waiting_input: "手が要ります",
  done: "済み",
  failed: "失敗",
  cancelled: "取り消し",
};

/** 絞り込みの区分。生成中は「動いている」に、取り消しは「済み」に入れる（利用者には同じ意味なので分けない） */
export type AskFilter = "all" | "active" | "waiting" | "done" | "failed";

export const ASK_FILTERS: ReadonlyArray<{ id: AskFilter; label: string }> = [
  { id: "all", label: "すべて" },
  { id: "waiting", label: "手が要る" },
  { id: "active", label: "動いている" },
  { id: "done", label: "済み" },
  { id: "failed", label: "失敗" },
];

export function filterOf(status: AskStatus): Exclude<AskFilter, "all"> {
  switch (status) {
    case "generating":
    case "running":
      return "active";
    case "waiting_input":
      return "waiting";
    case "failed":
      return "failed";
    case "done":
    case "cancelled":
      return "done";
  }
}

/** URL の ?status= を区分に戻す（知らない値は all） */
export function parseAskFilter(raw: string | null): AskFilter {
  return ASK_FILTERS.some((f) => f.id === raw) ? (raw as AskFilter) : "all";
}

/** 状態の札の色（ask.css の .stage-state と同じ約束：済み＝緑、動いている・手が要る＝琥珀、失敗＝赤、ほか＝灰） */
export function statusTone(status: AskStatus): "done" | "running" | "failed" | "muted" {
  switch (status) {
    case "done":
      return "done";
    case "generating":
    case "running":
    case "waiting_input":
      return "running";
    case "failed":
      return "failed";
    case "cancelled":
      return "muted";
  }
}

/** 検索に使う部分（定期のラベルだけ見る） */
type Searchable = Pick<AskSummary, "text" | "answerPreview"> & { trigger: { label: string } | null };

/** 検索の言葉に当たるか（依頼の文・回答の要約・定期のラベルのどこかに、空白で区切った言葉がすべて含まれる） */
export function askMatches(a: Searchable, q: string): boolean {
  const words = q.toLowerCase().split(/[\s　]+/).filter((w) => w !== "");
  if (words.length === 0) return true;
  const hay = [a.text, a.answerPreview ?? "", a.trigger?.label ?? ""].join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** 区分と言葉で絞る（並びは保つ） */
export function filterAsks<T extends Searchable & Pick<AskSummary, "status">>(asks: readonly T[], filter: AskFilter, q: string): T[] {
  return asks.filter((a) => (filter === "all" || filterOf(a.status) === filter) && askMatches(a, q));
}

/** 区分ごとの件数（札に添える。0 の区分も 0 で返す） */
export function countByFilter(asks: ReadonlyArray<Pick<AskSummary, "status">>): Record<AskFilter, number> {
  const n: Record<AskFilter, number> = { all: asks.length, active: 0, waiting: 0, done: 0, failed: 0 };
  for (const a of asks) n[filterOf(a.status)] += 1;
  return n;
}
