// 予定の登録（mcp.gcal.create_event）が実行されたあとの「カレンダーで開く」のリンク（16 §3.7）。
// 保存された結果（action_intents.result。gateway が書いた { content, isError, truncated }）の中の html_link だけを使う。
// 結果は外部（カレンダー）から来たものなので信用しない：https で、ホストが Google のカレンダーのものだけ通す。

const CALENDAR_ACTION = "mcp.gcal.create_event";
const CALENDAR_HOSTS: ReadonlySet<string> = new Set(["www.google.com", "calendar.google.com"]);

/** 文字列を https の Google カレンダーの URL として読む。合わなければ null */
function calendarUrlOf(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (!CALENDAR_HOSTS.has(url.hostname)) return null;
  return url.toString();
}

/** 保存された結果の中から html_link を探す（そのまま入っている形と、content の文字列の JSON の中の形の両方） */
function htmlLinkIn(stored: unknown): unknown {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return undefined;
  const direct = (stored as Record<string, unknown>).html_link;
  if (direct !== undefined) return direct;
  const content = (stored as Record<string, unknown>).content;
  if (typeof content !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return (parsed as Record<string, unknown>).html_link;
  } catch {
    // JSON でない本文（既定の文）はリンクなし
  }
  return undefined;
}

/**
 * 「カレンダーで開く」のリンク。action が予定の登録で、html_link が https://www.google.com か https://calendar.google.com の
 * URL のときだけ返す。それ以外（別の操作・http・javascript:・別のホスト・壊れた値）は null
 */
export function calendarLinkOf(action: string, storedResult: unknown): string | null {
  if (action !== CALENDAR_ACTION) return null;
  return calendarUrlOf(htmlLinkIn(storedResult));
}
