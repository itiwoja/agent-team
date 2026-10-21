// SCR-020 の生成中の状態（畳み込み）。依頼を作る（API-072）と、SSE の ask.*（と、取りこぼしに備えた GET /asks/:id）から
// 画面の状態を決める。時間（10 秒・30 秒・見せ終わり）はフックが timer で dispatch する。
import type { AskDetail, AskEvent, AskQuestionView, AskSummary, FormationView } from "../api";
import { shapeLineOf } from "./shape";

export const SLOW_MS = 10_000; // 「まだ考えています」
export const GIVE_UP_MS = 30_000; // 打ち切り（A-98）
export const SHOW_MS = 3_000; // 作り終えた編成を見せる時間（A-97。パックの作業場など、その場に残る画面向け）
/** 入口・頼むシート：担当が生まれ終わってから依頼のページへ移るまでの、読む間 */
export const ENTER_ASK_HOLD_MS = 2_000;
export const DEFAULT_FAILURE = "うまく決められませんでした。言い方を変えてみてください";
/** 30 秒の打ち切り。依頼の言い方のせいではない（Gemini の混雑）ので、言い方を変えるよう促さない（サーバーの timeout と同じ文） */
export const TIMEOUT_FAILURE = "Gemini が混み合っていて、時間内に決められませんでした。もう一度送ってください";

export type GenPhase = "idle" | "generating" | "question" | "shown" | "failed";

export interface GenMember {
  key: string;
  /** その担当がすること（1行目） */
  summary: string;
  agentName: string;
  isNew: boolean;
}

export interface GenState {
  phase: GenPhase;
  askId: string | null;
  /** 送った文（失敗したとき入力欄に戻す） */
  sentText: string;
  members: GenMember[];
  shapeLine: string | null;
  question: AskQuestionView | null;
  /** failed のときの1行 */
  message: string | null;
  /** 10 秒を超えた */
  slow: boolean;
  /** 依頼の ID が分かる前に届いた事象（受け取ってから流し直す） */
  early: AskEvent[];
}

export const initialGen: GenState = { phase: "idle", askId: null, sentText: "", members: [], shapeLine: null, question: null, message: null, slow: false, early: [] };

export type GenAction =
  | { type: "submit"; text: string }
  | { type: "accepted"; ask: AskSummary }
  | { type: "event"; event: AskEvent }
  | { type: "detail"; detail: AskDetail }
  | { type: "answered" }
  | { type: "slow" }
  | { type: "timeout" }
  | { type: "error"; message: string }
  | { type: "reset" };

/** 生成に関わる ask.* の事象の名前（契約にはほかに ask.answered・ask.answer.updated・ask.message.posted があるが、入口では使わない） */
const GENERATION_EVENT_TYPES: ReadonlySet<string> = new Set<AskEvent["type"]>(["ask.created", "ask.question", "ask.formed", "ask.failed", "ask.status"]);

/** SSE の ask.* のうち、生成の畳み込みに通してよい事象か（F-045：関係ない事象を reducer に入れない） */
export function isGenerationEvent(e: { type: string; askId?: unknown }): e is AskEvent {
  return GENERATION_EVENT_TYPES.has(e.type) && typeof e.askId === "string";
}

/**
 * 打ち切り（30 秒）のあと、依頼の ID が分かっていれば GET /asks/:id を1回だけ確かめる。
 * サーバーは打ち切りの後も依頼を作り続けることがあるので、作られていれば依頼の ID を返し（そのページへ進む）、
 * 分からない・確かめられなかったときは null（従来どおり失敗にする）
 */
export async function askCreatedAfterGiveUp(askId: string | null, fetchAsk: (id: string) => Promise<unknown>): Promise<string | null> {
  if (askId === null) return null;
  try {
    await fetchAsk(askId);
    return askId;
  } catch {
    return null;
  }
}

/**
 * 入口・頼むシート：編成ができてから依頼のページへ移るまで。担当は 0.35 秒ずつずれて生まれ、最後に編成の1行が出る
 * （entrance.css の gen-in 0.4s・avatar.css の av-pop）。出そろうのを待ってから、読む間（ENTER_ASK_HOLD_MS）を足す
 */
export function enterAskDelay(memberCount: number): number {
  return memberCount * 350 + 400 + ENTER_ASK_HOLD_MS;
}

function membersOf(f: FormationView): GenMember[] {
  return [...f.members]
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))
    .map((m) => ({ key: m.memberId, summary: m.summary, agentName: m.agentName, isNew: m.isNew }));
}

function shown(s: GenState, f: FormationView): GenState {
  const line = f.shapeLine ?? shapeLineOf(f.shape, f.members);
  return { ...s, phase: "shown", members: membersOf(f), shapeLine: line, question: null, slow: false };
}

function failed(s: GenState, message: string | null): GenState {
  return { ...s, phase: "failed", message: message ?? DEFAULT_FAILURE, question: null, slow: false };
}

/** 生成中・質問のときだけ進む（見せている・失敗のあとの事象は無視） */
const live = (s: GenState): boolean => s.phase === "generating" || s.phase === "question";

function applyEvent(s: GenState, e: AskEvent): GenState {
  if (s.askId !== null && e.askId !== s.askId) return s;
  if (!live(s)) return s;
  switch (e.type) {
    case "ask.question":
      return { ...s, phase: "question", question: e.question, slow: false };
    case "ask.formed":
      return shown(s, e.formation);
    case "ask.failed":
      return failed(s, e.message);
    case "ask.status":
      return e.status === "failed" ? failed(s, null) : s;
    case "ask.created":
      return s;
    default:
      // 契約にあって生成に関わらない事象（ask.answered など）が届いても状態を壊さない
      return s;
  }
}

export function generationReducer(s: GenState, a: GenAction): GenState {
  switch (a.type) {
    case "submit":
      return { ...initialGen, phase: "generating", sentText: a.text };
    case "accepted": {
      if (s.phase === "idle") return s;
      let next: GenState = { ...s, askId: a.ask.id, early: [] };
      // 返事の前に届いていた事象を流し直す
      for (const e of s.early) next = applyEvent(next, e);
      if (a.ask.status === "failed") return failed(next, a.ask.failure?.message ?? null);
      if (a.ask.question && next.phase === "generating") next = { ...next, phase: "question", question: a.ask.question };
      return next;
    }
    case "event":
      if (s.askId === null) return live(s) ? { ...s, early: [...s.early, a.event] } : s;
      return applyEvent(s, a.event);
    case "detail": {
      if (s.askId !== a.detail.ask.id || !live(s)) return s;
      const { ask, formation } = a.detail;
      if (ask.status === "failed") return failed(s, ask.failure?.message ?? null);
      if (formation && ask.status !== "generating") return shown(s, formation);
      if (ask.question && ask.status === "generating" && s.phase === "generating") return { ...s, phase: "question", question: ask.question, slow: false };
      return s;
    }
    case "answered":
      return s.phase === "question" ? { ...s, phase: "generating", question: null } : s;
    case "slow":
      return s.phase === "generating" ? { ...s, slow: true } : s;
    case "timeout":
      return live(s) ? failed(s, TIMEOUT_FAILURE) : s;
    case "error":
      return live(s) ? failed(s, a.message) : s;
    case "reset":
      return initialGen;
  }
}
