// エージェントが生まれる全画面（components/AgentBirth.tsx）の段取り（純粋関数。タイマーや DOM は持たない）。
// 段は egg（まだ誰が生まれるか分からない。たまごが揺れる）→ hatch（名前が分かったら 1 人ずつ、たまご → ひび → 生まれる）
// → ready（そろった）→ done。次の段までの待ちは birthDelayMs が決め、呼び出す側が setTimeout で advance を送る。
// 1 人ぶんの長さは lib/ceremony.ts の HATCH_MS・READY_MS と同じにする（CSS の cer-* の動きに合わせてある）
import { HATCH_MS, READY_MS } from "./ceremony";

export type BirthPhase = "egg" | "hatch" | "ready" | "done";

export interface BirthState {
  phase: BirthPhase;
  /** 生まれた人数。hatch に入った瞬間に 1 人目が数えられ（たまごが揺れ始める）、1.1 秒ごとに増える */
  hatched: number;
  total: number;
}

export type BirthAction = { type: "named"; total: number; reducedMotion?: boolean } | { type: "advance" } | { type: "skip" };

export const initialBirth: BirthState = { phase: "egg", hatched: 0, total: 0 };

/** 名前が分かった状態で始める（チャットのように、最初から名前が分かっているとき） */
export function namedBirth(total: number, reducedMotion = false): BirthState {
  return birthReducer(initialBirth, { type: "named", total, reducedMotion });
}

export function birthReducer(state: BirthState, action: BirthAction): BirthState {
  if (state.phase === "done") return state;
  if (action.type === "skip") return state.phase === "egg" ? state : { ...state, phase: "done", hatched: state.total };
  if (action.type === "named") {
    if (state.phase !== "egg") return state;
    const total = Math.max(0, Math.floor(action.total));
    if (total === 0) return { phase: "ready", hatched: 0, total };
    // 動きを抑えるときは最初から生まれた画面（自動では閉じない）
    return action.reducedMotion ? { phase: "ready", hatched: total, total } : { phase: "hatch", hatched: 1, total };
  }
  switch (state.phase) {
    case "egg":
      return state;
    case "hatch":
      return state.hatched >= state.total ? { ...state, phase: "ready", hatched: state.total } : { ...state, hatched: state.hatched + 1 };
    case "ready":
      return { ...state, phase: "done", hatched: state.total };
  }
}

/** 次の段（または次の 1 人）に進むまでの待ち。null なら自動では進まない（egg、done、動きを抑えるとき） */
export function birthDelayMs(state: BirthState, reducedMotion: boolean): number | null {
  if (reducedMotion) return null;
  switch (state.phase) {
    case "hatch":
      return HATCH_MS;
    case "ready":
      return READY_MS;
    case "egg":
    case "done":
      return null;
  }
}

export type BirthSeat = "wait" | "hatching" | "born";

/** i 番目の席の状態。wait はたまごが待っている、hatching は今かえっている、born は生まれたあと */
export function birthSeat(state: BirthState, index: number): BirthSeat {
  if (state.phase === "hatch") {
    if (index < state.hatched - 1) return "born";
    return index === state.hatched - 1 ? "hatching" : "wait";
  }
  return state.phase === "egg" ? "wait" : "born";
}

/** 読み上げの 1 行（aria-live） */
export function birthLine(state: BirthState, names: readonly string[]): string {
  switch (state.phase) {
    case "egg":
      return "エージェントを作っています";
    case "hatch": {
      const name = names[state.hatched - 1];
      return name ? `${name}が生まれました` : "エージェントを作っています";
    }
    case "ready":
    case "done":
      return names.length === 1 ? `${names[0]}が生まれました` : "エージェントが生まれました";
  }
}

/** そろったときの見出し */
export function birthTitle(names: readonly string[]): string {
  if (names.length === 0) return "エージェントが生まれました";
  return names.length === 1 ? `${names[0]}が生まれました` : `${names.length}人のエージェントが生まれました`;
}
