// パックの作業場（`/packs/:packId`）の机の見た目を決める純粋な関数。
// 担当は待機中、持ち物（スキル・スクリプト）や例の依頼から作った独り言を数秒おきに交代で話し、
// 頼まれたらすぐに反応の文を返して動き出す。本当の状態（動いています・確認待ち）が分かれば、それを優先して出す
import type { AgentActivityState } from "../api";
import type { AvatarMood } from "./avatar";
import { hashOf } from "./avatar";
import type { GenPhase } from "./generation";

/** 独り言を交代する間隔（動きを減らす設定では交代しない） */
export const MUSING_MS = 6_000;

export interface DeskAgent {
  name: string;
  summary: string;
  template: string;
  skills: string[];
  files: string[];
}

/** 長い文を n 文字で切る（吹き出しに収める） */
export function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  const chars = [...t];
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : t;
}

/** パスの最後の名前（samples/answers.csv → answers.csv） */
function baseName(path: string): string {
  return path.split("/").filter((s) => s !== "").pop() ?? path;
}

const SCRIPT_RE = /\.(py|js|mjs|ts|sh)$/;

/** 担当の型ごとの、手が空いたときの独り言（どの担当にも足りないときの埋め草） */
const IDLE_LINES: Readonly<Record<string, readonly string[]>> = {
  researcher: ["調べる先の当たりを付けています", "メモを読み返しています…"],
  briefer: ["言い回しを練っています…", "見出しの案を並べています"],
  watcher: ["見回りをしています", "変わったことがないか見ています"],
  assistant: ["机の上を片付けています", "頼まれごとを待っています"],
  "dev-coder": ["道具の手入れをしています", "作業場を整えています"],
  reviewer: ["見直しの目のつけどころを確かめています", "前の指摘を読み返しています"],
};
const GENERIC_LINES = ["段取りを考えています…", "ひと息ついています", "次の仕事を待っています"];

/**
 * 独り言の候補（重なりなし・最低 3 つ）。スキル → スクリプト・ファイル → 例の依頼 → 型ごとの文 → 埋め草の順。
 * 例の依頼は担当ごとに名前で回して、全員が同じ例を言わないようにする
 */
export function musingsOf(agent: DeskAgent, examples: readonly string[]): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (s !== "" && !out.includes(s)) out.push(s);
  };
  for (const skill of agent.skills) add(`『${clip(skill, 16)}』を読み返しています`);
  const files = [...agent.files].sort((a, b) => Number(SCRIPT_RE.test(b)) - Number(SCRIPT_RE.test(a)));
  for (const f of files.slice(0, 3)) add(SCRIPT_RE.test(f) ? `${baseName(f)} を確かめています` : `${baseName(f)} を眺めています`);
  if (examples.length > 0) {
    const start = hashOf(agent.name) % examples.length;
    for (let i = 0; i < Math.min(2, examples.length); i++) {
      const ex = examples[(start + i) % examples.length];
      // 例の依頼に「」が入っていると入れ子になるので、内側は『』にする
      if (ex !== undefined) add(`次の「${clip(ex.replace(/「/g, "『").replace(/」/g, "』"), 14)}」に備えています`);
    }
  }
  if (agent.summary.trim() !== "") add(`「${clip(agent.summary, 14)}」の段取りを考えています…`);
  for (const s of IDLE_LINES[agent.template] ?? []) add(s);
  for (const s of GENERIC_LINES) {
    if (out.length >= 3) break;
    add(s);
  }
  return out;
}

/** tick 番目に話す独り言（担当ごとに出だしをずらす） */
export function musingAt(musings: readonly string[], name: string, tick: number): string | null {
  if (musings.length === 0) return null;
  return musings[(hashOf(name) + Math.max(0, Math.floor(tick))) % musings.length] ?? null;
}

/**
 * tick 番目に話す担当（1〜max 人）。名前のハッシュで決めた順に、tick ごとに1人ずつずらして交代する（決定論）。
 * 何人話すかも tick で決める（いつも全員が話すとにぎやかすぎる）
 */
export function pickSpeakers(names: readonly string[], tick: number, max = 2): string[] {
  const uniq = [...new Set(names)];
  if (uniq.length === 0 || max <= 0) return [];
  const order = uniq.sort((a, b) => hashOf(a) - hashOf(b) || (a < b ? -1 : 1));
  const t = Math.max(0, Math.floor(tick));
  const count = Math.min(max, order.length, hashOf(`tick:${t}`) % 2 === 0 ? 1 : 2);
  const start = t % order.length;
  return Array.from({ length: count }, (_, i) => order[(start + i) % order.length]!);
}

/** 頼まれた瞬間の反応（担当の型ごとに数パターン） */
const REACTIONS: Readonly<Record<string, readonly string[]>> = {
  researcher: ["調べます！", "当たってみます", "見ます！", "資料を集めます"],
  briefer: ["まとめます！", "書きます！", "はい、任せて！", "文面を考えます"],
  watcher: ["見張ります！", "目を光らせます", "見ます！"],
  assistant: ["はい、任せて！", "手伝います！", "段取りします", "やります！"],
  "dev-coder": ["作ります！", "手を動かします", "段取りします", "はい、任せて！"],
  reviewer: ["見直します！", "確かめます", "目を通します"],
};
const GENERIC_REACTIONS = ["はい、任せて！", "見ます！", "段取りします"];

export function reactionOf(template: string, seed: number): string {
  const list = REACTIONS[template] ?? GENERIC_REACTIONS;
  const i = Math.abs(Math.floor(seed)) % list.length;
  return list[i] ?? GENERIC_REACTIONS[0]!;
}

/** 吹き出しの種類（ambient と reaction は飾りなので読み上げない） */
export type BubbleKind = "guide" | "ambient" | "reaction" | "status" | "joined" | "none";

export interface DeskState {
  mood: AvatarMood;
  bubble: string | null;
  kind: BubbleKind;
  /** 机を光らせる（この依頼に入った） */
  glow: boolean;
}

export interface DeskInput {
  /** パックを入れてあるか */
  installed: boolean;
  /** ライブラリでのいまの様子（見つからないときは null＝待機中とみなす） */
  activity: AgentActivityState | null;
  /** 動いている・確認待ちのときに添える依頼の文 */
  askText: string | null;
  /** この作業場から頼んだ依頼の生成の段階 */
  phase: GenPhase;
  /** 編成ができて、この担当が入った */
  joined: boolean;
  /** 送った瞬間の反応の文 */
  reaction: string;
  /** いま話す独り言（話さない tick は null） */
  musing: string | null;
}

/**
 * 机の表示状態。優先：入れていない → 止めた → 生成中（反応）→ 動いている・確認待ち（編成に入った机は光ったまま）→ 編成に入った → 待機（独り言）
 */
export function deskStateOf(d: DeskInput): DeskState {
  if (!d.installed) return { mood: "waiting", bubble: "この作業場に来るエージェントです", kind: "guide", glow: false };
  if (d.activity === "disabled") return { mood: "stopped", bubble: "止めています", kind: "status", glow: false };
  if (d.phase === "generating") return { mood: "running", bubble: d.reaction, kind: "reaction", glow: false };
  if (d.phase === "question") return { mood: "approval", bubble: "ひとつ聞かせてください", kind: "reaction", glow: false };
  const glow = d.phase === "shown" && d.joined;
  const withAsk = (head: string) => (d.askText ? `${head}：${clip(d.askText, 24)}` : head);
  if (d.activity === "running") return { mood: "running", bubble: withAsk("動いています"), kind: "status", glow };
  if (d.activity === "awaiting_approval") return { mood: "approval", bubble: withAsk("確認待ちです"), kind: "status", glow };
  if (glow) return { mood: "running", bubble: "この依頼に入りました", kind: "joined", glow: true };
  if (d.musing) return { mood: "idle", bubble: d.musing, kind: "ambient", glow: false };
  return { mood: "idle", bubble: null, kind: "none", glow: false };
}

/** 独り言を話してよい机か（入れてあり、待機中で、この作業場の依頼が生成中でも編成に入ってもいない） */
export function canMuse(d: Pick<DeskInput, "installed" | "activity" | "phase" | "joined">): boolean {
  if (!d.installed) return false;
  if (d.activity !== null && d.activity !== "idle") return false;
  if (d.phase === "generating" || d.phase === "question") return false;
  return !(d.phase === "shown" && d.joined);
}

export interface MemberLike {
  key: string;
  agentName: string;
  summary: string;
  isNew: boolean;
  /** 編成の事象（ask.formed）から分かれば */
  agentId?: string | null;
}

export interface Helper {
  key: string;
  agentName: string;
  summary: string;
  isNew: boolean;
}

/**
 * 編成の担当を、作業場の机（パックの担当）と応援（それ以外）に分ける。
 * agentId が両方に分かれば ID で、分からなければ名前で当てる（新しく作った担当は机に当てない）。
 * joined は机の名前 → その依頼ですること
 */
export function matchMembers(members: readonly MemberLike[], desks: ReadonlyArray<{ name: string; agentId: string | null }>): { joined: Record<string, string>; helpers: Helper[] } {
  const joined: Record<string, string> = {};
  const helpers: Helper[] = [];
  for (const m of members) {
    const desk = m.isNew
      ? undefined
      : desks.find((d) => (d.agentId !== null && m.agentId != null ? d.agentId === m.agentId : d.name === m.agentName));
    if (desk && !Object.hasOwn(joined, desk.name)) joined[desk.name] = m.summary;
    else helpers.push({ key: m.key, agentName: m.agentName, summary: m.summary, isNew: m.isNew });
  }
  return { joined, helpers };
}
