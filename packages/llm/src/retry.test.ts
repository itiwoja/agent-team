import { describe, expect, it } from "vitest";
import { isRetryableLlmError, LLM_RETRY_DELAYS_MS, llmAbortedError, sleepMs, withRetry, type RetryInfo, type SleepFn } from "./retry.ts";
import { LlmError } from "./types.ts";

/** 待たずに待ち時間だけを記録する */
function recordingSleep(): { delays: number[]; sleep: SleepFn } {
  const delays: number[] = [];
  return { delays, sleep: async (ms) => void delays.push(ms) };
}

const fail = (status: number | null, retryable: boolean) => new LlmError(`失敗 ${String(status)}`, status, retryable);

describe("withRetry（1・4・16秒で最大3回：11_tech_spec.md:293）", () => {
  it("LLM_RETRY_DELAYS_MS は 1・4・16秒", () => {
    expect(LLM_RETRY_DELAYS_MS).toEqual([1_000, 4_000, 16_000]);
  });

  it("SO-BUD-13：429 が4回続くと 1・4・16秒あけて3回やり直し、最後の失敗をそのまま投げる", async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    const error = await withRetry(
      async () => {
        calls++;
        throw fail(429, true);
      },
      { sleep },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ status: 429, retryable: true });
    expect(calls).toBe(4);
    expect(delays).toEqual([1_000, 4_000, 16_000]);
  });

  it("HL-13：503 が2回のあと通れば結果を返す（待ちは 1・4 秒）", async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls <= 2) throw fail(503, true);
        return "ok";
      },
      { sleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([1_000, 4_000]);
  });

  it("やり直せない失敗（400）はすぐ投げる", async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw fail(400, false);
        },
        { sleep },
      ),
    ).rejects.toMatchObject({ status: 400, retryable: false });
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("LlmError でない失敗はやり直さない（既定の shouldRetry）", async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("boom");
        },
        { sleep },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("attempt は 0 から数え、onRetry に何回目か・待ち・失敗を渡す", async () => {
    const { sleep } = recordingSleep();
    const attempts: number[] = [];
    const infos: RetryInfo[] = [];
    const first = fail(500, true);
    const second = fail(null, true);
    await withRetry(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt === 0) throw first;
        if (attempt === 1) throw second;
        return 1;
      },
      { sleep, onRetry: (info) => infos.push(info) },
    );
    expect(attempts).toEqual([0, 1, 2]);
    expect(infos).toEqual([
      { retry: 1, delayMs: 1_000, error: first },
      { retry: 2, delayMs: 4_000, error: second },
    ]);
  });

  it("delaysMs を差し替えられる（[] ならやり直さない）", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw fail(503, true);
        },
        { delaysMs: [] },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(1);
  });

  it("shouldRetry で判定を差し替えられる", async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error("一時的");
        return "ok";
      },
      { sleep, shouldRetry: (e) => e instanceof Error && e.message === "一時的" },
    );
    expect(result).toBe("ok");
    expect(delays).toEqual([1_000]);
  });

  it("始める前に中断していれば呼ばずに中断の LlmError（やり直さない）", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          return 1;
        },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({ status: null, retryable: false });
    expect(calls).toBe(0);
  });

  it("Kill Switch：やり直しを待つ間に中断したら、それ以上呼ばずにすぐ返す（既定の sleepMs）", async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const started = Date.now();
    await expect(
      withRetry(
        async () => {
          calls++;
          throw fail(503, true);
        },
        { signal: ctrl.signal, onRetry: () => ctrl.abort() },
      ),
    ).rejects.toMatchObject({ status: null, retryable: false });
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(900); // 1秒の待ちをしていない
  });

  it("失敗の直後に中断に気づいたら、その失敗ではなく中断を投げる", async () => {
    const ctrl = new AbortController();
    await expect(
      withRetry(
        async () => {
          ctrl.abort();
          throw fail(503, true);
        },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({ message: llmAbortedError().message, retryable: false });
  });

  it("待つ関数が中断以外で失敗したら、その失敗を投げる", async () => {
    await expect(
      withRetry(
        async () => {
          throw fail(503, true);
        },
        {
          sleep: async () => {
            throw new Error("時計が壊れた");
          },
        },
      ),
    ).rejects.toThrow("時計が壊れた");
  });

  it("isRetryableLlmError は LlmError の retryable だけを見る", () => {
    expect(isRetryableLlmError(fail(429, true))).toBe(true);
    expect(isRetryableLlmError(fail(400, false))).toBe(false);
    expect(isRetryableLlmError(new Error("x"))).toBe(false);
    expect(isRetryableLlmError(llmAbortedError())).toBe(false);
  });
});

describe("sleepMs", () => {
  it("待ってから解決する", async () => {
    await expect(sleepMs(1)).resolves.toBeUndefined();
  });

  it("中断済みの signal ならすぐ中断の LlmError で拒否する", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sleepMs(10_000, ctrl.signal)).rejects.toMatchObject({ retryable: false, status: null });
  });

  it("待っている間に中断したら、待たずに拒否する", async () => {
    const ctrl = new AbortController();
    const started = Date.now();
    const p = sleepMs(10_000, ctrl.signal);
    setTimeout(() => ctrl.abort(), 5);
    await expect(p).rejects.toBeInstanceOf(LlmError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
