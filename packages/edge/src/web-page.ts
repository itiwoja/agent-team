// web_fetch の取得（edge の中だけ）。届けてよい先かを確かめてから取りに行く：
// - http・https の既定のポートだけ。URL に利用者名・パスワードがあれば取らない
// - ドメイン：付与（allow_domains。"*" はすべて）に入り、拒否（deny_domains）に入らないこと。転送のたびに確かめ直す
// - 名前解決した IP がプライベート・ループバック・リンクローカル（メタデータサーバー 169.254.169.254 など）なら繋がない（SSRF）。
//   解決は接続のときの lookup で確かめる（確かめたあとに名前の向き先を替えられても、繋ぐ先は確かめた IP）
// - 本文は MAX_DOWNLOAD_BYTES で打ち切り、HTML は文字だけにする

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/** 取りに行く本文の上限（超えた分は読まない） */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
/** HTML を文字にするときの入力の上限（バイト・文字とも。超えた分は見ない） */
export const TEXT_MAX_BYTES = 512 * 1024;
/** 1回の取得の待ち時間の上限 */
export const FETCH_TIMEOUT_MS = 15_000;
/** 転送をたどる回数の上限 */
export const MAX_REDIRECTS = 5;

export interface FetchedPage {
  /** 最後にたどり着いた URL */
  url: string;
  status: number;
  contentType: string;
  title: string | null;
  /** 文字にした本文（HTML はタグを除いたもの） */
  text: string;
  /** ページの中のリンク（HTML の a・area の href を最後の URL で絶対にしたもの。SG-04 の「見た URL の集合」に入れる） */
  links?: readonly PageLink[];
}

/** ページの中のリンク（題は a の中の文字。なければ空） */
export interface PageLink {
  url: string;
  text: string;
}

/** 1ページから拾うリンクの上限（web-seen.ts の SEEN_URLS_MAX_PER_PAGE と同じ量） */
export const MAX_PAGE_LINKS = 500;

/** 取れなかった理由（エージェントに返すコード） */
export class WebFetchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WebFetchError";
    this.code = code;
  }
}

export interface DomainPolicy {
  allow: readonly string[];
  deny: readonly string[];
}

/** 取得の差し替え（試験用）。既定は fetchPage */
export type PageFetcher = (url: string, domains: DomainPolicy, signal?: AbortSignal) => Promise<FetchedPage>;

/**
 * ホストがドメインの型に当たるか。"*" はすべて、"*.example.com" はその下のホストだけ、
 * "example.com" はそのホストとその下のホスト
 */
export function domainMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const p = pattern.trim().toLowerCase().replace(/\.$/, "");
  if (p === "") return false;
  if (p === "*") return true;
  if (p.startsWith("*.")) return h.endsWith(p.slice(1));
  return h === p || h.endsWith(`.${p}`);
}

/** 付与に入り、拒否に入らないか（拒否が勝つ） */
export function hostAllowed(host: string, domains: DomainPolicy): boolean {
  if (domains.deny.some((d) => domainMatches(host, d))) return false;
  return domains.allow.some((d) => domainMatches(host, d));
}

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

/** 16ビットの2つから IPv4 の文字列を作る */
function ipv4Of(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** IPv6 を16ビットの8つの数にする（末尾の a.b.c.d は2つの数にする）。読めなければ null */
function hextetsOf(ip: string): number[] | null {
  let s = ip;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail !== null) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const rest = halves.length === 2 && halves[1] !== "" ? halves[1]!.split(":") : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + rest.length > 7) return null;
  const zeros = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const nums = [...head, ...Array<string>(zeros).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null;
}

/** 公開されたインターネットの IP でなければ true（IPv4 を写した IPv6 も IPv4 として見る） */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return BLOCKED.check(ip, "ipv4");
  if (family !== 6) return true;
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1] !== undefined) return BLOCKED.check(mapped[1], "ipv4");
  // ::ffff:7f00:1 の形（16進）
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped?.[1] !== undefined && hexMapped[2] !== undefined) {
    return BLOCKED.check(ipv4Of(parseInt(hexMapped[1], 16), parseInt(hexMapped[2], 16)), "ipv4");
  }
  if (lower.startsWith("::ffff:")) return true;
  const h = hextetsOf(lower);
  if (h === null) return true;
  // IPv4 互換（::/96）と 6to4（2002::/16）は、埋め込まれた IPv4 を取り出して IPv4 の一覧で見る
  if (h.slice(0, 6).every((x) => x === 0)) return BLOCKED.check(ipv4Of(h[6]!, h[7]!), "ipv4");
  if (h[0] === 0x2002) return BLOCKED.check(ipv4Of(h[1]!, h[2]!), "ipv4");
  return BLOCKED.check(ip, "ipv6");
}

/** 名前解決の結果に公開でない IP が1つでもあれば繋がない */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedIp(a.address))) {
      return callback(Object.assign(new Error(`内部のアドレスには繋ぎません：${hostname}`), { code: "WEB_BLOCKED_ADDRESS" }), "", 0);
    }
    if (options.all === true) return callback(null, list);
    const first = list[0]!;
    callback(null, first.address, first.family);
  });
};

/** Gemini の Google 検索 Grounding の転送（出典の URL がここを経由する）に使うホスト（最初の1歩だけ、ドメインの付与にかかわらず通す。転送先は checkUrl で確かめ直す） */
export const TRANSIT_HOST = "vertexaisearch.cloud.google.com";

/** 取りに行ってよい URL か（スキーム・利用者情報・ポート・ドメイン・IP の直書き）。allowTransit は最初の1歩だけ true */
export function checkUrl(raw: string, domains: DomainPolicy, allowTransit = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebFetchError("WEB_INVALID_URL", "URL として読めません");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new WebFetchError("WEB_INVALID_URL", "http・https だけ取れます");
  if (url.username !== "" || url.password !== "") throw new WebFetchError("WEB_INVALID_URL", "利用者名・パスワードの入った URL は取りません");
  if (url.port !== "") throw new WebFetchError("WEB_INVALID_URL", "既定でないポートは取りません");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) throw new WebFetchError("WEB_BLOCKED_ADDRESS", "内部のアドレスには繋ぎません");
  }
  if (domains.deny.some((d) => domainMatches(host, d))) throw new WebFetchError("WEB_DOMAIN_NOT_ALLOWED", `${host} は取得を許されていません`);
  if (allowTransit && host === TRANSIT_HOST) return url;
  if (!hostAllowed(host, domains)) throw new WebFetchError("WEB_DOMAIN_NOT_ALLOWED", `${host} は取得を許されていません`);
  return url;
}

/** 1回の GET（転送はたどらない）。本文は MAX_DOWNLOAD_BYTES まで */
function getOnce(url: URL, signal: AbortSignal): Promise<{ res: IncomingMessage; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        lookup: guardedLookup,
        signal,
        headers: {
          "user-agent": "MakaseAgent/1.0",
          accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
          "accept-language": "ja,en;q=0.8",
          "accept-encoding": "identity",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (size >= MAX_DOWNLOAD_BYTES) return;
          const room = MAX_DOWNLOAD_BYTES - size;
          const part = c.length > room ? c.subarray(0, room) : c;
          chunks.push(part);
          size += part.length;
          if (size >= MAX_DOWNLOAD_BYTES) {
            resolve({ res, body: Buffer.concat(chunks) });
            res.destroy();
          }
        });
        res.on("end", () => resolve({ res, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** URL を取りに行き、文字にして返す（転送は MAX_REDIRECTS 回まで、そのたびに checkUrl） */
export const fetchPage: PageFetcher = async (raw, domains, signal) => {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let url = checkUrl(raw, domains, true);
  for (let hop = 0; ; hop++) {
    let got;
    try {
      got = await getOnce(url, combined);
    } catch (e) {
      if (timeout.aborted) throw new WebFetchError("WEB_TIMEOUT", "時間内に返りませんでした");
      if (signal?.aborted) throw new WebFetchError("WEB_ABORTED", "中断しました");
      const code = (e as { code?: unknown }).code;
      if (code === "WEB_BLOCKED_ADDRESS") throw new WebFetchError("WEB_BLOCKED_ADDRESS", "内部のアドレスには繋ぎません");
      throw new WebFetchError("WEB_UNREACHABLE", "繋がりませんでした");
    }
    const { res, body } = got;
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (!transitResponseIsRedirect(url, status, location)) throw new WebFetchError("WEB_DOMAIN_NOT_ALLOWED", `${TRANSIT_HOST} は転送以外に使えません`);
    if (status >= 300 && status < 400 && typeof location === "string") {
      if (hop >= MAX_REDIRECTS) throw new WebFetchError("WEB_TOO_MANY_REDIRECTS", "転送が多すぎます");
      url = checkUrl(new URL(location, url).toString(), domains);
      continue;
    }
    const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
    if (status >= 400) throw new WebFetchError(`WEB_HTTP_${status}`, `HTTP ${status}`);
    if (!isTextual(contentType)) throw new WebFetchError("WEB_NOT_TEXT", "文字のページではありません");
    // HTML は文字にする前に TEXT_MAX_BYTES で切る（タグを探す走査の量を抑える）
    const isHtmlType = contentType.includes("html");
    const decoded = decodeBody(isHtmlType ? body.subarray(0, TEXT_MAX_BYTES) : body, contentType);
    const html = isHtmlType || (contentType === "" && /<html[\s>]/i.test(decoded.slice(0, 2000)));
    return {
      url: url.toString(),
      status,
      contentType,
      title: html ? titleOf(decoded) : null,
      text: html ? htmlToText(decoded) : decoded.trim(),
      ...(html ? { links: linksOf(decoded, url) } : {}),
    };
  }
};

/** 転送用ホストから受け入れるのは Location を持つリダイレクト応答だけ */
export function transitResponseIsRedirect(url: URL, status: number, location: string | string[] | undefined): boolean {
  return url.hostname.toLowerCase() !== TRANSIT_HOST || (status >= 300 && status < 400 && typeof location === "string");
}

function isTextual(contentType: string): boolean {
  if (contentType === "") return true;
  return /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json))/.test(contentType);
}

function decodeBody(body: Buffer, contentType: string): string {
  const charset = /charset=([^;]+)/.exec(contentType)?.[1]?.trim().replace(/^"|"$/g, "") ?? sniffCharset(body);
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/** HTML の meta の charset（先頭 2KB だけ見る） */
function sniffCharset(body: Buffer): string | undefined {
  const head = body.subarray(0, 2048).toString("latin1");
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
}

/** 入力を上限で切る */
function clipHtml(html: string): string {
  return html.length > TEXT_MAX_BYTES ? html.slice(0, TEXT_MAX_BYTES) : html;
}

/** 中身ごと除く要素（名前は小文字で比べる） */
const SKIP_OPEN = /<(script|style|noscript|template|svg|iframe|head)(?=[\s/>])/iy;
const SKIP_CLOSE: ReadonlyMap<string, RegExp> = new Map(
  ["script", "style", "noscript", "template", "svg", "iframe", "head"].map((n) => [n, new RegExp(`</${n}\\s*>`, "gi")]),
);
/** ブロックの区切りになるタグ（改行にする） */
const BLOCK_OPEN = /<\/?(p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|footer|nav|main|aside|blockquote|pre|dd|dt|hr)(?=[\s/>])/iy;

/** タグ開始から、引用符の外にある > までを線形走査で探す。閉じていない引用符は -1 */
function tagEnd(src: string, start: number): number | null {
  let quote = "";
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return quote === "" ? null : -1;
}

/**
 * タグと注釈を除いて文字にする（1回の左から右への走査で、入力の長さに比例する時間）。
 * 閉じのない注釈・中身ごと除く要素は、その先を捨てる。閉じのない "<" と "<>" は文字のまま残す
 */
function stripTags(src: string): string {
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const lt = src.indexOf("<", pos);
    if (lt === -1) {
      out.push(src.slice(pos));
      break;
    }
    out.push(src.slice(pos, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end === -1) break;
      pos = end + 3;
      continue;
    }
    SKIP_OPEN.lastIndex = lt;
    const skip = SKIP_OPEN.exec(src);
    if (skip !== null) {
      const close = SKIP_CLOSE.get(skip[1]!.toLowerCase())!;
      close.lastIndex = lt + skip[0].length;
      if (close.exec(src) === null) break;
      pos = close.lastIndex;
      continue;
    }
    const gt = tagEnd(src, lt + 1);
    if (gt === -1) break;
    if (gt === null) {
      out.push(src.slice(lt));
      break;
    }
    if (gt === lt + 1) {
      out.push("<");
      pos = lt + 1;
      continue;
    }
    BLOCK_OPEN.lastIndex = lt;
    out.push(BLOCK_OPEN.test(src) ? "\n" : "");
    pos = gt + 1;
  }
  return out.join("");
}

const TITLE_OPEN = /<title/i;
const TITLE_CLOSE = /<\/title>/gi;

export function titleOf(html: string): string | null {
  const src = clipHtml(html);
  const open = TITLE_OPEN.exec(src);
  if (open === null) return null;
  const gt = tagEnd(src, open.index + "<title".length);
  if (gt === null) return null;
  TITLE_CLOSE.lastIndex = gt + 1;
  const close = TITLE_CLOSE.exec(src);
  if (close === null) return null;
  const t = decodeEntities(src.slice(gt + 1, close.index)).replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
}

const LINK_OPEN = /<(?:a|area)(?=[\s/>])/gi;
const HREF_ATTR = /(?:^|[\s"'/])href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const LINK_CLOSE = /<\/a\s*>/i;
/** リンクの題として見る a の中身の長さ（文字。閉じタグを探す範囲も兼ねる） */
const LINK_TEXT_SCAN = 400;

/**
 * HTML の中のリンク（a・area の href）。base（最後の URL）で絶対にし、http・https だけを、出てきた順に MAX_PAGE_LINKS 件まで。
 * タグの終わりは引用符を見て線形に探す（stripTags と同じ）。base 要素は見ない（辿れる先が増えない側）
 */
export function linksOf(html: string, base: URL): PageLink[] {
  const src = clipHtml(html);
  const out: PageLink[] = [];
  const seen = new Set<string>();
  LINK_OPEN.lastIndex = 0;
  for (let m = LINK_OPEN.exec(src); m !== null && out.length < MAX_PAGE_LINKS; m = LINK_OPEN.exec(src)) {
    const gt = tagEnd(src, m.index + m[0].length);
    if (gt === null || gt === -1) break;
    LINK_OPEN.lastIndex = gt + 1;
    const attr = HREF_ATTR.exec(src.slice(m.index + m[0].length, gt));
    const rawHref = attr?.[1] ?? attr?.[2] ?? attr?.[3];
    if (rawHref === undefined) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(rawHref).trim(), base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const href = url.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    // 題は a の中の文字だけ（area は閉じタグがないので空）。次の a が先に始まったら閉じ忘れとみて空にする
    let text = "";
    if (m[0].length === 2) {
      const inner = src.slice(gt + 1, gt + 1 + LINK_TEXT_SCAN);
      const close = LINK_CLOSE.exec(inner);
      const nextOpen = inner.search(/<(?:a|area)(?=[\s/>])/i);
      if (close !== null && (nextOpen === -1 || nextOpen > close.index)) {
        text = htmlToText(inner.slice(0, close.index)).replace(/\s+/g, " ").trim();
      }
    }
    out.push({ url: href, text });
  }
  return out;
}

/** HTML を文字にする（script・style などを除き、ブロックの区切りを改行にする） */
export function htmlToText(html: string): string {
  const text = stripTags(clipHtml(html));
  return decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/[ \t 　]+/g, " ").trim())
    .filter((l) => l !== "")
    .join("\n");
}

const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", yen: "¥", hellip: "…", mdash: "—", ndash: "–" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return NAMED[e.toLowerCase()] ?? all;
  });
}
