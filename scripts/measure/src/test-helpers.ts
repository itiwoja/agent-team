// 試験用の小さな道具（index からは出さない）
import { ScriptedLlmClient, type LlmClient, type ScriptedResponder } from "@open-team/llm";
import type { LlmPhase } from "@open-team/runner";
import {
  SHOP_SEED_VERSION,
  advanceShop,
  createShopInitialState,
  virtualTime,
  type OracleId,
  type OracleVerdict,
} from "@open-team/sim-core";
import { measureFormation, type MeasureFormation } from "./context.ts";
import { createCostMeter, type CostMeter } from "./edge.ts";
import { runMeasureScenario, type MeasureRunResult } from "./run.ts";
import type { MeasureFaultId } from "./scenarios.ts";
import { scriptedMeasureAgent, type ScriptedBehavior } from "./scripted.ts";

/** 費用を数える価格表のモデル（本物の Flash 系の単価） */
export const TEST_MODEL = "gemini-3.8-flash";
export const modelFor = (_phase: LlmPhase): string => TEST_MODEL;

let cachedFormation: MeasureFormation | null = null;
export function formation(): MeasureFormation {
  cachedFormation ??= measureFormation();
  return cachedFormation;
}

/** 2日目の豆（BEAN-HOUSE）の売上がちょうど n になる最初のシード（欠品の境界の試験のため。決定論） */
export function seedWhereBeanSalesIs(n: number, from = 1): number {
  for (let seed = from; seed < from + 10_000; seed++) {
    const s = createShopInitialState(seed, { seedVersion: SHOP_SEED_VERSION });
    const r = advanceShop(s, virtualTime(s.clock, 2, "23:59"));
    const sales = r.events.find((e) => e.kind === "sales")?.result as { sold: Record<string, number> } | undefined;
    if (sales?.sold["BEAN-HOUSE"] === n) return seed;
  }
  throw new Error(`豆の売上が ${n} になるシードが見つからない`);
}

export function scriptedLlm(behavior: ScriptedBehavior): ScriptedLlmClient {
  return new ScriptedLlmClient(scriptedMeasureAgent(behavior));
}

/** 受信箱係だけ別の応答にする（仕入れ係は偽物のエージェントのまま） */
export function withInboxResponder(inbox: ScriptedResponder, behavior: ScriptedBehavior = "trap"): ScriptedLlmClient {
  const agent = scriptedMeasureAgent(behavior);
  return new ScriptedLlmClient((req, i) => (req.mcpTools.some((t) => t.tool === "list_inbox") ? inbox(req, i) : agent(req, i)));
}

export async function runOnce(
  fault: MeasureFaultId,
  opts: { behavior?: ScriptedBehavior; llm?: LlmClient; seed?: number; meter?: CostMeter; runIndex?: number; signal?: AbortSignal } = {},
): Promise<MeasureRunResult> {
  return runMeasureScenario({
    fault,
    runIndex: opts.runIndex ?? 0,
    seed: opts.seed ?? seedWhereBeanSalesIs(3),
    formation: formation(),
    llm: opts.llm ?? scriptedLlm(opts.behavior ?? "trap"),
    modelFor,
    meter: opts.meter ?? createCostMeter(5),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

export function verdictOf(result: MeasureRunResult, id: OracleId): OracleVerdict {
  const v = result.verdicts?.find((x) => x.oracle === id);
  if (!v) throw new Error(`${id} の結果がない`);
  return v;
}

/** 決まった時刻を返す時計（計測の日時） */
export function fixedClock(iso = "2026-10-04T10:00:00+09:00"): () => Date {
  const ms = Date.parse(iso);
  return () => new Date(ms);
}
