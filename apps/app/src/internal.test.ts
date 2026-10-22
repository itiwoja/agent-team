// 内部のエンドポイント（EP-47 の tick の骨組み・/internal/* の呼び出し元。SO §3.9、AS §3.16、T-150・T-151、SO-INT-02〜04）
import { describe, expect, it } from "vitest";
import { unavailableDb } from "./deps.ts";
import { SHARED_TOKEN, makeTestApp, sendInternal } from "./test-helpers.ts";
import { runTick } from "./tick.ts";

describe("POST /internal/cron/tick", () => {
  it("T-151 証明なし ／ sa-gateway → 403、sa-app → 200 と3つの数（手順がなければ全部0）", async () => {
    const t = makeTestApp(unavailableDb());
    expect((await sendInternal(t, "POST", "/internal/cron/tick", null)).status).toBe(403);
    expect((await sendInternal(t, "POST", "/internal/cron/tick", "sa-gateway")).status).toBe(403);
    const res = await sendInternal(t, "POST", "/internal/cron/tick");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dispatched: 0, expiredApprovals: 0, scheduled: 0 });
  });

  it("拒否はログ internal_auth.denied に理由（応答には出さない）", async () => {
    const t = makeTestApp(unavailableDb());
    const res = await sendInternal(t, "POST", "/internal/cron/tick", "sa-gateway");
    expect(JSON.stringify(await res.json())).not.toContain("caller_not_allowed");
    expect(t.logs.find((r) => r.event === "internal_auth.denied")).toMatchObject({ reason: "caller_not_allowed", caller: "sa-gateway" });
  });

  it("共有トークンが設定されていない local → 全部拒否（閉じた側に倒す）", async () => {
    const t = makeTestApp(unavailableDb(), { env: { serviceAuth: { sharedToken: undefined } } });
    const res = await t.app.request("http://app.test/internal/cron/tick", {
      method: "POST",
      headers: { host: "app.test", authorization: `Bearer ${SHARED_TOKEN}`, "x-ot-caller": "sa-app" },
    });
    expect(res.status).toBe(403);
    expect(t.logs.find((r) => r.event === "internal_auth.denied")).toMatchObject({ reason: "shared_token_not_configured" });
  });

  it("手順の数を足し、1つが失敗してもほかは動く（失敗はログ tick.step_failed）", async () => {
    const order: string[] = [];
    const t = makeTestApp(unavailableDb(), {
      deps: {
        tickSteps: [
          { name: "expire", run: async () => (order.push("expire"), { expiredApprovals: 2 }) },
          {
            name: "broken",
            run: async () => {
              order.push("broken");
              throw new Error("boom");
            },
          },
          { name: "dispatch", run: async () => (order.push("dispatch"), { dispatched: 3, scheduled: 1 }) },
          { name: "dispatch2", run: async () => (order.push("dispatch2"), { dispatched: 1 }) },
        ],
      },
    });
    const res = await sendInternal(t, "POST", "/internal/cron/tick");
    expect(await res.json()).toEqual({ dispatched: 4, expiredApprovals: 2, scheduled: 1 });
    expect(order).toEqual(["expire", "broken", "dispatch", "dispatch2"]);
    expect(t.logs.find((r) => r.event === "tick.step_failed")).toMatchObject({ severity: "ERROR", step: "broken" });
  });

  it("runTick は同じ時刻を全部の手順に渡す", async () => {
    const seen: Date[] = [];
    const t = makeTestApp(unavailableDb(), {
      deps: {
        tickSteps: [
          { name: "a", run: async (_d, now) => (seen.push(now), {}) },
          { name: "b", run: async (_d, now) => (seen.push(now), {}) },
        ],
      },
    });
    await runTick(t.deps);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(t.clock.now());
    expect(seen[1]).toBe(seen[0]);
  });
});
