// plannerUsageOf（db/asks）と AskDetail.planner：編成を作った Gemini の呼び出しの集計
import { plannerUsageOf, insertGeneratingAsk } from "@open-team/db/asks";
import { insertUsageRecord } from "@open-team/db/edge";
import { useTestDb } from "@open-team/db/testing";
import { afterEach, describe, expect, it } from "vitest";
import { T0, startTestWorld, type TestWorld } from "../__fixtures__/world.ts";
import { buildAskDetail } from "./view.ts";

const T = useTestDb();
let world: TestWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

describe("plannerUsageOf", () => {
  it("phase = planner の回数・時間・費用の合計と最後のモデル。ほかの phase・ほかの依頼は数えない。呼んでいなければ null", async () => {
    const { db } = T();
    const w = (world = await startTestWorld(db));
    const mk = () => db.transaction((tx) => insertGeneratingAsk(tx, w.ws.ctx, { createdBy: w.ws.userId, text: "何かして", mentionAgentId: null, now: T0 }));
    const ask = await mk();
    const other = await mk();
    expect(await plannerUsageOf(db, w.ws.ctx, ask.id)).toBeNull();
    expect((await buildAskDetail(db, w.ws.ctx, ask.id))!.planner).toBeNull();

    const rec = (askId: string, phase: string, model: string, ms: number, cost: string, at: number) =>
      db.transaction((tx) =>
        insertUsageRecord(tx, w.ws.ctx, { taskId: null, agentId: null, askId, provider: "google", model, phase: phase as never, inputTokens: 1, outputTokens: 1, estimatedCostUsd: cost, costUsd: cost, latencyMs: ms, promptHash: "h" }, new Date(T0.getTime() + at)),
      );
    await rec(ask.id, "planner", "gemini-a", 4000, "0.001000", 0);
    await rec(ask.id, "planner", "gemini-b", 10000, "0.002000", 1000);
    await rec(ask.id, "plan", "gemini-x", 99999, "5.000000", 2000);
    await rec(other.id, "planner", "gemini-z", 777, "0.500000", 3000);

    expect(await plannerUsageOf(db, w.ws.ctx, ask.id)).toEqual({ model: "gemini-b", calls: 2, latencyMs: 14000, costUsd: "0.003000" });
    expect((await buildAskDetail(db, w.ws.ctx, ask.id))!.planner).toEqual({ model: "gemini-b", calls: 2, latencyMs: 14000, costUsd: "0.003000" });
  });
});
