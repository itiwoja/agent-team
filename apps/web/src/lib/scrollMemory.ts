// 戻る・進むで同じ所に戻るための、履歴の項目ごとのスクロール位置の記憶（純粋な部分。window に触るのは router.ts）。
// 画面は移るたびに作り直され、中身は読み込みの後に入るので、ブラウザの自動の復元では間に合わない（骨の高さでは戻れない）。
// そこで、離れるときの位置を履歴の項目の鍵で覚え、戻ってきた画面が十分な高さになったときに戻す

export interface ScrollMemory {
  /** 鍵の項目を離れるとき、いまの位置を覚える */
  remember(key: string, y: number): void;
  /** 鍵の項目に戻ってきたとき、覚えていた位置（無ければ null）。1度取り出したら消える */
  take(key: string): number | null;
}

/** 覚える数の上限（古い順に忘れる） */
const LIMIT = 50;

export function createScrollMemory(): ScrollMemory {
  const positions = new Map<string, number>();
  return {
    remember(key, y) {
      positions.delete(key);
      positions.set(key, Math.max(0, Math.round(y)));
      while (positions.size > LIMIT) {
        const oldest = positions.keys().next().value;
        if (oldest === undefined) break;
        positions.delete(oldest);
      }
    },
    take(key) {
      const y = positions.get(key);
      if (y === undefined) return null;
      positions.delete(key);
      return y;
    },
  };
}

/** 履歴の項目の鍵（history.state に入れる） */
export function newHistoryKey(rand: () => number = Math.random): string {
  return `h${Date.now().toString(36)}${Math.floor(rand() * 1e9).toString(36)}`;
}

/** history.state から鍵を取り出す（無い・壊れていれば null） */
export function keyOfState(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const k = (state as { key?: unknown }).key;
  return typeof k === "string" && k !== "" ? k : null;
}

/**
 * 戻した位置まで文書が伸びたら scrollTo する係。読み込みが終わって高さが足りるまで待ち、待ちすぎたら（timeoutMs）その時点の高さで戻す。
 * 戻り値は止める関数（画面がまた移ったとき）
 */
export function restoreWhenTall(y: number, opts: { scrollTo: (y: number) => void; maxScroll: () => number; observe: (fn: () => void) => () => void; now: () => number; timeoutMs?: number }): () => void {
  const timeout = opts.timeoutMs ?? 1500;
  const start = opts.now();
  let done = false;
  let stop: () => void = () => undefined;
  const attempt = () => {
    if (done) return;
    if (opts.maxScroll() >= y || opts.now() - start > timeout) {
      done = true;
      stop();
      opts.scrollTo(y);
    }
  };
  stop = opts.observe(attempt);
  attempt();
  return () => {
    done = true;
    stop();
  };
}
