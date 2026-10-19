// Harness のループの試験（formation-runtime.md §3.8・§6.6・§8-7・§8-36）。偽の EdgePort で流れを確かめる
import { describe, expect, it, vi } from "vitest";
import { wrapUntrusted } from "@open-team/kernel";
import { DEFAULT_MAX_TURNS, EVENTS_PER_REQUEST, FINISHED_SEND_ATTEMPTS, runTask, type RunTaskOptions } from "./harness.ts";
import { actNudgeText, buildSystemPrompt } from "./prompts.ts";
import { EdgeError } from "./types.ts";
import type {
  AssistantPart,
  ChatMessage,
  EdgePort,
  GovernanceEntry,
  LlmMessagesRequest,
  LlmMessagesResponse,
  ProgressEvent,
  TaskContext,
  ToolCallResult,
} from "./types.ts";
import { SUPPLIER_TASK_ID, inboxContext, supplierContext } from "./__fixtures__/contexts.ts";

// ---- 偽の edge ----

type LlmStep = LlmMessagesResponse | EdgeError | ((req: LlmMessagesRequest) => LlmMessagesResponse | Promise<LlmMessagesResponse>);
type ToolStep = ToolCallResult | EdgeError | (() => ToolCallResult | Promise<ToolCallResult>);

class FakeEdge implements EdgePort {
  readonly log: string[] = [];
  readonly requests: LlmMessagesRequest[] = [];
  readonly eventBatches: ProgressEvent[][] = [];
  readonly toolCallIds: string[] = [];
  readonly tokens = new Set<string>();
  /** runner が送った進捗（受け付けたかに関係なく、送った形のまま） */
  readonly sentBatches: ProgressEvent[][] = [];
  ctx: TaskContext | EdgeError;
  llm: LlmStep[];
  tools: Record<string, ToolStep[]>;
  postEventsError: EdgeError | null = null;
  /** postEvents が1回ずつ投げるエラー（先頭から使う） */
  postEventsFailures: EdgeError[] = [];
  /** rt:152「最大10件/秒/タスク。超えた分は捨て、dropped の件数だけ記録」。null は上限なし。1秒は runner の sleep で進める（tick） */
  eventsPerSecond: number | null = null;
  private windowUsed = 0;

  constructor(ctx: TaskContext | EdgeError, llm: LlmStep[], tools: Record<string, ToolStep | ToolStep[]> = {}) {
    this.ctx = ctx;
    this.llm = [...llm];
    this.tools = Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  }

  get events(): ProgressEvent[] {
    return this.eventBatches.flat();
  }

  async getTaskContext(token: string): Promise<TaskContext> {
    this.tokens.add(token);
    this.log.push("getTaskContext");
    if (this.ctx instanceof EdgeError) throw this.ctx;
    return this.ctx;
  }

  async llmMessages(token: string, req: LlmMessagesRequest): Promise<LlmMessagesResponse> {
    this.tokens.add(token);
    this.log.push("llmMessages");
    // 渡された値をそのまま残す（runner が後で書き換えても、呼んだ時点の値で確かめる）
    this.requests.push(structuredClone(req));
    const step = this.llm.shift();
    if (step === undefined) throw new Error("偽の LLM の応答が尽きた");
    if (step instanceof EdgeError) throw step;
    return typeof step === "function" ? step(req) : step;
  }

  async postEvents(token: string, events: ProgressEvent[]): Promise<{ accepted: number; dropped: number }> {
    this.tokens.add(token);
    this.log.push("postEvents");
    this.sentBatches.push(structuredClone(events));
    if (this.postEventsError) throw this.postEventsError;
    const failure = this.postEventsFailures.shift();
    if (failure) throw failure;
    const room = this.eventsPerSecond === null ? events.length : Math.max(0, this.eventsPerSecond - this.windowUsed);
    const accepted = events.slice(0, room);
    this.windowUsed += accepted.length;
    if (accepted.length > 0) this.eventBatches.push(structuredClone(accepted));
    return { accepted: accepted.length, dropped: events.length - accepted.length };
  }

  /** 時間を進める（1秒以上たてば毎秒の上限の数え直し） */
  tick(ms: number): void {
    if (ms >= 1000) this.windowUsed = 0;
  }

  async callTool(token: string, toolCallId: string): Promise<ToolCallResult> {
    this.tokens.add(token);
    this.log.push(`callTool:${toolCallId}`);
    this.toolCallIds.push(toolCallId);
    const step = this.tools[toolCallId]?.shift();
    if (step === undefined) throw new Error(`偽の callTool の結果がない：${toolCallId}`);
    if (step instanceof EdgeError) throw step;
    return typeof step === "function" ? step() : step;
  }
}

// ---- 応答を作る道具 ----

const text = (t: string): AssistantPart => ({ type: "text", text: t });
const call = (id: string, name: string, args: unknown = {}): AssistantPart => ({ type: "tool_call", id, name, arguments: args });
const gov = (toolCallId: string, decision: GovernanceEntry["decision"], reasonCode: string, extra: Partial<GovernanceEntry> = {}): GovernanceEntry => ({
  toolCallId,
  decision,
  reasonCode,
  ...extra,
});
const allow = (id: string, reasonCode = "autonomy_auto") => gov(id, "allow", reasonCode);

function resp(content: AssistantPart[], governance: GovernanceEntry[] = []): LlmMessagesResponse {
  return {
    model: "gemini-test",
    content,
    stopReason: content.some((p) => p.type === "tool_call") ? "tool_call" : "end_turn",
    usage: { inputTokens: 100, outputTokens: 20, costUsd: "0.000100" },
    governance,
    budget: { costUsd: "0.000100", stepsUsed: 1 },
  };
}

const report = (id: string, title = "報告") =>
  call(id, "submit_report", { title, body: "結論です", sources: [{ kind: "mcp", connector: "store", tool: "get_inventory" }] });

function opts(extra: Partial<RunTaskOptions> = {}): RunTaskOptions {
  return { signal: new AbortController().signal, sleep: async () => {}, ...extra };
}

function toolMessages(messages: ChatMessage[]): Array<{ toolCallId: string; name: string; result: string }> {
  return messages.flatMap((m) => (m.role === "tool" ? [m.content] : []));
}

const TOKEN = "task-token-1";

// ---- 試験 ----

describe("runTask の流れ（§3.8）", () => {
  it("HL-17・HL-05 読み取り → 書き込みの Intent → submit_report（応答の順に1つずつ、書き込みは実行しない）", async () => {
    const inventory = wrapUntrusted("mcp:store.get_inventory", '{"sku":"beans","quantity_kg":2}');
    const edge = new FakeEdge(
      supplierContext(),
      [
        // 計画：読み取り
        resp([text("在庫を確かめます"), call("c1", "mcp_call", { connector: "store", tool: "get_inventory", arguments: {} })], [
          allow("c1"),
        ]),
        // 計画の終わり（ツール呼び出しなし）→ 実行へ
        resp([text("豆が残り2kgなので20kg発注します")]),
        // 実行：書き込み → 報告
        resp(
          [
            call("c2", "mcp_call", { connector: "supplier", tool: "place_order", arguments: { supplier_id: "supplier-01" } }),
            report("c3"),
          ],
          [
            gov("c2", "approve", "approval_required", { matchedRule: "autonomy.mcp_write", intent: { intentId: "i1", status: "pending_approval" } }),
            allow("c3"),
          ],
        ),
      ],
      { c1: { kind: "text", text: inventory }, c3: { kind: "report_accepted", taskId: SUPPLIER_TASK_ID } },
    );

    const result = await runTask(edge, TOKEN, opts());

    expect(result).toEqual({ end: "report_submitted", turns: 3 });
    // 書き込み（c2）は callTool を呼ばない（A-87：Intent は Proxy で作られている）
    expect(edge.toolCallIds).toEqual(["c1", "c3"]);
    // フェーズごとの phase（§8-7：assistant は 計画=plan、実行=implement）と system
    expect(edge.requests.map((r) => r.phase)).toEqual(["plan", "plan", "implement"]);
    const ctx = supplierContext();
    expect(edge.requests[0]!.system).toBe(buildSystemPrompt(ctx, 0));
    expect(edge.requests[2]!.system).toBe(buildSystemPrompt(ctx, 1));
    expect(edge.requests[0]!.tools).toEqual(ctx.tools);
    expect(edge.requests[0]!.maxTokens).toBe(8000);
    // 読み取りの結果は囲まれたまま tool のメッセージになる
    expect(toolMessages(edge.requests[1]!.messages)).toEqual([{ toolCallId: "c1", name: "mcp_call", result: inventory }]);
    // 次のフェーズへの user のメッセージ
    const third = edge.requests[2]!.messages;
    expect(third.at(-1)).toEqual({ role: "user", content: "次のフェーズ「実行」に進んでください。" });
    // 進捗：phase_started → message → tool_called(c1) → message → phase_started → tool_called(c2)。報告の後は送らない
    expect(edge.events).toEqual([
      { type: "phase_started", payload: { phase: "計画" } },
      { type: "message", payload: { text: "在庫を確かめます" } },
      { type: "tool_called", payload: { toolCallId: "c1", name: "mcp_call", resultSummary: inventory } },
      { type: "message", payload: { text: "豆が残り2kgなので20kg発注します" } },
      { type: "phase_started", payload: { phase: "実行" } },
      { type: "tool_called", payload: { toolCallId: "c2", name: "mcp_call", resultSummary: '{"intentId":"i1","status":"pending_approval"}' } },
    ]);
    // c2 の進捗は c3 の callTool の前に送る（報告が通るとトークンが失効する：si:171）
    expect(edge.log.lastIndexOf("postEvents")).toBeLessThan(edge.log.indexOf("callTool:c3"));
    expect(edge.log.at(-1)).toBe("callTool:c3");
  });

  it("HL-05・A-87 書き込みの結果は {intentId, status} だけを tool の結果として返し、結果を待たずに続ける", async () => {
    const edge = new FakeEdge(supplierContext(), [
      resp([call("w1", "mcp_call", { connector: "supplier", tool: "place_order", arguments: {} })], [
        gov("w1", "approve", "approval_required", { intent: { intentId: "i9", status: "pending_approval" } }),
      ]),
      resp([call("w2", "mcp_call", { connector: "bank", tool: "register_payee", arguments: {} })], [
        gov("w2", "deny", "not_granted", { intent: { intentId: "i10", status: "denied" } }),
      ]),
      resp([call("w3", "mcp_call", { connector: "supplier", tool: "place_order", arguments: {} })], [
        gov("w3", "allow", "rule_matched", { intent: { intentId: "i11", status: "accepted" } }),
      ]),
      resp([report("r")], [allow("r")]),
    ], { r: { kind: "report_accepted", taskId: SUPPLIER_TASK_ID } });

    await runTask(edge, TOKEN, opts());

    expect(edge.toolCallIds).toEqual(["r"]);
    expect(toolMessages(edge.requests[3]!.messages)).toEqual([
      { toolCallId: "w1", name: "mcp_call", result: '{"intentId":"i9","status":"pending_approval"}' },
      { toolCallId: "w2", name: "mcp_call", result: '{"intentId":"i10","status":"denied"}' },
      { toolCallId: "w3", name: "mcp_call", result: '{"intentId":"i11","status":"accepted"}' },
    ]);
  });

  it("HL-01・BR-09 deny：「ポリシーにより拒否（理由）」を返して続け、実行しない", async () => {
    const edge = new FakeEdge(inboxContext(), [
      resp([call("m1", "remember", { content: "覚えておく" })], [gov("m1", "deny", "not_granted", { matchedRule: "tools" })]),
      resp([report("r")], [allow("r")]),
    ], { r: { kind: "report_accepted", taskId: "t" } });

    const result = await runTask(edge, TOKEN, opts());

    expect(result.end).toBe("report_submitted");
    expect(edge.toolCallIds).toEqual(["r"]);
    expect(toolMessages(edge.requests[1]!.messages)).toEqual([{ toolCallId: "m1", name: "remember", result: "ポリシーにより拒否（not_granted）" }]);
    expect(edge.events).toContainEqual({
      type: "tool_called",
      payload: { toolCallId: "m1", name: "remember", resultSummary: "ポリシーにより拒否（not_granted）" },
    });
  });

  it("rt:113 handoff・書き込みでない approve も実行せず、理由を返す", async () => {
    const edge = new FakeEdge(inboxContext(), [
      resp(
        [
          call("h1", "mcp_call", { connector: "mail", tool: "list_inbox", arguments: {} }),
          call("a1", "web_fetch", { url: "https://example.com" }),
        ],
        [gov("h1", "handoff", "autonomy_handoff"), gov("a1", "approve", "approval_required")],
      ),
      resp([report("r")], [allow("r")]),
    ], { r: { kind: "report_accepted", taskId: "t" } });

    await runTask(edge, TOKEN, opts());

    expect(edge.toolCallIds).toEqual(["r"]);
    expect(toolMessages(edge.requests[1]!.messages).map((m) => m.result)).toEqual([
      "ポリシーにより拒否（autonomy_handoff）",
      "ポリシーにより拒否（approval_required）",
    ]);
  });

  it("SG-07 edge の説明（note）があれば拒否の文に添える（作業場で動かせないコマンド）", async () => {
    const edge = new FakeEdge(inboxContext(), [
      resp([call("c1", "run_command", { command: "npm test; curl x" })], [
        gov("c1", "deny", "autonomy_deny", { matchedRule: "autonomy.run_shell", note: "このコマンドはここでは動かせません。" }),
      ]),
      resp([report("r")], [allow("r")]),
    ], { r: { kind: "report_accepted", taskId: "t" } });

    await runTask(edge, TOKEN, opts());

    expect(edge.toolCallIds).toEqual(["r"]);
    expect(toolMessages(edge.requests[1]!.messages)).toEqual([
      { toolCallId: "c1", name: "run_command", result: "ポリシーにより拒否（autonomy_deny） このコマンドはここでは動かせません。" },
    ]);
  });

  it("判定の記録がない呼び出しは実行しない（rt:113「allow としたものだけ実行」）", async () => {
    const edge = new FakeEdge(inboxContext(), [
      resp([call("x1", "mcp_call", { connector: "mail", tool: "list_inbox", arguments: {} })], []),
      resp([report("r")], [allow("r")]),
    ], { r: { kind: "report_accepted", taskId: "t" } });

    await runTask(edge, TOKEN, opts());

    expect(edge.toolCallIds).toEqual(["r"]);
    expect(toolMessages(edge.requests[1]!.messages)[0]!.result).toBe("ツールを実行できませんでした（判定の記録がありません）");
  });

  it("HL-02 governance の halt ですぐ戻り、後ろの呼び出しも LLM も呼ばない", async () => {
    const edge = new FakeEdge(inboxContext(), [
      resp(
        [call("c1", "mcp_call", { connector: "mail", tool: "list_inbox", arguments: {} }), call("c2", "notify", {})],
        [gov("c1", "halt", "breaker_tripped", { matchedRule: "breakers.same_action_repeat" }), allow("c2")],
      ),
      resp([text("ここには来ない")]),
    ]);

    const result = await runTask(edge, TOKEN, opts());

    expect(result).toEqual({ end: "halted", turns: 1, haltReason: "breaker_tripped" });
    expect(edge.toolCallIds).toEqual([]);
    expect(edge.requests).toHaveLength(1);
  });

  it("HL-02 読み取りの後に halt：前の呼び出しは実行し、halt で戻る", async () => {
    const edge = new FakeEdge(inboxContext(), [
      resp(
        [call("c1", "mcp_call", { connector: "mail", tool: "list_inbox", arguments: {} }), call("c2", "mcp_call", {})],
        [allow("c1"), gov("c2", "halt", "budget_exceeded")],
      ),
    ], { c1: { kind: "text", text: wrapUntrusted("mcp:mail.list_inbox", "メール") } });

    const result = await runTask(edge, TOKEN, opts());

    expect(result.end).toBe("halted");
    expect(edge.toolCallIds).toEqual(["c1"]);
  });

  it("HL-03 finish(no_change)：finished を送って戻る（タスクの状態は edge が決める）", async () => {
    const edge = new FakeEdge(inboxContext(), [
      resp([text("新しいメールはありません"), call("f1", "finish", { outcome: "no_change", reason: "変更なし" }), report("r")], [
        allow("f1", "not_gated"),
        allow("r"),
      ]),
    ]);

    const result = await runTask(edge, TOKEN, opts());

    expect(result).toEqual({ end: "finished", turns: 1, finished: { outcome: "no_change", reason: "変更なし", by: "agent" } });
    expect(edge.toolCallIds).toEqual([]);
    expect(edge.events.at(-1)).toEqual({ type: "finished", payload: { outcome: "no_change", reason: "変更なし" } });
    expect(edge.events).toContainEqual({ type: "message", payload: { text: "新しいメールはありません" } });
  });

  it("finish の知らない outcome・空の理由は unable と決まった文にする（edge の検証で落とさない）", async () => {
    const edge = new FakeEdge(inboxContext(), [resp([call("f1", "finish", { outcome: "done", reason: " " })], [allow("f1")])]);

    const result = await runTask(edge, TOKEN, opts());

    expect(result.finished).toEqual({ outcome: "unable", reason: "理由が書かれていません", by: "agent" });
    expect(edge.events.at(-1)).toEqual({ type: "finished", payload: { outcome: "unable", reason: "理由が書かれていません" } });
  });

  it("finish でも governance が halt なら halt を優先する（§3.8 の判定の順）", async () => {
    const edge = new FakeEdge(inboxContext(), [resp([call("f1", "finish", { outcome: "unable", reason: "x" })], [gov("f1", "halt", "kill_switch")])]);

    const result = await runTask(edge, TOKEN, opts());

    expect(result.end).toBe("halted");
    expect(edge.events.some((e) => e.type === "finished")).toBe(false);
  });

  it("§8-36 submit_report が通ったら、後ろのツール呼び出しは捨てる", async () => {
    const edge = new FakeEdge(supplierContext(), [
      resp([report("r1"), call("c9", "mcp_call", { connector: "supplier", tool: "place_order", arguments: {} }), call("n1", "notify", {})], [
        allow("r1"),
        gov("c9", "approve", "approval_required", { intent: { intentId: "i1", status: "pending_approval" } }),
        allow("n1"),
      ]),
    ], { r1: { kind: "report_accepted", taskId: SUPPLIER_TASK_ID } });

    const result = await runTask(edge, TOKEN, opts());

    expect(result.end).toBe("report_submitted");
    expect(edge.toolCallIds).toEqual(["r1"]);
    expect(edge.events.some((e) => e.type === "tool_called")).toBe(false);
  });
});

describe("フェーズの進め方（§8-7）", () => {
  it("HL-15 ツール呼び出しのない応答で次のフェーズへ（phase_started・system・phase が替わる）", async () => {
    const edge = new FakeEdge(inboxContext(), [
      resp([call("s1", "web_search", { query: "q", max_results: 3 })], [allow("s1")]),
      resp([text("調べました")]),
      resp([text("整理しました")]),
      resp([report("r")], [allow("r")]),
    ], { s1: { kind: "text", text: "結果" }, r: { kind: "report_accepted", taskId: "t" } });

    const result = await runTask(edge, TOKEN, opts());

    expect(result).toEqual({ end: "report_submitted", turns: 4 });
    expect(edge.requests.map((r) => r.phase)).toEqual(["investigate", "investigate", "plan", "report"]);
    expect(edge.requests[2]!.system).toContain("いまは「整理」のフェーズです（2/3）。");
    expect(edge.requests[3]!.system).toContain("いまは「要約」のフェーズです（3/3）。");
    expect(edge.requests[3]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user", "assistant", "user"]);
    expect(edge.requests[3]!.messages.at(-1)).toEqual({ role: "user", content: "次のフェーズ「要約」に進んでください。" });
    expect(edge.events.filter((e) => e.type === "phase_started")).toEqual([
      { type: "phase_started", payload: { phase: "調査" } },
      { type: "phase_started", payload: { phase: "整理" } },
      { type: "phase_started", payload: { phase: "要約" } },
    ]);
  });

  it("HL-16 最後のフェーズで報告がないと1回促し、2回目も報告がなければ finished(unable, 報告がありませんでした)", async () => {
    const edge = new FakeEdge(supplierContext(), [resp([text("計画です")]), resp([text("ツールは要りません")]), resp([text("終わりました")]), resp([text("以上です")])]);

    const result = await runTask(edge, TOKEN, opts());

    expect(result).toEqual({ end: "finished", turns: 4, finished: { outcome: "unable", reason: "報告がありませんでした", by: "runner" } });
    expect(edge.requests[3]!.messages.at(-1)).toEqual({
      role: "user",
      content: "まだ報告が出ていません。submit_report で報告を出してください。続けられない場合は、finish で理由を書いて終えてください。",
    });
    expect(edge.events.at(-1)).toEqual({ type: "finished", payload: { outcome: "unable", reason: "報告がありませんでした" } });
  });

  it("HL-16 促したあとに報告が出れば、そのまま終わる", async () => {
    const edge = new FakeEdge(supplierContext(), [
      resp([text("計画です")]),
      resp([text("ツールは要りません")]),
      resp([text("終わりました")]),
      resp([report("r")], [allow("r")]),
    ], { r: { kind: "report_accepted", taskId: SUPPLIER_TASK_ID } });

    expect((await runTask(edge, TOKEN, opts())).end).toBe("report_submitted");
  });

  it("最初のフェーズをツールを使わずに終えようとすると1回だけ手を動かすよう促し、2回目は次のフェーズへ進む", async () => {
    const edge = new FakeEdge(inboxContext(), [
      resp([text("知っている範囲で答えます")]),
      resp([text("ツールは要りません")]),
      resp([text("整理しました")]),
      resp([report("r")], [allow("r")]),
    ], { r: { kind: "report_accepted", taskId: "t" } });

    const result = await runTask(edge, TOKEN, opts());

    expect(result).toEqual({ end: "report_submitted", turns: 4 });
    expect(edge.requests.map((r) => r.phase)).toEqual(["investigate", "investigate", "plan", "report"]);
    expect(edge.requests[1]!.messages.at(-1)).toEqual({ role: "user", content: actNudgeText() });
    expect(edge.events.filter((e) => e.type === "phase_started")).toHaveLength(3);
  });

  it("手を動かすツールがない担当（まとめ役など）には、ツールを使うよう促さない", async () => {
    const ctx = inboxContext();
    ctx.tools = ctx.tools.filter((t) => !["mcp_call", "web_search", "web_fetch"].includes(t.name));
    const edge = new FakeEdge(ctx, [resp([text("まとめました")]), resp([text("整理しました")]), resp([report("r")], [allow("r")])], {
      r: { kind: "report_accepted", taskId: "t" },
    });

    const result = await runTask(edge, TOKEN, opts());

    expect(result).toEqual({ end: "report_submitted", turns: 3 });
    expect(edge.requests.map((r) => r.phase)).toEqual(["investigate", "plan", "report"]);
  });

  it("空の応答（テキストもツール呼び出しもない）は assistant のメッセージにせず、次のフェーズへ進む", async () => {
    const edge = new FakeEdge(supplierContext(), [resp([]), resp([report("r")], [allow("r")])], {
      r: { kind: "report_accepted", taskId: SUPPLIER_TASK_ID },
    });

    await runTask(edge, TOKEN, opts());

    expect(edge.requests[1]!.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(edge.events.some((e) => e.type === "message")).toBe(false);
  });

  it("フェーズがない文脈は finished(unable) で終える", async () => {
    const ctx = inboxContext();
    ctx.phases = [];
    const edge = new FakeEdge(ctx, []);

    const result = await runTask(edge, TOKEN, opts());

    expect(result.finished).toEqual({ outcome: "unable", reason: "タスクにフェーズがありません", by: "runner" });
    expect(edge.requests).toHaveLength(0);
  });
});

describe("edge のエラー", () => {
  it("RATE_LIMITED は retryAfterSec だけ待ってやり直す（待ちは注入できる）", async () => {
    const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
    const edge = new FakeEdge(inboxContext(), [
      new EdgeError("RATE_LIMITED", undefined, 7),
      new EdgeError("RATE_LIMITED", undefined, null),
      new EdgeError("RATE_LIMITED", undefined, 3600),
      new EdgeError("RATE_LIMITED", undefined, 0),
      resp([report("r")], [allow("r")]),
    ], { r: { kind: "report_accepted", taskId: "t" } });

    const result = await runTask(edge, TOKEN, opts({ sleep }));

    expect(result).toEqual({ end: "report_submitted", turns: 1 });
    // null は1秒、上限は60秒、0 は1秒（LLM Proxy の制限は1分あたり：si:106）
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([7000, 1000, 60_000, 1000]);
    expect(edge.requests).toHaveLength(5);
  });

  it("RATE_LIMITED の待ちの間に止めたら、やり直さずに戻る", async () => {
    const controller = new AbortController();
    const edge = new FakeEdge(inboxContext(), [new EdgeError("RATE_LIMITED", undefined, 30), resp([text("来ない")])]);
    const sleep = async () => {
      controller.abort();
    };

    const result = await runTask(edge, TOKEN, { signal: controller.signal, sleep });

    expect(result.end).toBe("aborted");
    expect(edge.requests).toHaveLength(1);
  });

  it("既定の待ちは signal で切れる", async () => {
    const controller = new AbortController();
    const edge = new FakeEdge(inboxContext(), [new EdgeError("RATE_LIMITED", undefined, 60)]);
    const started = performance.now();
    const pending = runTask(edge, TOKEN, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const result = await pending;

    expect(result.end).toBe("aborted");
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("si:43 getTaskContext の TASK_HALTED・UNAUTHORIZED は何もせず戻る", async () => {
    const halted = new FakeEdge(new EdgeError("TASK_HALTED", { haltReason: "kill_switch" }), []);
    expect(await runTask(halted, TOKEN, opts())).toEqual({ end: "halted", turns: 0, haltReason: "kill_switch" });
    expect(halted.log).toEqual(["getTaskContext"]);

    const unauthorized = new FakeEdge(new EdgeError("UNAUTHORIZED"), []);
    expect(await runTask(unauthorized, TOKEN, opts())).toEqual({ end: "unauthorized", turns: 0 });
    expect(unauthorized.log).toEqual(["getTaskContext"]);
  });

  it("getTaskContext のそれ以外の失敗は呼び出し側に投げる", async () => {
    const edge = new FakeEdge(new EdgeError("VALIDATION_ERROR"), []);
    await expect(runTask(edge, TOKEN, opts())).rejects.toThrow("VALIDATION_ERROR");
  });

  it("rt:113 llmMessages の TASK_HALTED はすぐ戻る（details.haltReason を残す）", async () => {
    const edge = new FakeEdge(inboxContext(), [new EdgeError("TASK_HALTED", { haltReason: "budget_exceeded" })]);

    const result = await runTask(edge, TOKEN, opts());

    expect(result).toEqual({ end: "halted", turns: 0, haltReason: "budget_exceeded" });
    expect(edge.events.some((e) => e.type === "finished")).toBe(false);
  });

  it("HL-13 LLM_UPSTREAM_ERROR は戻る（finished を送らない。edge が failed(llm_unavailable) にする）", async () => {
    const edge = new FakeEdge(inboxContext(), [new EdgeError("LLM_UPSTREAM_ERROR")]);

    const result = await runTask(edge, TOKEN, opts());

    expect(result).toEqual({ end: "llm_unavailable", turns: 0 });
    expect(edge.events.some((e) => e.type === "finished")).toBe(false);
  });

  it("HL-22 llmMessages の VALIDATION_ERROR（1MB を超えたなど）は finished(unable) で終える", async () => {
    const edge = new FakeEdge(inboxContext(), [new EdgeError("VALIDATION_ERROR", { field: "messages" })]);

    const result = await runTask(edge, TOKEN, opts());

    expect(result.finished).toEqual({ outcome: "unable", reason: "LLM の呼び出しが受け付けられませんでした（VALIDATION_ERROR）", by: "runner" });
    expect(edge.events.at(-1)?.type).toBe("finished");
  });

  it("callTool の halted で戻る", async () => {
    const edge = new FakeEdge(inboxContext(), [resp([call("c1", "mcp_call", {})], [allow("c1")])], {
      c1: { kind: "halted", reasonCode: "kill_switch" },
    });

    expect(await runTask(edge, TOKEN, opts())).toEqual({ end: "halted", turns: 1, haltReason: "kill_switch" });
  });

  it("HL-04 callTool の REPORT_ALREADY_SUBMITTED は戻る", async () => {
    const edge = new FakeEdge(inboxContext(), [resp([report("r")], [allow("r")])], { r: new EdgeError("REPORT_ALREADY_SUBMITTED") });

    expect((await runTask(edge, TOKEN, opts())).end).toBe("report_submitted");
  });

  it("callTool の TASK_HALTED・UNAUTHORIZED は戻る", async () => {
    const a = new FakeEdge(inboxContext(), [resp([call("c1", "mcp_call", {})], [allow("c1")])], { c1: new EdgeError("TASK_HALTED") });
    expect((await runTask(a, TOKEN, opts())).end).toBe("halted");
    const b = new FakeEdge(inboxContext(), [resp([call("c1", "mcp_call", {})], [allow("c1")])], { c1: new EdgeError("UNAUTHORIZED") });
    expect((await runTask(b, TOKEN, opts())).end).toBe("unauthorized");
  });

  it("HL-18 callTool の TOOL_CALL_NOT_ALLOWED・VALIDATION_ERROR はツールのエラーとして返して続ける", async () => {
    const edge = new FakeEdge(supplierContext(), [
      resp([call("c1", "mcp_call", {}), report("r1")], [allow("c1"), allow("r1")]),
      resp([report("r2")], [allow("r2")]),
    ], {
      c1: new EdgeError("TOOL_CALL_NOT_ALLOWED"),
      r1: new EdgeError("VALIDATION_ERROR", { path: "title" }),
      r2: { kind: "report_accepted", taskId: SUPPLIER_TASK_ID },
    });

    const result = await runTask(edge, TOKEN, opts());

    expect(result.end).toBe("report_submitted");
    expect(toolMessages(edge.requests[1]!.messages).map((m) => m.result)).toEqual([
      "ツールを実行できませんでした（TOOL_CALL_NOT_ALLOWED）",
      "ツールを実行できませんでした（VALIDATION_ERROR）",
    ]);
  });

  it("callTool の RATE_LIMITED は待って同じ呼び出しをやり直す", async () => {
    const sleep = vi.fn(async () => {});
    const edge = new FakeEdge(inboxContext(), [resp([report("r")], [allow("r")])], {
      r: [new EdgeError("RATE_LIMITED", undefined, 2), { kind: "report_accepted", taskId: "t" }],
    });

    expect((await runTask(edge, TOKEN, opts({ sleep }))).end).toBe("report_submitted");
    expect(edge.toolCallIds).toEqual(["r", "r"]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("callTool の denied はポリシーの拒否として返す（Web の url_not_observed など）", async () => {
    const edge = new FakeEdge(inboxContext(), [
      resp([call("w1", "web_fetch", { url: "https://example.com/x" })], [allow("w1")]),
      resp([report("r")], [allow("r")]),
    ], { w1: { kind: "denied", reasonCode: "url_not_observed" }, r: { kind: "report_accepted", taskId: "t" } });

    await runTask(edge, TOKEN, opts());

    expect(toolMessages(edge.requests[1]!.messages)[0]!.result).toBe("ポリシーにより拒否（url_not_observed）");
  });

  it("edge のエラーでない例外は呼び出し側に投げる", async () => {
    const edge = new FakeEdge(inboxContext(), [
      () => {
        throw new Error("DB が落ちた");
      },
    ]);
    await expect(runTask(edge, TOKEN, opts())).rejects.toThrow("DB が落ちた");
  });

  it("名前とコードが同じなら、別の複製の EdgeError でも見分ける", async () => {
    const foreign = Object.assign(new Error("TASK_HALTED"), { name: "EdgeError", code: "TASK_HALTED", details: null, retryAfterSec: null });
    const edge = new FakeEdge(inboxContext(), [
      () => {
        throw foreign;
      },
    ]);
    expect((await runTask(edge, TOKEN, opts())).end).toBe("halted");
  });
});

describe("進捗（API-038）", () => {
  it("si:133 1回に20件までに分けて送る", async () => {
    const calls = Array.from({ length: 25 }, (_, i) => call(`d${i}`, "remember", {}));
    const edge = new FakeEdge(inboxContext(), [
      resp(calls, calls.map((c) => gov((c as { id: string }).id, "deny", "not_granted"))),
      resp([report("r")], [allow("r")]),
    ], { r: { kind: "report_accepted", taskId: "t" } });

    await runTask(edge, TOKEN, opts());

    // 1回目：phase_started。2回目以降：tool_called 25件を 20 + 5
    expect(edge.eventBatches.map((b) => b.length)).toEqual([1, EVENTS_PER_REQUEST, 5]);
    expect(edge.eventBatches.every((b) => b.length <= EVENTS_PER_REQUEST)).toBe(true);
  });

  it("postEvents の TASK_HALTED で止める", async () => {
    const edge = new FakeEdge(inboxContext(), [resp([text("x")])]);
    edge.postEventsError = new EdgeError("TASK_HALTED", { haltReason: "kill_switch" });

    const result = await runTask(edge, TOKEN, opts());

    expect(result).toEqual({ end: "halted", turns: 0, haltReason: "kill_switch" });
    expect(edge.requests).toHaveLength(0);
  });

  it("postEvents のそれ以外の edge のエラーは取りこぼしとして続ける", async () => {
    const edge = new FakeEdge(inboxContext(), [resp([report("r")], [allow("r")])], { r: { kind: "report_accepted", taskId: "t" } });
    edge.postEventsError = new EdgeError("VALIDATION_ERROR");

    expect((await runTask(edge, TOKEN, opts())).end).toBe("report_submitted");
  });

  it("テキストは message の進捗にする（空白だけのテキストは送らない）・署名はそのまま次の呼び出しに返す", async () => {
    const parts: AssistantPart[] = [
      { type: "text", text: "  ", signature: "sig-a" },
      { type: "text", text: "読みます" },
      { type: "tool_call", id: "c1", name: "mcp_call", arguments: {}, signature: "sig-b" },
    ];
    const edge = new FakeEdge(inboxContext(), [resp(parts, [allow("c1")]), resp([report("r")], [allow("r")])], {
      c1: { kind: "text", text: "結果" },
      r: { kind: "report_accepted", taskId: "t" },
    });

    await runTask(edge, TOKEN, opts());

    expect(edge.events.filter((e) => e.type === "message")).toEqual([{ type: "message", payload: { text: "読みます" } }]);
    expect(edge.requests[1]!.messages[1]).toEqual({ role: "assistant", content: parts });
  });

  it("si:136 tool_called の resultSummary は500文字まで", async () => {
    const long = "あ".repeat(1200);
    const edge = new FakeEdge(inboxContext(), [resp([call("c1", "mcp_call", {})], [allow("c1")]), resp([report("r")], [allow("r")])], {
      c1: { kind: "text", text: long },
      r: { kind: "report_accepted", taskId: "t" },
    });

    await runTask(edge, TOKEN, opts());

    const summary = edge.events.find((e) => e.type === "tool_called");
    expect(summary?.type === "tool_called" && Array.from(summary.payload.resultSummary).length).toBe(500);
    // LLM には全文を返す
    expect(toolMessages(edge.requests[1]!.messages)[0]!.result).toBe(long);
  });
});

describe("finished の届け方（§3.8 の postEvents([finished])・rt:152 の毎秒の上限）", () => {
  const denied = (n: number) => Array.from({ length: n }, (_, i) => call(`d${i}`, "remember", {}));
  const deniedGov = (n: number) => Array.from({ length: n }, (_, i) => gov(`d${i}`, "deny", "not_granted"));

  it("§3.8 finish：先にほかの進捗を送り、finished は単独の postEvents([finished]) で送る", async () => {
    const edge = new FakeEdge(inboxContext(), [
      resp([text("続けられません"), call("d0", "remember", {}), call("f1", "finish", { outcome: "unable", reason: "読めない" })], [
        gov("d0", "deny", "not_granted"),
        allow("f1", "not_gated"),
      ]),
    ]);

    await runTask(edge, TOKEN, opts());

    expect(edge.sentBatches.at(-1)).toEqual([{ type: "finished", payload: { outcome: "unable", reason: "読めない" } }]);
    expect(edge.sentBatches.at(-2)?.map((e) => e.type)).toEqual(["message", "tool_called"]);
  });

  it("rt:152 毎秒の上限で finished が捨てられたら、1秒待って送り直す（届かないとタスクが sandbox_lost になる）", async () => {
    const edge = new FakeEdge(inboxContext(), [
      resp([...denied(12), call("f1", "finish", { outcome: "unable", reason: "続けられない" })], [...deniedGov(12), allow("f1")]),
    ]);
    edge.eventsPerSecond = 10;
    const sleeps: number[] = [];

    const result = await runTask(edge, TOKEN, opts({ sleep: async (ms) => void (sleeps.push(ms), edge.tick(ms)) }));

    expect(result).toEqual({ end: "finished", turns: 1, finished: { outcome: "unable", reason: "続けられない", by: "agent" } });
    expect(edge.events.filter((e) => e.type === "finished")).toEqual([{ type: "finished", payload: { outcome: "unable", reason: "続けられない" } }]);
    expect(sleeps).toEqual([1000]);
  });

  it("rt:152 runner が代わりに送る finished（報告なし2回）も単独で送り、捨てられたら送り直す", async () => {
    const edge = new FakeEdge(supplierContext(), [resp([text("計画です")]), resp([text("ツールは要りません")]), resp([text("終わりました")]), resp([...denied(11)], deniedGov(11)), resp([text("以上です")])]);
    edge.eventsPerSecond = 10;

    const result = await runTask(edge, TOKEN, opts({ sleep: async (ms) => edge.tick(ms) }));

    expect(result.finished).toEqual({ outcome: "unable", reason: "報告がありませんでした", by: "runner" });
    expect(edge.sentBatches.at(-1)).toEqual([{ type: "finished", payload: { outcome: "unable", reason: "報告がありませんでした" } }]);
    expect(edge.events.at(-1)).toEqual({ type: "finished", payload: { outcome: "unable", reason: "報告がありませんでした" } });
  });

  it("finished が RATE_LIMITED で断られたら retryAfterSec だけ待って送り直す", async () => {
    const edge = new FakeEdge(inboxContext(), [resp([call("f1", "finish", { outcome: "no_change", reason: "なし" })], [allow("f1")])]);
    const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});

    // 1回目（phase_started）は通し、finished の1回目を断る
    const original = edge.postEvents.bind(edge);
    let n = 0;
    edge.postEvents = async (token, events) => {
      n += 1;
      if (n === 2) {
        edge.sentBatches.push(structuredClone(events));
        throw new EdgeError("RATE_LIMITED", undefined, 2);
      }
      return original(token, events);
    };

    const result = await runTask(edge, TOKEN, opts({ sleep }));

    expect(result.end).toBe("finished");
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000]);
    expect(edge.events.at(-1)).toEqual({ type: "finished", payload: { outcome: "no_change", reason: "なし" } });
  });

  it("finished がずっと捨てられても、送り直しは上限の回数で止めて戻る（待ち続けない）", async () => {
    const edge = new FakeEdge(inboxContext(), [resp([call("f1", "finish", { outcome: "unable", reason: "x" })], [allow("f1")])]);
    edge.eventsPerSecond = 1; // phase_started で使い切る。tick しないので数え直さない
    const sleep = vi.fn(async () => {});

    const result = await runTask(edge, TOKEN, opts({ sleep }));

    expect(result.end).toBe("finished");
    const finishedSends = edge.sentBatches.filter((b) => b.some((e) => e.type === "finished"));
    expect(finishedSends).toHaveLength(FINISHED_SEND_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(FINISHED_SEND_ATTEMPTS - 1);
  });

  it("finished の VALIDATION_ERROR は送り直さない（同じものは通らない）。UNAUTHORIZED・TASK_HALTED は止まる", async () => {
    const a = new FakeEdge(inboxContext(), [resp([call("f1", "finish", { outcome: "unable", reason: "x" })], [allow("f1")])]);
    const sleepA = vi.fn(async () => {});
    const originalA = a.postEvents.bind(a);
    a.postEvents = async (token, events) => {
      if (events.some((e) => e.type === "finished")) {
        a.sentBatches.push(structuredClone(events));
        throw new EdgeError("VALIDATION_ERROR");
      }
      return originalA(token, events);
    };
    expect((await runTask(a, TOKEN, opts({ sleep: sleepA }))).end).toBe("finished");
    expect(a.sentBatches.filter((b) => b.some((e) => e.type === "finished"))).toHaveLength(1);
    expect(sleepA).not.toHaveBeenCalled();

    const b = new FakeEdge(inboxContext(), [resp([call("f1", "finish", { outcome: "unable", reason: "x" })], [allow("f1")])]);
    const originalB = b.postEvents.bind(b);
    b.postEvents = async (token, events) => {
      if (events.some((e) => e.type === "finished")) throw new EdgeError("TASK_HALTED", { haltReason: "kill_switch" });
      return originalB(token, events);
    };
    expect(await runTask(b, TOKEN, opts())).toEqual({ end: "halted", turns: 1, haltReason: "kill_switch" });
  });
});

describe("上限・停止・状態", () => {
  it("maxTurns：上限に達したら finished(unable) を送って終える", async () => {
    let n = 0;
    const reading = () => resp([call(`c${(n += 1)}`, "mcp_call", {})], []);
    const edge = new FakeEdge(inboxContext(), [reading(), reading(), reading()]);

    const result = await runTask(edge, TOKEN, opts({ maxTurns: 2 }));

    expect(result).toEqual({ end: "finished", turns: 2, finished: { outcome: "unable", reason: "繰り返しの上限（2回）に達しました", by: "runner" } });
    expect(edge.requests).toHaveLength(2);
  });

  it("maxTurns の既定は Hard Ceiling の max_steps（200）と同じ", () => {
    expect(DEFAULT_MAX_TURNS).toBe(200);
  });

  it("始める前に止まっていれば、edge を呼ばずに戻る", async () => {
    const controller = new AbortController();
    controller.abort();
    const edge = new FakeEdge(inboxContext(), []);

    expect(await runTask(edge, TOKEN, { signal: controller.signal })).toEqual({ end: "aborted", turns: 0 });
    expect(edge.log).toEqual([]);
  });

  it("ツールの実行中に止めたら、次の edge の呼び出しの前に戻る", async () => {
    const controller = new AbortController();
    const edge = new FakeEdge(inboxContext(), [
      resp([call("c1", "mcp_call", {}), call("c2", "mcp_call", {})], [allow("c1"), allow("c2")]),
      resp([text("来ない")]),
    ], {
      c1: () => {
        controller.abort();
        return { kind: "text", text: "結果" };
      },
      c2: { kind: "text", text: "来ない" },
    });

    const result = await runTask(edge, TOKEN, { signal: controller.signal, sleep: async () => {} });

    expect(result.end).toBe("aborted");
    expect(edge.toolCallIds).toEqual(["c1"]);
    expect(edge.requests).toHaveLength(1);
  });

  it("ADR-015 isDryRun・runKind で経路を変えない（同じ応答なら edge への呼び出しも中身も同じ）", async () => {
    const script = () => [
      resp([call("c1", "mcp_call", { connector: "store", tool: "get_inventory", arguments: {} })], [allow("c1")]),
      resp([text("計画")]),
      resp([call("c2", "mcp_call", {}), report("r")], [
        gov("c2", "approve", "approval_required", { intent: { intentId: "i1", status: "pending_approval" } }),
        allow("r"),
      ]),
    ];
    const tools = () => ({ c1: { kind: "text", text: "在庫" } as ToolCallResult, r: { kind: "report_accepted", taskId: "t" } as ToolCallResult });
    const live = new FakeEdge(supplierContext(), script(), tools());
    const rehearsalCtx = supplierContext();
    rehearsalCtx.isDryRun = true;
    rehearsalCtx.runKind = "rehearsal";
    const rehearsal = new FakeEdge(rehearsalCtx, script(), tools());

    await runTask(live, TOKEN, opts());
    await runTask(rehearsal, TOKEN, opts());

    expect(rehearsal.log).toEqual(live.log);
    expect(rehearsal.requests).toEqual(live.requests);
    expect(rehearsal.events).toEqual(live.events);
  });

  it("BD-05 2つのタスクを同時に動かしても状態が混ざらない（タスクごとのトークン・会話）", async () => {
    const slow = (ms: number, r: LlmMessagesResponse) => async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return r;
    };
    const a = new FakeEdge(inboxContext(), [
      slow(15, resp([call("a1", "mcp_call", {})], [allow("a1")])),
      slow(1, resp([report("ra")], [allow("ra")])),
    ], { a1: { kind: "text", text: "A の結果" }, ra: { kind: "report_accepted", taskId: "A" } });
    const b = new FakeEdge(supplierContext(), [
      slow(1, resp([call("b1", "mcp_call", {})], [allow("b1")])),
      slow(15, resp([report("rb")], [allow("rb")])),
    ], { b1: { kind: "text", text: "B の結果" }, rb: { kind: "report_accepted", taskId: "B" } });

    const [ra, rb] = await Promise.all([runTask(a, "token-a", opts()), runTask(b, "token-b", opts())]);

    expect(ra.end).toBe("report_submitted");
    expect(rb.end).toBe("report_submitted");
    expect([...a.tokens]).toEqual(["token-a"]);
    expect([...b.tokens]).toEqual(["token-b"]);
    expect(toolMessages(a.requests[1]!.messages)).toEqual([{ toolCallId: "a1", name: "mcp_call", result: "A の結果" }]);
    expect(toolMessages(b.requests[1]!.messages)).toEqual([{ toolCallId: "b1", name: "mcp_call", result: "B の結果" }]);
    expect(a.requests[0]!.system).toContain("「受信箱係」");
    expect(b.requests[0]!.system).toContain("「仕入れ係」");
  });

  it("毎回の llmMessages には、その時点の会話の写しを渡す（edge が持っていても後から変わらない）", async () => {
    const seen: ChatMessage[][] = [];
    const edge = new FakeEdge(inboxContext(), [
      (req) => {
        seen.push(req.messages);
        return resp([call("c1", "mcp_call", {})], [allow("c1")]);
      },
      (req) => {
        seen.push(req.messages);
        return resp([report("r")], [allow("r")]);
      },
    ], { c1: { kind: "text", text: "結果" }, r: { kind: "report_accepted", taskId: "t" } });

    await runTask(edge, TOKEN, opts());

    expect(seen[0]).toHaveLength(1);
    expect(seen[1]).toHaveLength(3);
  });
});
