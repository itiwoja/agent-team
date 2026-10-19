// パックを入れたときの「チームが生まれる」セレモニーの段取り（純粋関数。タイマーや DOM は持たない）。
// 段は prepare（作業場の明かり・机が並ぶ）→ hatch（1 人ずつ、たまご → ひび → 担当が生まれる）
// → equip（スキル・スクリプトの札が配られる）→ ready（チームがそろう）→ done。
// 次の段までの待ちは nextDelayMs が決め、呼び出す側（PackInstallCeremony）が setTimeout で advance を送る。

export type CeremonyPhase = "prepare" | "hatch" | "equip" | "ready" | "done";

export interface CeremonyState {
  phase: CeremonyPhase;
  /** 生まれた人数。hatch に入った瞬間に 1 人目が数えられ（たまごが揺れ始める）、1.1 秒ごとに増える。equip 以降は全員 */
  hatched: number;
  /** 担当の人数（reducer が「最後の 1 人か」を知るために持つ） */
  total: number;
}

export type CeremonyAction = { type: "advance" } | { type: "skip" };

/** 各段の長さ（ミリ秒） */
export const PREPARE_MS = 1200;
export const HATCH_MS = 1100;
export const EQUIP_MS = 1400;
export const READY_MS = 1800;

/** 1 人あたりに見せる札の上限（残りは「＋n」） */
export const KIT_MAX = 4;

export function initialCeremony(agentCount: number, reducedMotion = false): CeremonyState {
  const total = Math.max(0, Math.floor(agentCount));
  // 動きを抑えるときは最初から全員そろった画面（自動では閉じない）
  if (reducedMotion) return { phase: "ready", hatched: total, total };
  return { phase: "prepare", hatched: 0, total };
}

export function ceremonyReducer(state: CeremonyState, action: CeremonyAction): CeremonyState {
  if (state.phase === "done") return state;
  if (action.type === "skip") return { ...state, phase: "done", hatched: state.total };
  switch (state.phase) {
    case "prepare":
      // 担当がいなければ、たまごの段は飛ばして道具の段へ
      return state.total > 0 ? { ...state, phase: "hatch", hatched: 1 } : { ...state, phase: "equip", hatched: 0 };
    case "hatch":
      return state.hatched >= state.total ? { ...state, phase: "equip", hatched: state.total } : { ...state, hatched: state.hatched + 1 };
    case "equip":
      return { ...state, phase: "ready", hatched: state.total };
    case "ready":
      return { ...state, phase: "done", hatched: state.total };
  }
}

/** 次の段（または次の 1 人）に進むまでの待ち。null なら自動では進まない（done、動きを抑えるとき） */
export function nextDelayMs(state: CeremonyState, agentCount: number, reducedMotion: boolean): number | null {
  if (reducedMotion) return null;
  switch (state.phase) {
    case "prepare":
      return PREPARE_MS;
    case "hatch":
      // 人数を超えて数えてしまった状態では待たずに次へ
      return state.hatched <= agentCount ? HATCH_MS : 0;
    case "equip":
      return EQUIP_MS;
    case "ready":
      return READY_MS;
    case "done":
      return null;
  }
}

/** 最初から最後（done）まで自動で進んだときの合計（ミリ秒） */
export function totalMs(agentCount: number): number {
  const n = Math.max(0, Math.floor(agentCount));
  return PREPARE_MS + HATCH_MS * n + EQUIP_MS + READY_MS;
}

export type DeskStage = "wait" | "hatching" | "born";

/** i 番目の机の状態。wait はたまごが待っている、hatching は今かえっている、born は生まれたあと */
export function deskStage(state: CeremonyState, index: number): DeskStage {
  if (state.phase === "prepare") return "wait";
  if (state.phase === "hatch") {
    if (index < state.hatched - 1) return "born";
    return index === state.hatched - 1 ? "hatching" : "wait";
  }
  return "born";
}

export interface KitTag {
  label: string;
  kind: "skill" | "file";
}

/** 担当ごとに見せる札（スキル → スクリプトの順で最大 max 枚）と、入りきらなかった数 */
export function kitTags(skills: readonly string[], files: readonly string[], max = KIT_MAX): { tags: KitTag[]; more: number } {
  const all: KitTag[] = [...skills.map((label) => ({ label, kind: "skill" as const })), ...files.map((label) => ({ label, kind: "file" as const }))];
  return { tags: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/** 読み上げの 1 行（aria-live）。hatch は直近に生まれた担当の名前 */
export function liveLine(state: CeremonyState, names: readonly string[]): string {
  switch (state.phase) {
    case "prepare":
      return "作業場を用意しています";
    case "hatch": {
      const name = names[state.hatched - 1];
      return name ? `${name}が生まれました` : "作業場を用意しています";
    }
    case "equip":
      return "道具を配っています";
    case "ready":
    case "done":
      return "チームがそろいました";
  }
}
