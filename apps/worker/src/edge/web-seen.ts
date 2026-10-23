// 汚染後の Web の出口（SG-04・D-30）の決まりごと（DB に触れない純粋な関数と定数）。
// - タスクは「見た URL の集合」を持つ：web_search の結果のリンク、web_fetch で取ったページの中のリンク（汚染の前後どちらで見たものも）
// - 汚染されたあとの web_fetch は、正規化した URL（クエリを含めて完全一致）が集合にあるときだけ取る。なければ tainted_unknown_url
//   （LLM が組み立てた・書き換えた URL に、読んだ秘密を載せて外へ出す経路を塞ぐ：R-11）
// - 汚染されたあとの web_search は、検索語の長さと形を絞る。外れたら tainted_query_shape
// 利用者自身が書いた文（依頼・返事）の URL と、汚染を引き継ぐ元のタスクの集合は、タスクを作るときに入れる（userTextWebUrlHashes・db の insertAskTask）。
// この制限は Kernel の decide には入れない（decide では汚染はどの手順の条件にも出てこない：BR-39・D-58）。edge の Web の出口で効かせる
// packages/edge/src/web-seen.ts の WorkspaceDO 版（中身は同じ。上限は db/repo/web-urls.ts の TASK_WEB_URLS_MAX。SHA-256 は nodejs_compat の node:crypto）

import { createHash } from "node:crypto";
import { TASK_WEB_URLS_MAX } from "../db/repo/web-urls.ts";

/**
 * 1タスクで覚える URL の上限（db の TASK_WEB_URLS_MAX と同じ値。タスクを作るときに写す側も同じ上限を使う）。
 * 超えた分は足さない（古いものを捨てると、汚染前に見た検索結果が辿れなくなり、
 * 足さなければ後から見たリンクが辿れなくなる。どちらも辿れる先が減る側だが、決まった順に効く「足さない」を選ぶ）。
 * 根拠：web_fetch の既定の上限（max_fetches_per_task）の回数ぶんのページから十分な数のリンクを覚えつつ、1タスクの行の数を抑える
 */
export const SEEN_URLS_MAX_PER_TASK = TASK_WEB_URLS_MAX;
/** 1ページ（1回の検索）から覚えるリンクの上限（大きな目次のページ1枚で集合を使い切らないように） */
export const SEEN_URLS_MAX_PER_PAGE = 500;
/** 覚える URL の長さの上限（文字）。これより長い URL は覚えない（ブラウザ・CDN の実用の上限の目安 8KB の半分） */
export const SEEN_URL_MAX_CHARS = 4_096;
/** 取ったページの結果に見せるリンクの数の上限（本文の後ろに付ける。トークンを食いすぎない量） */
export const PAGE_LINKS_SHOWN_MAX = 30;

/**
 * 汚染後の検索語の長さの上限（文字）。根拠：ふつうの調べものの検索語は数語〜数十字に収まる。
 * 一方、読んだ本文や秘密を検索語に載せて Google（の記録）へ持ち出す1回あたりの量をこの長さに抑える
 */
export const TAINTED_QUERY_MAX_CHARS = 100;
/**
 * 汚染後の検索語で拒む「符号化した断片に見える連続」の長さ（文字）。根拠：API キー・トークン・base64・16進は、
 * 英数字と + / = _ - （と、パーセント符号化の %）だけが長く続く。32 字は 128 ビットの16進・24 バイトの base64 にあたり、
 * ふつうの英単語・型番がこの長さで空白なしに続くことはまれ
 */
export const TAINTED_QUERY_ENCODED_RUN = 32;
const ENCODED_RUN_RE = new RegExp(`[A-Za-z0-9+/=_%-]{${TAINTED_QUERY_ENCODED_RUN},}`);

/** 汚染後の web_fetch で、集合にない URL を拒んだときの理由コード */
export const TAINTED_UNKNOWN_URL = "tainted_unknown_url";
/** 汚染後の web_search で、検索語の形を拒んだときの理由コード */
export const TAINTED_QUERY_SHAPE = "tainted_query_shape";

/**
 * URL の正規化（集合に入れるときと、汚染後の web_fetch で照らすときに同じ規則を使う）。
 * - WHATWG の URL として読む（ホストの小文字化・IDN・既定ポートの省略・パスの . と .. の解決・使えない文字の % 符号化はこれで揃う）
 * - http・https だけ。読めない・長すぎるものは null
 * - フラグメント（# から後）を落とす（サーバーに送られないので持ち出しの経路にならない）
 * - 括弧は %28 %29 にする（検索結果は Markdown のリンクを壊さないよう %28 %29 で見せるので、どちらで来ても同じにする）
 * - クエリは並び・大文字小文字・符号化を含めてそのまま（書き換えたクエリは別の URL として扱う）
 */
export function normalizeWebUrl(raw: string): string | null {
  const s = raw.trim();
  if (s === "" || s.length > SEEN_URL_MAX_CHARS) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  const href = u.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  return href.length > SEEN_URL_MAX_CHARS ? null : href;
}

/** 正規化した URL の鍵（DB に持つのはこの SHA-256 の16進だけ） */
export function seenUrlHash(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** URL の一覧を正規化して重ねを除き、見た順に limit 件まで返す */
export function normalizeWebUrls(raws: Iterable<string>, limit: number = SEEN_URLS_MAX_PER_PAGE): string[] {
  const out = new Set<string>();
  for (const raw of raws) {
    if (out.size >= limit) break;
    const n = normalizeWebUrl(raw);
    if (n !== null) out.add(n);
  }
  return [...out];
}

/** 本文の中の http(s) の URL（ASCII の範囲。空白・引用符・山括弧・全角の文字で切る） */
const TEXT_URL_RE = /https?:\/\/[^\s<>"'`\u0080-￿]+/g;
/** URL の後ろに付きやすい句読点（本文の「…を見てください（https://a.example/x）。」の閉じ括弧など） */
const TRAILING_PUNCT_RE = /[.,;:!?)\]}]+$/;

/**
 * 本文に書かれた URL（ページの文字・検索の抜粋）。末尾の句読点を落としたものも足す
 * （どちらもページの中にそのままある文字列。LLM がどちらで写しても辿れるようにする）
 */
export function urlsInText(text: string, limit: number = SEEN_URLS_MAX_PER_PAGE): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TEXT_URL_RE)) {
    if (out.length >= limit) break;
    const raw = m[0];
    out.push(raw);
    const trimmed = raw.replace(TRAILING_PUNCT_RE, "");
    if (trimmed !== raw && trimmed.length > "https://".length) out.push(trimmed);
  }
  return out;
}

/**
 * 利用者自身が書いた文（依頼の文・返事の文）に含まれる URL の鍵。タスクを作るときに見た URL の集合へ最初に入れる（db の insertAskTask）。
 * 利用者が渡した URL は LLM が組み立てたものではないので、MCP の読み取りなどで汚染されたあとも辿れるようにする。
 * 担当の指示（プランナーの LLM が書いたもの）・前の段の報告・連絡板の文はここに渡さない（呼ぶ側の責任）
 */
export function userTextWebUrlHashes(texts: ReadonlyArray<string | null | undefined>): string[] {
  const raws = texts.flatMap((t) => (typeof t === "string" ? urlsInText(t) : []));
  return normalizeWebUrls(raws, SEEN_URLS_MAX_PER_PAGE).map(seenUrlHash);
}

/**
 * submit_report の next_actions のうち、残してよいもの（SG-04）。汚染されたタスクの提案からは、URL を含むもの（urlsInText で見つかるもの）を落とす。
 * 提案は回答の「次はこれをしましょうか？」のボタンになり、押すとその文がそのまま利用者の返事として送られるため。汚染されていなければそのまま
 */
export function nextActionsForReport(actions: readonly string[], tainted: boolean): string[] {
  return tainted ? actions.filter((a) => urlsInText(a, 1).length === 0) : [...actions];
}

/**
 * 返事の文の URL の鍵（SG-04）。返事が直前の回答の提案（next_actions）のどれかと同じ文なら、ボタンで送られた担当の文なので何も入れない。
 * 利用者が提案を書き足して送ったときも、提案に出てくる URL は入れない（担当が書いた URL を利用者の文として扱わない）
 */
export function replyWebUrlHashes(reply: string | null | undefined, suggestions: readonly string[]): string[] {
  if (typeof reply !== "string") return [];
  const same = (a: string): string => a.replace(/\s+/g, " ").trim();
  if (suggestions.some((sg) => same(sg) === same(reply))) return [];
  const suggested = new Set(normalizeWebUrls(suggestions.flatMap((sg) => urlsInText(sg))));
  const own = normalizeWebUrls(urlsInText(reply)).filter((u) => !suggested.has(u));
  return own.map(seenUrlHash);
}

/** 汚染後の検索語の形が許されるか（長さと、符号化した断片に見える連続） */
export function taintedQueryShapeOk(query: string): boolean {
  if ([...query].length > TAINTED_QUERY_MAX_CHARS) return false;
  return !ENCODED_RUN_RE.test(query);
}
