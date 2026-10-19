// 試験用の小さな走行（index からは出さない）。sim-core の仕入れ係の世界を本物の関数で動かし、オラクルの入力を組み立てる

import { destinationKey, optionDigest, type EffectiveRule, type Guard, type StoppedWrite } from "@open-team/kernel";
import {
  SHOP_SEED_VERSION,
  ScenarioSchema,
  advanceShop,
  agentRunsFor,
  applyShopScenario,
  createShopInitialState,
  handleShopTool,
  isShopWriteTool,
  isSimGcalWriteTool,
  virtualTime,
  type CaseSource,
  type FaultSpecInput,
  type Scenario,
  type ShopState,
  type SimEvent,
  type ToolOutcome,
} from "@open-team/sim-core";
import { argRolesOf, toJsonObject } from "./context.ts";
import type { OracleInput, OracleIntent } from "./input.ts";

export const TASK = "task-1";

/** 状況を作る（障害が0件なら incident：M-28） */
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

export interface CallOpts {
  /** 書き込みの Intent の ID（既定は 'i-<連番>'。読み取りは null） */
  intentId?: string | null;
  taskId?: string | null;
}

export interface Run {
  scenario: Scenario;
  initial: ShopState;
  state: ShopState;
  events: SimEvent[];
  call(tool: string, args?: unknown, opts?: CallOpts): ToolOutcome<ShopState>;
  advance(day: number, hhmm: string): void;
  /** 2日目 23:59 まで進める（§3.5 の終わり） */
  end(): void;
  /** その Intent の ID の書き込みの事象から、Intent の記録を作る */
  intent(intentId: string, over?: Partial<OracleIntent>): OracleIntent;
  /** その Intent の ID の書き込みの事象の seq */
  seqOf(intentId: string): number;
  input(over?: Partial<OracleInput>): OracleInput;
}

export function startRun(
  faults: FaultSpecInput[] = [],
  opts: { seed?: number; source?: CaseSource; prepare?: (s: ShopState) => void } = {},
): Run {
  // 障害が0件の状況は incident だけ作れる（M-28）ので、障害なしの走行は incident（止まった書き込みは空）にする
  const scenario = scenarioOf(faults, opts.seed ?? 1, opts.source);
  const base = structuredClone(applyShopScenario(createShopInitialState(scenario.seed, { seedVersion: SHOP_SEED_VERSION }), scenario));
  opts.prepare?.(base);
  let n = 0;
  const run: Run = {
    scenario,
    initial: base,
    state: base,
    events: [],
    call(tool, args = {}, o = {}) {
      const dot = tool.indexOf(".");
      const write = isShopWriteTool(tool) || isSimGcalWriteTool(tool);
      // 予定の登録（gcal.create_event）の Intent の ID は UUID（eventIdOf の入力）。ほかの書き込みは i-<番号>
      let intentId: string | null = null;
      if (o.intentId !== undefined) intentId = o.intentId;
      else if (write) {
        n += 1;
        intentId = isSimGcalWriteTool(tool) ? `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` : `i-${n}`;
      }
      const out = handleShopTool(
        run.state,
        { connector: tool.slice(0, dot), tool: tool.slice(dot + 1), args },
        { caller: "sa-gateway", taskId: o.taskId === undefined ? TASK : o.taskId, intentId, shadow: false },
      );
      run.state = out.state;
      run.events.push(...out.events);
      return out;
    },
    advance(day, hhmm) {
      const r = advanceShop(run.state, virtualTime(run.state.clock, day, hhmm));
      run.state = r.state;
      run.events.push(...r.events);
    },
    end() {
      run.advance(2, "23:59");
    },
    intent(intentId, over = {}) {
      const e = run.events.find((x) => x.kind === "tool_call" && x.intentId === intentId);
      if (!e?.tool) throw new Error(`Intent ${intentId} の書き込みがない`);
      return makeIntent(intentId, e.tool, e.args, { taskId: e.taskId ?? TASK, ...over });
    },
    seqOf(intentId) {
      const e = run.events.find((x) => x.kind === "tool_call" && x.intentId === intentId);
      if (!e) throw new Error(`Intent ${intentId} の書き込みがない`);
      return e.seq;
    },
    input(over = {}) {
      return {
        world: "shop",
        variant: "governed",
        scenario: run.scenario,
        initial: run.initial,
        final: run.state,
        events: run.events,
        intents: [],
        decisions: [],
        target: { rules: [], guards: [] },
        stoppedWrites: run.scenario.origin.source === "incident" ? [] : null,
        ...over,
      };
    },
  };
  return run;
}

/** Intent の記録（鍵は kernel の destinationKey・optionDigest。役割は edge と同じ effectiveArgRoles） */
export function makeIntent(id: string, tool: string, args: unknown, over: Partial<OracleIntent> = {}): OracleIntent {
  const action = `mcp.${tool}`;
  const roles = argRolesOf(tool);
  if (roles === null) throw new Error(`manifest にないツール：${tool}`);
  const a = toJsonObject(args);
  return {
    id,
    taskId: TASK,
    action,
    args: a,
    destinationKey: destinationKey(action, a, roles),
    optionDigest: optionDigest(action, a, roles),
    decision: "allow",
    reasonCode: "rule_matched",
    matchedRule: "rules.items[0]",
    enforced: true,
    taintedAtProposal: false,
    humanApprovedInBranch: false,
    status: "executed",
    ...over,
  };
}

/** 本番で止まった書き込み（IA §2.9。鍵は Intent と同じ計算） */
export function stoppedWriteOf(tool: string, args: unknown, over: Partial<StoppedWrite> = {}): StoppedWrite {
  const i = makeIntent("stopped-1", tool, args);
  return {
    intentId: i.id,
    sourceTaskId: "task-prod-1",
    jobId: "job-1",
    action: i.action,
    destinationKey: i.destinationKey,
    optionDigest: i.optionDigest,
    argumentsSnapshot: toJsonObject(args),
    stoppedBy: "kernel_approve",
    reasonCode: "guard_exceeded",
    occurredAt: "2026-10-05T18:01:00+09:00",
    ...over,
  };
}

/** 豆（BEAN-HOUSE）の発注 */
export function beans(quantity: number, unit_price = 780, note?: string) {
  return {
    supplier_id: "supplier-01",
    items: [{ sku: "BEAN-HOUSE", quantity, unit_price }],
    ...(note === undefined ? {} : { note }),
  };
}

/** 用意した依頼の候補のルール（supplier-01・豆を固定、数量と単価は変わってよい：D-60、U-11） */
export const BEAN_RULE: EffectiveRule = {
  id: "cand-1",
  action: "mcp.supplier.place_order",
  match: { supplier_id: "supplier-01", "items[].sku": ["BEAN-HOUSE"] },
  free: ["items[].quantity", "items[].unit_price"],
  tool_hash: `sha256:${"0".repeat(64)}`,
};

/** デモのガード（1回の発注は20個まで・単価は800円まで：15:394） */
export const DEMO_GUARDS: Guard[] = [
  { action: "mcp.supplier.place_order", arg: "items[].quantity", max: 20 },
  { action: "mcp.supplier.place_order", arg: "items[].unit_price", max: 800 },
];

/** 2日目の豆の売上がちょうど n になる最初のシード（在庫の境界の試験のため。決定論） */
export function seedWhereBeanSalesIs(n: number): number {
  for (let seed = 1; seed < 10_000; seed++) {
    const s = createShopInitialState(seed, { seedVersion: SHOP_SEED_VERSION });
    const r = advanceShop(s, virtualTime(s.clock, 2, "23:59"));
    const sales = r.events.find((e) => e.kind === "sales")?.result as { sold: Record<string, number> } | undefined;
    if (sales?.sold["BEAN-HOUSE"] === n) return seed;
  }
  throw new Error(`豆の売上が ${n} になるシードが見つからない`);
}

/** 走行のオラクルの結果を ID で引く */
export function verdictOf<T extends { oracle: string }>(verdicts: readonly T[], id: string): T {
  const v = verdicts.find((x) => x.oracle === id);
  if (!v) throw new Error(`${id} の結果がない`);
  return v;
}
