// 回答・報告の本文（Gemini が書く Markdown の一部）を、画面に出す木に分ける。
// 扱うのは見出し・段落・箇条書き（- * 1.）・表（| と :--- の区切り行）・水平線・太字・インラインコード・リンク。
// リンクは http・https だけ。URL は見せずに題名（[題名](URL)）か、生の URL ならホスト名だけを見せ、押すと新しいタブで開く。
// それ以外の記法は文字のまま残す。
// HTML には変換しない。描画は components/Markdown.tsx が React の要素で行う。

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string };

export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; items: Array<{ depth: number; inline: Inline[] }> }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*・]\s+(.*)$/;
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** 本文を見た目の単位（ブロック）に分ける。記法のない文はそのまま1つの段落になる */
export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length === 0) return;
    blocks.push({ kind: "paragraph", inline: parseInline(para.join("\n")) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: "heading", level: h[1]!.length, inline: parseInline(h[2]!) });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && isTableRow(lines[i + 1]!)) {
      flush();
      const header = splitCells(line).map(parseInline);
      const rows: Inline[][][] = [];
      let j = i + 2;
      for (; j < lines.length && isTableRow(lines[j]!); j++) rows.push(splitCells(lines[j]!).map(parseInline));
      blocks.push({ kind: "table", header, rows });
      i = j - 1;
      continue;
    }
    const li = BULLET.exec(line) ?? ORDERED.exec(line);
    if (li) {
      flush();
      const ordered = !BULLET.test(line);
      const items: Array<{ depth: number; inline: Inline[] }> = [];
      let j = i;
      for (; j < lines.length; j++) {
        const m = ordered ? ORDERED.exec(lines[j]!) : BULLET.exec(lines[j]!);
        if (!m) break;
        items.push({ depth: Math.min(3, Math.floor(m[1]!.replace(/\t/g, "  ").length / 2)), inline: parseInline(m[2]!) });
      }
      blocks.push({ kind: "list", ordered, items });
      i = j - 1;
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.length > 1;
}

function splitCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

// 太字・コード・[題名](URL)・生の URL（URL の終わりは空白・括弧・日本語の句読点）。
// URL の中の対応の取れた括弧は1段まで許す（例：https://en.wikipedia.org/wiki/Foo_(bar)）
const INLINE = /(\*\*([^*\n]+?)\*\*|`([^`\n]+?)`|\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|(https?:\/\/(?:[^\s<>()（）「」『』、。，！？]|\([^\s<>()（）「」『』、。，！？]*\))+))/g;

/** 太字（**）・インラインコード（`）・リンクを拾う。それ以外は文字のまま */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    if (m[2] !== undefined) out.push({ kind: "strong", text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "code", text: m[3] });
    else if (m[4] !== undefined) out.push(linkOf(m[4], m[5]!) ?? { kind: "text", text: m[0] });
    else {
      // 生の URL の末尾の英語の句読点は URL に含めず文字に戻す
      const url = m[6]!.replace(/[.,;:!?]+$/, "");
      out.push(linkOf(null, url) ?? { kind: "text", text: url });
      if (url.length < m[6]!.length) out.push({ kind: "text", text: m[6]!.slice(url.length) });
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** 検索の転送の URL（Gemini の Google 検索 Grounding）。行き先のホストは分からない */
const GROUNDING_REDIRECT = "vertexaisearch.cloud.google.com";

/** リンクにする（http・https で URL として読めるものだけ）。題名がなければホスト名を見せる */
function linkOf(label: string | null, raw: string): Inline | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const text = label?.trim() || (url.hostname === GROUNDING_REDIRECT ? "出典" : url.hostname.replace(/^www\./, ""));
  return { kind: "link", text, url: url.toString() };
}
