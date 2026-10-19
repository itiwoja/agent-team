// 試験用の小さな走行（index からは出さない）。状況を置いた初期状態から、呼び出し・時計・損害までを順に進める

import { virtualTime } from "../../clock.ts";
import type { CaseSource } from "../../common.ts";
import { ScenarioSchema, agentRunsFor, type FaultSpecInput, type Scenario } from "../../scenario.ts";
import type { CallCtx, SimEvent, ToolOutcome } from "../../world.ts";
import { advanceShop } from "./advance.ts";
import { computeShopDamage } from "./damage.ts";
import { handleShopTool } from "./handle.ts";
import { applyShopScenario } from "./scenario.ts";
import { SHOP_SEED_VERSION, createShopInitialState, type ShopState } from "./state.ts";

export const READ_CTX: CallCtx = { caller: "sa-gateway", taskId: "task-1", intentId: null, shadow: false };
export const writeCtx = (intentId = "intent-1"): CallCtx => ({ caller: "sa-gateway", taskId: "task-1", intentId, shadow: false });

/** 状況を作る（障害が0件なら incident として作る：M-28） */
export function scenarioOf(faults: FaultSpecInput[], seed = 1, source?: CaseSource): Scenario {
  return ScenarioSchema.parse({
    schemaVersion: 1,
    world: "shop",
    seed,
    title: "試験の状況",
    faults,
    agentRuns: agentRunsFor(faults as { id: Scenario["faults"][number]["id"] }[]),
    endAt: "day2_end",
    origin: { source: source ?? (faults.length === 0 ? "incident" : "generated") },
  });
}

export interface TestRun {
  scenario: Scenario;
  initial: ShopState;
  state: ShopState;
  events: SimEvent[];
  call(tool: string, args?: unknown, ctx?: CallCtx): ToolOutcome<ShopState>;
  advance(day: number, hhmm: string): SimEvent[];
  finish(): ReturnType<typeof computeShopDamage>;
}

export function startRun(seed = 1, faults: FaultSpecInput[] = []): TestRun {
  const scenario = scenarioOf(faults, seed);
  const initial = applyShopScenario(createShopInitialState(seed, { seedVersion: SHOP_SEED_VERSION }), scenario);
  const run: TestRun = {
    scenario,
    initial,
    state: initial,
    events: [],
    call(tool, args = {}, ctx) {
      const dot = tool.indexOf(".");
      const out = handleShopTool(
        run.state,
        { connector: tool.slice(0, dot), tool: tool.slice(dot + 1), args },
        ctx ?? (tool.startsWith("store.") || tool.endsWith(".list_products") || tool.endsWith(".list_inbox") ? READ_CTX : writeCtx()),
      );
      run.state = out.state;
      run.events.push(...out.events);
      return out;
    },
    advance(day, hhmm) {
      const r = advanceShop(run.state, virtualTime(run.state.clock, day, hhmm));
      run.state = r.state;
      run.events.push(...r.events);
      return r.events;
    },
    finish() {
      run.advance(2, "23:59");
      return computeShopDamage({ initial: run.initial, final: run.state, events: run.events, scenario: run.scenario });
    },
  };
  return run;
}

/** 豆 20kg（いつもの発注。単価 780） */
export const BEANS_20 = { supplier_id: "supplier-01", items: [{ sku: "BEAN-HOUSE", quantity: 20, unit_price: 780 }] };

/** 2日目の豆の売上がちょうど n になる最初のシード（SW-03 などの数字を決めるため） */
export function seedWhereBeanSalesIs(n: number): number {
  for (let seed = 1; seed < 10_000; seed++) {
    const r = startRun(seed);
    r.advance(2, "23:59");
    const sales = r.events.find((e) => e.kind === "sales");
    const sold = (sales?.result as { sold: Record<string, number> } | undefined)?.sold["BEAN-HOUSE"];
    if (sold === n) return seed;
  }
  throw new Error(`豆の売上が ${n} になるシードが見つからない`);
}
