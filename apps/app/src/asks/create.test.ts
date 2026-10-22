// 設定プランナーの生成（create.ts の generateAsk）の失敗の扱い：時間切れ・Kill Switch・費用の上限・材料の不足。LLM は台本・待ちぼうけ
import { lockWorkspace } from "@open-team/db";
import { getAsk, getLatestLiveRun, insertGeneratingAsk, insertLiveRun, markAskFormed } from "@open-team/db/asks";
import { useTestDb } from "@open-team/db/testing";
import { defaultWorkspacePolicy } from "@open-team/kernel";
import { LlmError, ScriptedLlmClient, type LlmClient } from "@open-team/llm";
import { AppError } from "@open-team/platform";
import { afterEach, describe, expect, it } from "vitest";
import { T0, startTestWorld, type TestWorld } from "../__fixtures__/world.ts";
import { jsonReply } from "../test-helpers.ts";
import { closeFailedStart, generateAsk, policyLinesOf, type CreateAskDeps } from "./create.ts";

const T = useTestDb();
let world: TestWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

async function setup(llm: LlmClient, over: Partial<CreateAskDeps> = {}) {
  const { db } = T();
  const w = (world = await startTestWorld(db));
  const ask = await db.transaction((tx) => insertGeneratingAsk(tx, w.ws.ctx, { createdBy: w.ws.userId, text: "何かして", mentionAgentId: null, now: T0 }));
  const deps: CreateAskDeps = { ...w.deps(llm as ScriptedLlmClient), sleep: async () => {}, ...over };
  return { w, ask, deps };
}

/** 呼ばれたら、中断されるまで返らない LLM */
const hanging: LlmClient = {
  generate: (_req, o) =>
    new Promise((_resolve, reject) => {
      o?.signal?.addEventListener("abort", () => reject(new LlmError("中断された", null, false)));
    }),
};

describe("generateAsk の失敗", () => {
  it("30秒（A-98）で打ち切る：failed（timeout）。登録簿から外れる", async () => {
    const { w, ask, deps } = await setup(hanging, { generationTimeoutMs: 80 });
    const r = await generateAsk(deps, w.ws.ctx, ask.id);
    expect(r.outcome).toBe("failed");
    expect(await getAsk(w.db, w.ws.ctx, ask.id)).toMatchObject({ status: "failed", failure_reason: "timeout" });
    expect(deps.registry.get(ask.id)).toBeUndefined();
  });

  it("Kill Switch（登録簿の中断）で止まる：failed（kill_switch）", async () => {
    const { w, ask, deps } = await setup(hanging);
    const running = generateAsk(deps, w.ws.ctx, ask.id);
    for (let i = 0; i < 100 && deps.registry.get(ask.id) === undefined; i++) await new Promise((r) => setTimeout(r, 10));
    expect(deps.registry.get(ask.id)).toMatchObject({ kind: "ask_generate", workspaceId: w.ws.workspaceId });
    await new Promise((r) => setTimeout(r, 30));
    deps.registry.abortWorkspace(w.ws.workspaceId, "kill_switch");
    expect((await running).outcome).toBe("failed");
    expect(await getAsk(w.db, w.ws.ctx, ask.id)).toMatchObject({ status: "failed", failure_reason: "kill_switch" });
  });

  it("費用の上限（全体の1日）に達していたら Gemini を呼ばず failed（budget_exceeded）", async () => {
    const llm = new ScriptedLlmClient([jsonReply({ formation: { shape: "single", members: [] } })]);
    const { w, ask, deps } = await setup(llm, { edge: { spendLimits: { platformDayMicroUsd: 1 } } });
    await w.db.query(
      `INSERT INTO usage_records (workspace_id, agent_id, provider, model, phase, input_tokens, output_tokens, estimated_cost_usd, cost_usd, latency_ms, prompt_hash, created_at)
       VALUES ($1, $2, 'google', 'm', 'planner', 1, 1, 1, 1, 1, 'h', $3)`,
      [w.ws.workspaceId, w.agent.agentId, T0],
    );
    const r = await generateAsk(deps, w.ws.ctx, ask.id);
    expect(r.outcome).toBe("failed");
    expect(await getAsk(w.db, w.ws.ctx, ask.id)).toMatchObject({ status: "failed", failure_reason: "budget_exceeded" });
    expect(llm.requests).toHaveLength(0);
  });

  it("Gemini が失敗したら failed（planner_error）。生成中でなくなった依頼は何もしない（skipped）", async () => {
    const { w, ask, deps } = await setup(new ScriptedLlmClient([]));
    expect((await generateAsk(deps, w.ws.ctx, ask.id)).outcome).toBe("failed");
    expect(await getAsk(w.db, w.ws.ctx, ask.id)).toMatchObject({ status: "failed", failure_reason: "planner_error" });
    expect((await generateAsk(deps, w.ws.ctx, ask.id)).outcome).toBe("skipped");
  });
});

describe("policyLinesOf", () => {
  it("ポリシーの要約を固定の文で作る（書き込みは確認が要る・予算・使えるコネクタ）", () => {
    const lines = policyLinesOf(defaultWorkspacePolicy());
    expect(lines).toContain("書き込み（発注・送信など）は送る前の確認が要る");
    expect(lines.join("\n")).toMatch(/予算は \$0\.5、1日は \$10/);
    expect(lines.at(-1)).toMatch(/^使えるコネクタ：/);
  });
});

describe("編成のあと実行を始められなかったとき（closeFailedStart）", () => {
  /** 編成ができた直後の依頼（running）。実行の行はまだない */
  async function runningAsk() {
    const { w, ask, deps } = await setup(new ScriptedLlmClient([]));
    const running = await T().db.transaction((tx) => markAskFormed(tx, w.ws.ctx, ask.id, { shape: "single", formation: {}, trigger: null, nextRunAt: null, now: T0 }));
    expect(running).toMatchObject({ status: "running" });
    return { w, ask, deps };
  }
  const askEvents = async (w: TestWorld) =>
    (await w.db.query<{ type: string; data: { status?: string } }>("SELECT type, data FROM workspace_events WHERE workspace_id = $1 AND type = 'ask.status' ORDER BY id", [w.ws.workspaceId])).rows;

  it("Kill Switch で止まったら running → cancelled（SSE も出す）", async () => {
    const { w, ask, deps } = await runningAsk();
    await w.db.query("UPDATE workspaces SET kill_switch_engaged = true, kill_switch_engaged_at = now() WHERE id = $1", [w.ws.workspaceId]);
    await closeFailedStart(deps, w.ws.ctx, ask.id, new AppError("KILL_SWITCH_ENGAGED"));
    expect(await getAsk(w.db, w.ws.ctx, ask.id)).toMatchObject({ status: "cancelled" });
    expect((await askEvents(w)).map((e) => e.data.status)).toEqual(["cancelled"]);
  });

  it("そのほかの失敗は running → failed（SSE も出す）", async () => {
    const { w, ask, deps } = await runningAsk();
    await closeFailedStart(deps, w.ws.ctx, ask.id, new Error("接続が切れた"));
    expect(await getAsk(w.db, w.ws.ctx, ask.id)).toMatchObject({ status: "failed" });
    expect((await askEvents(w)).map((e) => e.data.status)).toEqual(["failed"]);
  });

  it("すでに running でない依頼は触らない（遷移も SSE もなし）", async () => {
    const { w, ask, deps } = await runningAsk();
    await w.db.query("UPDATE asks SET status = 'done' WHERE id = $1", [ask.id]);
    await closeFailedStart(deps, w.ws.ctx, ask.id, new Error("遅れて届いた失敗"));
    expect(await getAsk(w.db, w.ws.ctx, ask.id)).toMatchObject({ status: "done" });
    expect(await askEvents(w)).toHaveLength(0);
  });

  it("別経路の開始が先にワークスペースロックを取り、実行を作った競合では依頼を閉じない", async () => {
    const { w, ask, deps } = await runningAsk();
    let locked!: () => void;
    let release!: () => void;
    const hasLock = new Promise<void>((resolve) => { locked = resolve; });
    const mayCommit = new Promise<void>((resolve) => { release = resolve; });
    const otherStart = w.db.transaction(async (tx) => {
      await lockWorkspace(tx, w.ws.ctx);
      locked();
      await mayCommit;
      expect(await insertLiveRun(tx, w.ws.ctx, ask.id, "manual", T0)).not.toBeNull();
    });
    await hasLock;

    // 失敗後処理はロック待ち。別経路の開始をコミットしてからロックを取得する。
    const close = closeFailedStart(deps, w.ws.ctx, ask.id, new Error("一時的なDBエラー"));
    release();
    await otherStart;
    await close;

    expect(await getLatestLiveRun(w.db, w.ws.ctx, ask.id)).not.toBeNull();
    expect(await getAsk(w.db, w.ws.ctx, ask.id)).toMatchObject({ status: "running" });
    expect(await askEvents(w)).toHaveLength(0);
  });
});
