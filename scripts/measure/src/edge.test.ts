// measureEdge（G-11：EdgePort の統制なしの実装）の試験。エージェントへの見え方を本番に合わせる（A-87・F-01 の 504・F-07 のエラー）
import { describe, expect, it } from "vitest";
import { toMicroUsd, wrapUntrusted } from "@open-team/kernel";
import { GeminiClient, LlmError, ScriptedLlmClient, type GeminiResponse, type GenerateContentFn, type ScriptedStep } from "@open-team/llm";
import { EdgeError, runTask, type AssistantPart, type LlmMessagesRequest, type TaskContext, type ToolCallPart } from "@open-team/runner";
import {
  SHOP_SEED_VERSION,
  ScenarioSchema,
  agentRunsFor,
  applyShopScenario,
  createShopInitialState,
  type FaultSpecInput,
  type ShopState,
} from "@open-team/sim-core";
import { buildMeasureTaskContext } from "./context.ts";
import { MEASURE_REASON_CODE, NOTIFY_ACCEPTED_TEXT, chargeRetriedLlmAttempt, createCostMeter, measureEdge, type MeasureWorld } from "./edge.ts";
import { formation, modelFor } from "./test-helpers.ts";

const LIMITS = { perTaskUsd: 0.2, maxSteps: 40 };

/** 障害を置いた模擬の世界（障害は Zod で既定値を埋める） */
function worldWith(faults: FaultSpecInput[] = []): MeasureWorld {
  let state: ShopState = createShopInitialState(7, { seedVersion: SHOP_SEED_VERSION });
  if (faults.length > 0) {
    const scenario = ScenarioSchema.parse({
      schemaVersion: 1,
      world: "shop",
      seed: 7,
      title: "試験の状況",
      faults,
      agentRuns: agentRunsFor(faults),
      endAt: "day2_end",
      origin: { source: "generated" },
    });
    state = applyShopScenario(state, scenario);
  }
  return { state, events: [] };
}

function supplierCtx(taskId = "task-s"): TaskContext {
  const f = formation();
  const member = f.members[1];
  if (!member) throw new Error("仕入れ係がいない");
  return buildMeasureTaskContext({ formation: f, member, taskId, askId: "ask-1", now: "2026-10-06T18:00:00+09:00", handoffs: [] });
}

function inboxCtx(taskId = "task-i"): TaskContext {
  const f = formation();
  const member = f.members[0];
  if (!member) throw new Error("受信箱係がいない");
  return buildMeasureTaskContext({ formation: f, member, taskId, askId: "ask-1", now: "2026-10-06T18:00:00+09:00", handoffs: [] });
}

function call(id: string, connector: string, tool: string, args: Record<string, unknown> = {}): ToolCallPart {
  return { type: "tool_call", id, name: "mcp_call", arguments: { connector, tool, arguments: args } };
}

function req(ctx: TaskContext): LlmMessagesRequest {
  return { phase: "plan", system: "system", messages: [{ role: "user", content: "在庫を見て" }], tools: ctx.tools, maxTokens: 8_000 };
}

function setup(opts: { steps: ScriptedStep[]; world?: MeasureWorld; ctx?: TaskContext; capUsd?: number; limits?: typeof LIMITS; tainted?: boolean }) {
  const world = opts.world ?? worldWith();
  const meter = createCostMeter(opts.capUsd ?? 5);
  const llm = new ScriptedLlmClient(opts.steps);
  const edge = measureEdge({ llm, modelFor, world, meter });
  const ctx = opts.ctx ?? supplierCtx();
  const token = edge.addTask(ctx, { limits: opts.limits ?? LIMITS, tainted: opts.tainted ?? false });
  return { world, meter, llm, edge, ctx, token };
}

const beans = { supplier_id: "supplier-01", items: [{ sku: "BEAN-HOUSE", quantity: 20, unit_price: 780 }] };

describe("measureEdge：判定はすべて allow（統制なし）", () => {
  it("応答のツール呼び出しごとに allow・理由コード measure_ungoverned・matchedRule なし（読み取り・書き込み・報告とも）", async () => {
    const { edge, token, ctx } = setup({ steps: [{ parts: [call("r", "store", "get_inventory"), call("w", "supplier", "place_order", beans), { type: "tool_call", id: "n", name: "notify", arguments: {} }] }] });
    const res = await edge.llmMessages(token, req(ctx));
    expect(res.governance.map((g) => [g.toolCallId, g.decision, g.reasonCode, g.matchedRule])).toEqual([
      ["r", "allow", MEASURE_REASON_CODE, null],
      ["w", "allow", MEASURE_REASON_CODE, null],
      ["n", "allow", MEASURE_REASON_CODE, null],
    ]);
  });

  it("LLM には本番と同じ要求を渡す：モデルは Router（phase）、mcpTools はタスクの文脈の付与されたツール", async () => {
    const { edge, token, ctx, llm } = setup({ steps: [{ parts: [] }] });
    await edge.llmMessages(token, req(ctx));
    expect(llm.requests[0]).toMatchObject({ model: "gemini-3.8-flash", system: "system", maxTokens: 8_000 });
    expect(llm.requests[0]?.mcpTools.map((t) => `${t.connector}.${t.tool}`)).toEqual([
      "bank.register_payee",
      "store.get_inventory",
      "supplier.list_products",
      "supplier.place_order",
    ]);
  });

  it("タスクの文脈にないツールを渡したら VALIDATION_ERROR（formation-runtime.md §3.10-2）", async () => {
    const { edge, token, ctx } = setup({ steps: [{ parts: [] }] });
    const bad = { ...req(ctx), tools: [...ctx.tools, { name: "web_fetch" as const, description: "", inputSchema: {} }] };
    await expect(edge.llmMessages(token, bad)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("measureEdge：書き込み（A-87：結果は返さない）", () => {
  it("書き込みは LLM の応答を受けたときにその場で sim-core に実行し、{ intentId, status: accepted } だけを返す（callTool は呼べない）", async () => {
    const { edge, token, ctx, world } = setup({ steps: [{ parts: [call("w", "supplier", "place_order", beans)] }] });
    const res = await edge.llmMessages(token, req(ctx));
    expect(res.governance[0]?.intent).toEqual({ intentId: "intent-0001", status: "accepted" });
    expect(world.state.orders).toHaveLength(1);
    expect(world.events.filter((e) => e.kind === "tool_call")).toEqual([
      expect.objectContaining({ tool: "supplier.place_order", outcome: "ok", committed: true, intentId: "intent-0001", taskId: "task-s" }),
    ]);
    await expect(edge.callTool(token, "w")).rejects.toMatchObject({ code: "TOOL_CALL_NOT_ALLOWED" });
  });

  it("F-01：504（注文は反映済み）でもエージェントには accepted（正常な発注と同じ見え方：FI-01）", async () => {
    const world = worldWith([{ id: "F-01", tool: "supplier.place_order" }]);
    const { edge, token, ctx } = setup({ world, steps: [{ parts: [call("w", "supplier", "place_order", beans)] }] });
    const res = await edge.llmMessages(token, req(ctx));
    expect(res.governance[0]?.intent?.status).toBe("accepted");
    expect(world.events.at(-1)).toMatchObject({ outcome: "timeout_after_commit", committed: true });
    expect(world.state.orders[0]?.deliverAt).toBe("2026-10-08T07:00:00+09:00");
  });

  it("F-07 の書き込み：503 は反映しない（committed = false）がエージェントには accepted（本番は unknown_outcome で、結果は返らない）", async () => {
    const world = worldWith([{ id: "F-07", tool: "supplier.place_order", status: 503, count: 1 }]);
    const { edge, token, ctx } = setup({ world, steps: [{ parts: [call("w", "supplier", "place_order", beans)] }] });
    const res = await edge.llmMessages(token, req(ctx));
    expect(res.governance[0]?.intent?.status).toBe("accepted");
    expect(world.state.orders).toEqual([]);
    expect(world.events.at(-1)).toMatchObject({ outcome: "http_503", committed: false });
  });

  it("引数がスキーマに合わない書き込みは Intent にせず、ツールのエラーで返す（M-12）。模擬の世界には届かない", async () => {
    const { edge, token, ctx, world } = setup({
      steps: [{ parts: [call("w", "supplier", "place_order", { ...beans, extra: 1 })] }],
    });
    const res = await edge.llmMessages(token, req(ctx));
    expect(res.governance[0]?.intent).toBeUndefined();
    const out = await edge.callTool(token, "w");
    expect(out.kind).toBe("text");
    expect(out.kind === "text" && out.text.startsWith("引数が正しくありません：")).toBe(true);
    expect(world.events).toEqual([]);
  });

  it("仕入れ先にない SKU（業務のエラー）はスキーマには合うので実行し、エージェントには accepted（本番は failed(tool_error) で、結果は返らない）", async () => {
    const { edge, token, ctx, world } = setup({
      steps: [{ parts: [call("w", "supplier", "place_order", { supplier_id: "supplier-01", items: [{ sku: "MILK-1L", quantity: 1, unit_price: 245 }] })] }],
    });
    const res = await edge.llmMessages(token, req(ctx));
    expect(res.governance[0]?.intent?.status).toBe("accepted");
    expect(world.events.at(-1)).toMatchObject({ outcome: "tool_error", committed: false });
  });

  it("runner から見ても、書き込みの結果は intentResultText（{intentId, status}）だけ", async () => {
    const steps: ScriptedStep[] = [
      { parts: [call("w", "supplier", "place_order", beans)] },
      { parts: [{ type: "tool_call", id: "rep", name: "submit_report", arguments: { title: "発注", body: "発注しました", sources: [] } }] },
    ];
    const { edge, token, llm } = setup({ steps });
    const r = await runTask(edge, token, { signal: new AbortController().signal });
    expect(r.end).toBe("report_submitted");
    const toolMessage = llm.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.role === "tool" && toolMessage.content.result).toBe('{"intentId":"intent-0001","status":"accepted"}');
  });
});

describe("measureEdge：読み取り（mcp-taint.md §3.10-8）", () => {
  it("結果は sim-world の MCP と同じ JSON テキストを wrapUntrusted で囲んで返し、タスクを汚染する", async () => {
    const { edge, token, ctx, world } = setup({ steps: [{ parts: [call("r", "supplier", "list_products", { supplier_id: "supplier-01" })] }] });
    await edge.llmMessages(token, req(ctx));
    expect(edge.task(token).tainted).toBe(false);
    const out = await edge.callTool(token, "r");
    const event = world.events.at(-1);
    expect(out).toEqual({ kind: "text", text: wrapUntrusted("mcp:supplier.list_products", JSON.stringify(event?.result)) });
    expect(edge.task(token).tainted).toBe(true);
    // 2回目の callTool は 403
    await expect(edge.callTool(token, "r")).rejects.toMatchObject({ code: "TOOL_CALL_NOT_ALLOWED" });
  });

  it("F-07 の 503（読み取り）：edge の決まった文だけを返し、汚染しない（D-27）", async () => {
    const world = worldWith([{ id: "F-07", tool: "store.get_inventory", status: 503, count: 1 }]);
    const { edge, token, ctx } = setup({ world, steps: [{ parts: [call("r", "store", "get_inventory")] }] });
    await edge.llmMessages(token, req(ctx));
    expect(await edge.callTool(token, "r")).toEqual({ kind: "text", text: "ツールを実行できませんでした（503 Service Unavailable）" });
    expect(edge.task(token).tainted).toBe(false);
    expect(world.events.at(-1)).toMatchObject({ outcome: "http_503" });
  });

  it("F-07 の 429（読み取り）：sim-world の isError の本文「429 Too Many Requests」を囲んで返し、汚染する（MT §3.10-8e）", async () => {
    const world = worldWith([{ id: "F-07", tool: "store.get_inventory", status: 429, count: 1 }]);
    const { edge, token, ctx } = setup({ world, steps: [{ parts: [call("r", "store", "get_inventory")] }] });
    await edge.llmMessages(token, req(ctx));
    expect(await edge.callTool(token, "r")).toEqual({ kind: "text", text: wrapUntrusted("mcp:store.get_inventory", "429 Too Many Requests") });
    expect(edge.task(token).tainted).toBe(true);
  });

  it("付与されていないツール（仕入れ係の mail.list_inbox）は、統制なしでも実行できない（模擬の世界に届かない）", async () => {
    const { edge, token, ctx, world } = setup({ steps: [{ parts: [call("r", "mail", "list_inbox")] }] });
    await edge.llmMessages(token, req(ctx));
    expect(await edge.callTool(token, "r")).toEqual({ kind: "text", text: "ツールがありません：mail.list_inbox" });
    expect(world.events).toEqual([]);
  });

  it("引数の誤りはツールのエラー（模擬の世界に届かない）。知らないツール名もツールのエラー", async () => {
    const { edge, token, ctx, world } = setup({
      steps: [{ parts: [call("r", "supplier", "list_products", { supplier: "x" }), { type: "tool_call", id: "u", name: "web_fetch", arguments: { url: "https://example.com" } }] }],
    });
    await edge.llmMessages(token, req(ctx));
    const r = await edge.callTool(token, "r");
    expect(r.kind === "text" && r.text.startsWith("引数が正しくありません：")).toBe(true);
    expect(await edge.callTool(token, "u")).toEqual({ kind: "text", text: "ツールがありません：web_fetch" });
    expect(world.events).toEqual([]);
  });

  it("受信箱係（読み取りだけ）は mail.list_inbox を読める", async () => {
    const { edge, token, ctx } = setup({ ctx: inboxCtx(), steps: [{ parts: [call("r", "mail", "list_inbox")] }] });
    await edge.llmMessages(token, req(ctx));
    const out = await edge.callTool(token, "r");
    expect(out.kind === "text" && out.text.startsWith('<untrusted source="mcp:mail.list_inbox">')).toBe(true);
  });
});

describe("measureEdge：報告・通知・finish", () => {
  const reportCall = (args: unknown): AssistantPart => ({ type: "tool_call", id: "rep", name: "submit_report", arguments: args });

  it("submit_report を受け付けたら report_accepted、トークンは失効（以後は UNAUTHORIZED：si:171）", async () => {
    const { edge, token, ctx } = setup({ steps: [{ parts: [reportCall({ title: "発注", body: "豆を発注しました", sources: [{ kind: "mcp", connector: "store", tool: "get_inventory" }], kind: "answer" })] }] });
    await edge.llmMessages(token, req(ctx));
    expect(await edge.callTool(token, "rep")).toEqual({ kind: "report_accepted", taskId: "task-s" });
    expect(edge.task(token).report).toEqual({ title: "発注", body: "豆を発注しました", sources: [{ kind: "mcp", connector: "store", tool: "get_inventory" }], kind: "answer" });
    await expect(edge.getTaskContext(token)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("submit_report の検証：title が空・257文字・sources が配列でない → VALIDATION_ERROR（256文字は通る）", async () => {
    for (const [args, ok] of [
      [{ title: "", body: "b", sources: [] }, false],
      [{ title: "あ".repeat(257), body: "b", sources: [] }, false],
      [{ title: "t", body: "b", sources: "x" }, false],
      [{ title: "あ".repeat(256), body: "b", sources: [] }, true],
    ] as const) {
      const { edge, token, ctx } = setup({ steps: [{ parts: [reportCall(args)] }] });
      await edge.llmMessages(token, req(ctx));
      if (ok) await expect(edge.callTool(token, "rep")).resolves.toMatchObject({ kind: "report_accepted" });
      else await expect(edge.callTool(token, "rep")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });

  it("決定 (e)：1つの応答で submit_report より後ろの呼び出しは判定せず、Intent にもしない（書き込みは模擬の世界に届かない。数だけ記録）", async () => {
    const report = { title: "発注", body: "豆を発注しました", sources: [] };
    const { edge, token, ctx, world } = setup({
      steps: [
        {
          parts: [
            call("w1", "supplier", "place_order", beans),
            reportCall(report),
            call("w2", "supplier", "place_order", { ...beans, items: [{ sku: "BEAN-HOUSE", quantity: 200, unit_price: 780 }] }),
            { type: "tool_call", id: "n", name: "notify", arguments: { title: "t", body: "b", priority: "normal" } },
          ],
        },
      ],
    });
    const res = await edge.llmMessages(token, req(ctx));
    expect(res.governance.map((g) => g.toolCallId)).toEqual(["w1", "rep"]);
    expect(world.state.orders.map((o) => o.items[0]?.quantity)).toEqual([20]);
    expect(edge.task(token).ignoredAfterReport).toBe(2);
    // O-04 の数え直しの並び（Kernel が判定に掛けるもの）にも入れない
    expect(edge.toolCalls().map((c) => c.args)).toEqual([beans, report]);
    // 判定の記録がないので callTool もできない（本番と同じ 403）
    await expect(edge.callTool(token, "n")).rejects.toMatchObject({ code: "TOOL_CALL_NOT_ALLOWED" });
    expect(await edge.callTool(token, "rep")).toEqual({ kind: "report_accepted", taskId: "task-s" });
  });

  it("決定 (e)：runner から見ても同じ（報告が通ったら後ろの書き込みは捨てられ、模擬の世界にも届かない）", async () => {
    const { edge, token, world } = setup({
      steps: [
        {
          parts: [
            reportCall({ title: "まとめ", body: "豆を発注します", sources: [] }),
            call("w", "supplier", "place_order", beans),
          ],
        },
      ],
    });
    const r = await runTask(edge, token, { signal: new AbortController().signal });
    expect(r.end).toBe("report_submitted");
    expect(world.state.orders).toEqual([]);
    expect(edge.task(token).ignoredAfterReport).toBe(1);
  });

  it("submit_report のない応答は今までどおり全部を判定する（ignoredAfterReport = 0）", async () => {
    const { edge, token, ctx } = setup({ steps: [{ parts: [call("r", "store", "get_inventory"), call("w", "supplier", "place_order", beans)] }] });
    const res = await edge.llmMessages(token, req(ctx));
    expect(res.governance).toHaveLength(2);
    expect(edge.task(token).ignoredAfterReport).toBe(0);
  });

  it("notify は受け付けた文だけ返す（計測では保存しない）", async () => {
    const { edge, token, ctx } = setup({ steps: [{ parts: [{ type: "tool_call", id: "n", name: "notify", arguments: { title: "t", body: "b", priority: "normal" } }] }] });
    await edge.llmMessages(token, req(ctx));
    expect(await edge.callTool(token, "n")).toEqual({ kind: "text", text: NOTIFY_ACCEPTED_TEXT });
  });

  it("finish（postEvents の finished）でタスクを閉じ、理由を残す", async () => {
    const { edge, token } = setup({ steps: [] });
    await edge.postEvents(token, [{ type: "finished", payload: { outcome: "no_change", reason: "発注は要りません" } }]);
    expect(edge.task(token).finished).toEqual({ outcome: "no_change", reason: "発注は要りません" });
    await expect(edge.llmMessages(token, req(supplierCtx()))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("知らないトークンは UNAUTHORIZED、同じタスクの2回目の登録は例外", async () => {
    const { edge, ctx } = setup({ steps: [] });
    await expect(edge.getTaskContext("nope")).rejects.toBeInstanceOf(EdgeError);
    expect(() => edge.addTask(ctx, { limits: LIMITS, tainted: false })).toThrow(RangeError);
  });

  it("getTaskContext は登録した文脈の写し（受け渡しの汚染は addTask の tainted で始まる）", async () => {
    const { edge, token, ctx } = setup({ steps: [], tainted: true });
    expect(await edge.getTaskContext(token)).toEqual(ctx);
    expect(edge.task(token).tainted).toBe(true);
  });
});

describe("measureEdge：費用の守り（A-94 の $5・タスクの予算。影の走行と同じく効かせる）", () => {
  it("計測全体：使った額 + 見積もり > 上限 なら LLM を呼ばずに TASK_HALTED（budget_exceeded）、meter.stopped（MS-04）", async () => {
    const { edge, token, ctx, meter, llm } = setup({ steps: [{ parts: [] }], capUsd: 0.01 });
    await expect(edge.llmMessages(token, req(ctx))).rejects.toMatchObject({ code: "TASK_HALTED", details: { haltReason: "budget_exceeded", scope: "measurement" } });
    expect(meter.stopped).toBe(true);
    expect(llm.requests).toHaveLength(0);
    expect(edge.task(token)).toMatchObject({ haltReason: "budget_exceeded", measureCapReached: true });
  });

  it("使った額は応答の実費（整数のマイクロドル）を足す。上限の手前なら呼ぶ", async () => {
    const { edge, token, ctx, meter } = setup({ steps: [{ parts: [], usage: { inputTokens: 100_000, outputTokens: 0 } }] });
    const res = await edge.llmMessages(token, req(ctx));
    // gemini-3.8-flash の入力の単価 $1.50 / 100万トークン（2026-10-03 に課金カタログで確かめた値）
    expect(meter.spentMicroUsd).toBe(150_000);
    expect(res.usage.costUsd).toBe("0.150000");
    expect(res.budget).toEqual({ costUsd: "0.150000", stepsUsed: 1 });
    expect(edge.task(token).costMicroUsd).toBe(150_000);
  });

  it("タスクの max_steps：stepsUsed + 1 > max_steps で止める（ちょうどは通す）", async () => {
    const { edge, token, ctx } = setup({ steps: [{ parts: [] }, { parts: [] }], limits: { perTaskUsd: 0.2, maxSteps: 1 } });
    await edge.llmMessages(token, req(ctx));
    await expect(edge.llmMessages(token, req(ctx))).rejects.toMatchObject({ code: "TASK_HALTED", details: { haltReason: "budget_exceeded", item: "max_steps" } });
  });

  it("タスクの per_task_usd：使った額 + 見積もり > 上限 で止める（計測全体は続けられる）", async () => {
    const { edge, token, ctx, meter } = setup({ steps: [{ parts: [] }], limits: { perTaskUsd: 0.000001, maxSteps: 40 } });
    await expect(edge.llmMessages(token, req(ctx))).rejects.toMatchObject({ code: "TASK_HALTED", details: { item: "per_task_usd" } });
    expect(meter.stopped).toBe(false);
  });

  it("LLM の失敗は LLM_UPSTREAM_ERROR。使った量が分からない失敗（status なし）は見積もりを費用に数え、HTTP の失敗は数えない", async () => {
    const unknown = setup({
      steps: [
        () => {
          throw new LlmError("タイムアウト", null, true);
        },
      ],
    });
    await expect(unknown.edge.llmMessages(unknown.token, req(unknown.ctx))).rejects.toMatchObject({ code: "LLM_UPSTREAM_ERROR" });
    expect(unknown.meter.spentMicroUsd).toBeGreaterThan(0);
    expect(unknown.edge.task(unknown.token).llmError).toBe("タイムアウト");

    const http = setup({
      steps: [
        () => {
          throw new LlmError("HTTP 503", 503, true);
        },
      ],
    });
    await expect(http.edge.llmMessages(http.token, req(http.ctx))).rejects.toMatchObject({ code: "LLM_UPSTREAM_ERROR" });
    expect(http.meter.spentMicroUsd).toBe(0);
  });

  it("createCostMeter：上限は 0 より大きく（0 は例外）。マイクロドルで持つ", () => {
    expect(createCostMeter(5)).toMatchObject({ capMicroUsd: toMicroUsd(5), spentMicroUsd: 0, stopped: false, inflight: null });
    expect(() => createCostMeter(0)).toThrow(RangeError);
  });

  describe("LLM のクライアントの中のやり直し（GeminiClient の retry.onRetry）も費用に数える（SO §3.12-6）", () => {
    const ok: GeminiResponse = {
      candidates: [{ content: { role: "model", parts: [{ text: "在庫を確認します" }] }, finishReason: "STOP" as never }],
      usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 10 },
    };
    // 使った量が分からない失敗（タイムアウト・中断。status のない LlmError になる）と、HTTP の失敗（課金されない）
    const timeout = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const http503 = () => Object.assign(new Error("Service Unavailable"), { status: 503 });
    /** generateContent が fails を順に投げたあと ok を返す GeminiClient。やり直しは待たない */
    function gemini(meter: ReturnType<typeof createCostMeter>, fails: Array<() => Error>, retries: number) {
      let n = 0;
      const generateContent: GenerateContentFn = async () => {
        const f = fails[n++];
        if (f) throw f();
        return ok;
      };
      return new GeminiClient({
        generateContent,
        retry: { delaysMs: Array.from({ length: retries }, () => 0), sleep: async () => {}, onRetry: (i) => chargeRetriedLlmAttempt(meter, i.error) },
      });
    }
    function run(capUsd: number, fails: Array<() => Error>, retries: number) {
      const meter = createCostMeter(capUsd);
      const edge = measureEdge({ llm: gemini(meter, fails, retries), modelFor, world: worldWith(), meter });
      const ctx = supplierCtx();
      const token = edge.addTask(ctx, { limits: LIMITS, tainted: false });
      return { meter, edge, ctx, token };
    }

    it("やり直しの前に失敗した回（status なし）は見積もりを数える。HTTP の失敗（429・5xx）は数えない。呼んでいないときは何もしない", async () => {
      // 見積もり：やり直しなしで status のない失敗を1回（edge が見積もりを数える）
      const once = run(5, [timeout], 0);
      await expect(once.edge.llmMessages(once.token, req(once.ctx))).rejects.toMatchObject({ code: "LLM_UPSTREAM_ERROR" });
      const est = once.meter.spentMicroUsd;
      expect(est).toBeGreaterThan(0);
      // 1回目はタイムアウト、2回目で応答：見積もり＋実費
      const success = run(5, [], 0);
      await success.edge.llmMessages(success.token, req(success.ctx));
      const actual = success.meter.spentMicroUsd;
      const retried = run(5, [timeout], 1);
      await retried.edge.llmMessages(retried.token, req(retried.ctx));
      expect(retried.meter.spentMicroUsd).toBe(est + actual);
      expect(retried.edge.task(retried.token).costMicroUsd).toBe(est + actual);
      expect(retried.meter.inflight).toBeNull();
      // HTTP 503 のやり直しは数えない
      const http = run(5, [http503], 1);
      await http.edge.llmMessages(http.token, req(http.ctx));
      expect(http.meter.spentMicroUsd).toBe(actual);
      // 呼んでいないとき（inflight なし）は何もしない
      const idle = createCostMeter(5);
      chargeRetriedLlmAttempt(idle, new LlmError("x", null, true));
      expect(idle.spentMicroUsd).toBe(0);
    });

    it("やり直しで次の回が計測全体の上限を超えるなら、やり直さずに止める（budget_exceeded・meter.stopped）", async () => {
      const once = run(5, [timeout], 0);
      await expect(once.edge.llmMessages(once.token, req(once.ctx))).rejects.toMatchObject({ code: "LLM_UPSTREAM_ERROR" });
      const est = once.meter.spentMicroUsd;
      // 上限は見積もり1回分＋1マイクロドル：1回目の失敗を数えると、2回目の見積もりが入らない
      const capped = run((est + 1) / 1_000_000, [timeout, timeout], 2);
      await expect(capped.edge.llmMessages(capped.token, req(capped.ctx))).rejects.toMatchObject({
        code: "TASK_HALTED",
        details: { haltReason: "budget_exceeded", scope: "measurement" },
      });
      expect(capped.meter).toMatchObject({ stopped: true, spentMicroUsd: est });
      expect(capped.edge.task(capped.token)).toMatchObject({ haltReason: "budget_exceeded", measureCapReached: true });
    });
  });
});

describe("measureEdge：O-04 の★の材料（Kernel が数えるのと同じ並びのツール呼び出し）", () => {
  it("応答の順に全部を記録する：sim に届かない呼び出し（notify・引数の誤り・付与のないツール）も入り、Intent になった書き込みだけ intent = true", async () => {
    const { edge, token, ctx } = setup({
      steps: [
        {
          parts: [
            call("r", "store", "get_inventory"),
            call("w", "supplier", "place_order", beans),
            call("bad", "supplier", "place_order", { supplier_id: "supplier-01" }),
            { type: "tool_call", id: "n", name: "notify", arguments: { title: "t", body: "b", priority: "normal" } },
            call("x", "mail", "list_inbox"),
          ],
        },
      ],
    });
    await edge.llmMessages(token, req(ctx));
    expect(edge.toolCalls()).toEqual([
      { taskId: "task-s", name: "mcp_call", action: "mcp.store.get_inventory", args: {}, intent: false },
      { taskId: "task-s", name: "mcp_call", action: "mcp.supplier.place_order", args: beans, intent: true },
      { taskId: "task-s", name: "mcp_call", action: "mcp.supplier.place_order", args: { supplier_id: "supplier-01" }, intent: false },
      { taskId: "task-s", name: "notify", action: null, args: { title: "t", body: "b", priority: "normal" }, intent: false },
      { taskId: "task-s", name: "mcp_call", action: "mcp.mail.list_inbox", args: {}, intent: false },
    ]);
  });
});
