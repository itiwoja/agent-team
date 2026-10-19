// LLM の呼び出しの再試行（11_tech_spec.md:293、04_functional_spec/runtime.md:141、SO §3.12-5・LIMITS.llmRetryDelaysMs）
// やり直すのは 429・5xx・ネットワークの失敗（LlmError.retryable）だけ。1・4・16秒あけて最大3回（初回と合わせて最大4回）。
// 尽きたら最後の失敗をそのまま投げる（edge が 502 LLM_UPSTREAM_ERROR・failed(llm_unavailable) にする：HL-13）

import { LlmError } from "./types.ts";

/** 再試行の前に待つ時間（ミリ秒）。要素の数が再試行の回数 */
export const LLM_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 16_000];

/** 待つ関数（試験では差し替えて時間を進めない）。signal で中断したら拒否する */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RetryInfo {
  /** 何回目の再試行か（1 から） */
  retry: number;
  delayMs: number;
  /** 直前の失敗。status が null の LlmError は、送れたか・使った量が分からない（SO §3.12-6） */
  error: unknown;
}

export interface RetryOptions {
  delaysMs?: readonly number[];
  sleep?: SleepFn;
  /** 呼び出し元の中断（Kill Switch）。中断したらやり直さない */
  signal?: AbortSignal;
  /** 既定は LlmError の retryable だけ */
  shouldRetry?: (error: unknown) => boolean;
  /** 待つ前に呼ぶ（失敗した回の記録用） */
  onRetry?: (info: RetryInfo) => void;
}

/** 呼び出し元が中断した（Kill Switch など）。やり直さない */
export function llmAbortedError(): LlmError {
  return new LlmError("LLM の呼び出しを中断しました", null, false);
}

export function isRetryableLlmError(error: unknown): boolean {
  return error instanceof LlmError && error.retryable;
}

/** setTimeout で待つ。中断したら llmAbortedError で拒否する */
export const sleepMs: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(llmAbortedError());
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(llmAbortedError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** fn を呼び、やり直せる失敗なら delaysMs の順に待ってやり直す。attempt は 0 から */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const delays = opts.delaysMs ?? LLM_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? sleepMs;
  const shouldRetry = opts.shouldRetry ?? isRetryableLlmError;
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw llmAbortedError();
    try {
      return await fn(attempt);
    } catch (error) {
      if (opts.signal?.aborted) throw llmAbortedError();
      const delayMs = delays[attempt];
      if (delayMs === undefined || !shouldRetry(error)) throw error;
      opts.onRetry?.({ retry: attempt + 1, delayMs, error });
      try {
        await sleep(delayMs, opts.signal);
      } catch (sleepError) {
        if (opts.signal?.aborted) throw llmAbortedError();
        throw sleepError;
      }
    }
  }
}
