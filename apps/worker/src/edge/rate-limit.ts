// タスクごとの回数の上限（LLM の呼び出し 60回/分：si:106、進捗 10件/秒：rt:152。packages/edge/src/rate-limit.ts の写し）
// 状態は WorkspaceDO のメモリだけ（DO が眠ると消える。消えたら数え直す：上限を緩める側に倒れるが、回数の上限は費用の守りではない。
// 費用は decide(llm_call) と checkSpend が DB の値で守る）。時刻は呼び出し側の時計（試験で進められるように）。古い記録は呼ぶたびに捨てる

export interface Acquired {
  /** 受け付けた数（0 なら上限） */
  allowed: number;
  /** 次に1つ受け付けられるまでのミリ秒（allowed が求めた数に足りないとき） */
  retryAfterMs: number;
}

export class SlidingWindowLimiter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly hits = new Map<string, number[]>();
  private calls = 0;

  constructor(limit: number, windowMs: number) {
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError(`上限は0以上の整数：${limit}`);
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError(`窓は正の数：${windowMs}`);
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** key（タスク ID）について、nowMs に n 件を求める。窓の中の数が limit を超えない分だけ受け付ける */
  tryAcquire(key: string, nowMs: number, n = 1): Acquired {
    this.sweep(nowMs);
    const since = nowMs - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    const room = Math.max(0, this.limit - list.length);
    const allowed = Math.min(room, Math.max(0, n));
    for (let i = 0; i < allowed; i++) list.push(nowMs);
    if (list.length > 0) this.hits.set(key, list);
    else this.hits.delete(key);
    const oldest = list[0];
    const retryAfterMs = allowed >= n || oldest === undefined ? 0 : Math.max(1, oldest + this.windowMs - nowMs);
    return { allowed, retryAfterMs };
  }

  /** 終わったタスクの記録を捨てる */
  forget(key: string): void {
    this.hits.delete(key);
  }

  /** ときどき全部の鍵を見て、窓の外だけになったものを消す（メモリを増やし続けない） */
  private sweep(nowMs: number): void {
    this.calls += 1;
    if (this.calls % 256 !== 0) return;
    const since = nowMs - this.windowMs;
    for (const [key, list] of this.hits) {
      if (list.every((t) => t <= since)) this.hits.delete(key);
    }
  }
}
