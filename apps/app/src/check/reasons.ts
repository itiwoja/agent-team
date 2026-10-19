// SCR-019 の行の文言（BR-70、D-59）。1行目・2行目・開いた状態の理由は reasonCode などから **決まった文** で作る。
// LLM に書かせない（読ませたいものを LLM が言い換えないように）。知らないツール・理由には、事実だけの汎用の文を使う

import type { DecisionDetail, DirectTaintSource, JsonObject, TaintSource, TaintState } from "@open-team/kernel";
import { SHOP_BASELINE } from "@open-team/sim-core";
import { KNOWN_CONNECTORS } from "../connectors/known.ts";
import { isProtectedBranch } from "@open-team/github-core";
import type { CalendarCard, GithubCard, OpenReason, TaintSourceView } from "./contract.ts";

/** manifest のツール（'<コネクタ>.<ツール>'）。なければ null */
function manifestTool(slug: string, tool: string) {
  return KNOWN_CONNECTORS.find((c) => c.slug === slug)?.tools.find((t) => t.name === tool) ?? null;
}

/** 'mcp.supplier.place_order' → { slug: 'supplier', tool: 'place_order' }。形が違えば null */
export function splitAction(action: string): { slug: string; tool: string } | null {
  const m = /^mcp\.([a-z0-9][a-z0-9-]*)\.(.+)$/.exec(action);
  return m ? { slug: m[1]!, tool: m[2]! } : null;
}

const INTENT_TITLE: Readonly<Record<string, string>> = {
  "supplier.place_order": "仕入れ先に発注を送る",
  "mail.send": "メールを送る",
  "bank.register_payee": "振込先を登録する",
  "gcal.create_event": "予定を登録する",
  "gcal.delete_event": "予定を削除する",
  "github.push_commit": "GitHub にコミットを積む",
  "github.create_pull_request": "GitHub にプルリクエストを出す",
};

/** 1行目：何を送るか */
export function intentTitle(action: string): string {
  const a = splitAction(action);
  if (a === null) return "外部に書き込む";
  const known = INTENT_TITLE[`${a.slug}.${a.tool}`];
  if (known !== undefined) return known;
  const noun = manifestTool(a.slug, a.tool)?.actionNoun;
  return noun !== undefined ? `${noun}を実行する` : `${a.tool} を実行する`;
}

/** 「発注」「メール」など（理由の文に入れる名詞）。知らなければ「書き込み」 */
export function actionNounOf(action: string): string {
  const a = splitAction(action);
  return (a !== null ? manifestTool(a.slug, a.tool)?.actionNoun : undefined) ?? "書き込み";
}

/** 'items[1].quantity' → 'items[].quantity'（manifest の units の引き方） */
const generalPath = (argPath: string): string => argPath.replace(/\[\d+\]/g, "[]");

/** ガードの引数の単位（manifest の units。なければ空） */
export function unitOf(action: string, argPath: string): string {
  const a = splitAction(action);
  const units = (a !== null ? manifestTool(a.slug, a.tool)?.units : undefined) as Readonly<Record<string, string>> | undefined;
  return units?.[generalPath(argPath)] ?? "";
}

// ---- 予定の登録（mcp.gcal.create_event）の確認カード（16 §6.5 WP-D）----

/** 時刻の表示（資格情報の時間帯。不正なら Asia/Tokyo）：「10/12(月) 15:00」 */
function zonedParts(d: Date, timeZone: string): { day: string; md: string; hm: string } | null {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("ja-JP", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  let f: Intl.DateTimeFormat;
  try {
    f = fmt(timeZone);
  } catch {
    f = fmt("Asia/Tokyo");
  }
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  if (p.year === undefined) return null;
  return { day: `${p.year}-${p.month}-${p.day}`, md: `${p.month}/${p.day}(${p.weekday})`, hm: `${p.hour}:${p.minute}` };
}

/** 開始〜終了の文（同じ日なら「10/12(月) 15:00〜16:00」、日をまたぐなら両方の日）。読めなければ null */
export function calendarWhenText(start: unknown, end: unknown, timeZone: string): string | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  const ps = zonedParts(new Date(s), timeZone);
  const pe = zonedParts(new Date(e), timeZone);
  if (ps === null || pe === null) return null;
  return ps.day === pe.day ? `${ps.md} ${ps.hm}〜${pe.hm}` : `${ps.md} ${ps.hm}〜${pe.md} ${pe.hm}`;
}

const GCAL_CREATE_ACTION = "mcp.gcal.create_event";

/** 予定の登録の確認カードの中身。ほかの操作・形が読めない引数なら null。招待は送らない（sendUpdates=none）ので、招待する人がいれば一文を足す */
export function calendarCardOf(action: string, args: Readonly<Record<string, unknown>>, timeZone: string): CalendarCard | null {
  if (action !== GCAL_CREATE_ACTION) return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
  const attendees = Array.isArray(args.attendees) ? args.attendees.filter((x): x is string => typeof x === "string") : [];
  return {
    title: str(args.title),
    when: calendarWhenText(args.start, args.end, timeZone),
    location: str(args.location),
    attendees,
    inviteNote: attendees.length > 0 ? `${attendees.length}人に招待を送らずに登録します` : null,
  };
}

const numText = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("ja-JP") : String(v));

/** 宛先の表示名（既知の仕入れ先の ID・メールアドレスだけ。分からなければ null：LLM の名前は入れない：D-31） */
export function destinationLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = SHOP_BASELINE.suppliers.find((x) => x.id === value || x.email === value);
  return s?.name ?? null;
}

/** 引数の値の表示用の文字列（文字列はそのまま、他は JSON） */
export function valueText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "（なし）";
  return JSON.stringify(v);
}

/**
 * BR-70：行を開いた状態で出す理由（4つ）。当てはまらなければ null（閉じたまま）。
 * 複数当たるときは 超過 → 前の書き込みの結果不明 → 初めての宛先 の順に1つだけ
 */
export function openReasonOf(i: {
  action: string;
  reasonCode: string;
  detail: DecisionDetail | null;
  firstDestination: boolean;
  destinationText: string | null;
}): OpenReason | null {
  const d = i.detail;
  if (i.reasonCode === "guard_exceeded" && d !== null && d.kind === "guard") {
    const unit = unitOf(i.action, d.argPath);
    const g = d.guard;
    const limit = g.max !== undefined ? `${numText(g.max)}${unit}` : g.min !== undefined ? `${numText(g.min)}${unit}` : null;
    const value = d.found && d.value !== null ? `${valueText(d.value)}${unit}` : "（値がありません）";
    const text = limit === null ? `いつもの範囲を外れています：${value}` : `いつもの上限（${limit}）を超えています：${value}`;
    return { code: "guard_exceeded", text, emphasis: value, limitText: limit };
  }
  if (i.reasonCode === "unknown_outcome_pending") {
    return { code: "unknown_outcome_pending", text: `前の${actionNounOf(i.action)}が届いたか分かっていません`, emphasis: null, limitText: null };
  }
  if (i.firstDestination) {
    return { code: "first_destination", text: "初めての送り先です", emphasis: i.destinationText, limitText: null };
  }
  return null;
}

/** ルールによる判定の決まった文（reasonCode から。「AIの要約」とは別の枠） */
export function ruleText(reasonCode: string, detail: DecisionDetail | null): string {
  switch (reasonCode) {
    case "approval_required":
      return "ルールにより、送る前に確認が必要です";
    case "guard_exceeded":
      return "上限を超えているため、確認が必要です";
    case "unknown_outcome_pending":
      return "前の書き込みの結果が分からないため、確認が必要です";
    case "certificate_missing":
      return "安全チェックがまだなので、確認が必要です";
    case "tool_needs_review":
      return "ツールの説明が変わったため、確認が必要です";
    case "rule_matched":
      return "覚えた許可に当てはまります";
    default:
      if (detail !== null && detail.kind === "rule_mismatch") return "覚えた許可の宛先と違うため、確認が必要です";
      return "ルールにより、確認が必要です";
  }
}

function directText(s: Extract<TaintSource, { kind: "mcp_read" | "web_search" | "web_fetch" | "sandbox_run" | "skill" }>): string {
  if (s.kind === "mcp_read") return `${s.connectorName}を読んだ`;
  if (s.kind === "web_search") return "Web 検索の結果を読んだ";
  if (s.kind === "sandbox_run") return "作業場でコマンドを動かした";
  // スキルの名前は DB の値なので文に入れない（SG-05）
  if (s.kind === "skill") return "運営のパックで確かめられないスキルを読んだ";
  let host = s.url;
  try {
    host = new URL(s.url).host;
  } catch {
    // 形が違う URL はそのまま出す
  }
  return `Web ページ（${host}）を読んだ`;
}

/** 受け渡し・連絡・控えの元が読んだものの短い名前 */
function upstreamText(u: DirectTaintSource): string {
  if (u.kind === "mcp_read") return u.connectorName;
  if (u.kind === "web_search") return "Web 検索の結果";
  if (u.kind === "sandbox_run") return "作業場の出力";
  if (u.kind === "skill") return "確かめられないスキル";
  return "Web ページ";
}

/** 汚染の情報源の固定の文（1つ） */
export function taintSourceText(s: TaintSource): string {
  if (s.kind === "handoff" || s.kind === "team_message" || s.kind === "workspace_snapshot") {
    const up = [...new Set(s.upstream.map(upstreamText))];
    const what = up.length > 0 ? `${up.join("・")}を読んだ` : "読んだ";
    // 作業場の控え（SG-05）：汚染されたタスクが残したファイルを受け取った
    if (s.kind === "workspace_snapshot") return `前の作業で残ったファイルを受け取った（${what}内容）`;
    return s.kind === "handoff" ? `${s.fromAgentName}が${what}内容を受け取った` : `${s.fromAgentName}から連絡を受けた（${what}内容）`;
  }
  return directText(s);
}

export function taintViews(t: TaintState): TaintSourceView[] {
  return t.sources.map((s) => ({ kind: s.kind, text: taintSourceText(s) }));
}

/** 閉じたままの行の2行目：「〇〇を読んだあとの送信です」。汚染がなければ null */
export function taintNoteOf(t: TaintState): string | null {
  if (!t.tainted || t.sources.length === 0) return null;
  const texts = [...new Set(t.sources.map(taintSourceText))];
  return `${texts.join("・")}あとの送信です`;
}

const TOOL_RUNNING: Readonly<Record<string, string>> = {
  "store.get_inventory": "在庫を確認中",
  "supplier.list_products": "商品を確認中",
  "mail.list_inbox": "受信箱を確認中",
};

/** 「やっていること」の1行の文（固定）。最後に呼んだツールが分かればそれで、なければ状態から */
export function runningText(status: string, lastTool: string | null): string {
  if (status === "queued" || status === "provisioning") return "始めるのを待っています";
  if (status === "executing") return "送っています";
  if (lastTool !== null) {
    const hit = TOOL_RUNNING[lastTool];
    if (hit !== undefined) return hit;
    const parts = lastTool.split(".");
    const noun = parts.length === 2 ? manifestTool(parts[0]!, parts[1]!)?.actionNoun : undefined;
    if (noun !== undefined) return `${noun}中`;
  }
  return "進めています";
}

/** 2行目の時刻（JST の H:mm。報告・確認の行の「担当 · 7:02」） */
export function timeText(d: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "numeric", minute: "2-digit", hour12: false }).format(d);
  return parts;
}

/** 引数の JSON から、役割ごとの引数を ArgView の元に分ける材料の型 */
export type RawArgs = JsonObject;

// ---- GitHub の書き込み（mcp.github.push_commit・create_pull_request）の確認カード（18 §3.7）----

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * GitHub の確認カード。push_commit はリポジトリ・ブランチ・書く／消すファイルのパス、create_pull_request はリポジトリ・head → base。
 * main・master への push_commit は protectedNote で必ず目立たせる（利用者が許可していても、承認の画面では言う：18 §2-5）。
 * 既定のブランチの名前は app では分からないので、ここでは main・master だけを見る（アダプターは既定のブランチも守る）
 */
export function githubCardOf(action: string, args: Readonly<Record<string, unknown>>): GithubCard | null {
  if (action === "mcp.github.push_commit") {
    const branch = str(args.branch);
    const files = Array.isArray(args.files) ? args.files.flatMap((f) => (typeof f === "object" && f !== null && typeof (f as { path?: unknown }).path === "string" ? [(f as { path: string }).path] : [])) : [];
    const deletes = Array.isArray(args.delete_paths) ? args.delete_paths.filter((p): p is string => typeof p === "string") : [];
    const protectedBranch = branch !== null && isProtectedBranch(branch, null);
    return {
      kind: "push_commit",
      repo: str(args.repo),
      branch,
      base: str(args.base),
      files,
      deletes,
      protectedNote: protectedBranch ? `「${branch}」に直接書き込みます（PR を通さずに反映されます）` : null,
    };
  }
  if (action === "mcp.github.create_pull_request") {
    return { kind: "create_pull_request", repo: str(args.repo), branch: str(args.head), base: str(args.base), files: [], deletes: [], protectedNote: null };
  }
  return null;
}
