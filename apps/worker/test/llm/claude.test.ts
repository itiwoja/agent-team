// Claude の LlmClient（src/llm/claude.ts）：送る形（道具・構造化出力・思考を返さない・temperature を送らない・代わりのモデル）と、
// 受け取った stream の読み方（文・道具の呼び出し・思考を捨てる・費用）を、偽の fetch で確かめる
import type { LlmRequest } from "@open-team/llm";
import { describe, expect, it } from "vitest";
import { CLAUDE_PRICES, ClaudeClient, claudeJsonSchema } from "../../src/llm/claude.ts";

type Sent = { url: string; headers: Headers; body: Record<string, unknown> };

/** Claude の stream（SSE）を返す偽の fetch。送った要求を残す */
function fakeClaude(events: ReadonlyArray<Record<string, unknown>>, status = 200): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    sent.push({ url: req.url, headers: req.headers, body: (await req.json()) as Record<string, unknown> });
    if (status !== 200) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "混んでいる" } }), { status, headers: { "content-type": "application/json" } });
    const text = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetch: fetchFn, sent };
}

/** 思考 → 文 → submit_report の呼び出しで止まる応答 */
function toolTurn(model = "claude-opus-5-5"): Array<Record<string, unknown>> {
  return [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "考えている" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "報告します" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "submit_report", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"title":"題","body":"本文","sources":[]}' } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 500 } },
    { type: "message_stop" },
  ];
}

const baseReq = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  model: "claude-opus-5-5",
  system: "あなたは担当です",
  messages: [{ role: "user", content: "在庫を見て" }],
  tools: [{ name: "submit_report", description: "報告する", inputSchema: { type: "object", properties: { title: { type: "string" } } } }] as unknown as LlmRequest["tools"],
  mcpTools: [],
  maxTokens: 8000,
  ...over,
});

describe("ClaudeClient", () => {
  it("道具の呼び出しを runner の形に戻し、思考は捨てる。費用は応答のモデルの単価", async () => {
    const f = fakeClaude(toolTurn());
    const client = new ClaudeClient({ apiKey: "sk-test", fetch: f.fetch });
    const res = await client.generate(baseReq());
    expect(res.parts).toEqual([
      { type: "text", text: "報告します" },
      { type: "tool_call", id: "toolu_1", name: "submit_report", arguments: { title: "題", body: "本文", sources: [] } },
    ]);
    expect(res.stopReason).toBe("tool_calls");
    // 入力 1000 × $4/M ＋ 出力 500 × $20/M = 0.004 + 0.01 = $0.014
    expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 500, thinkingTokens: 0, costMicroUsd: 14_000 });
  });

  it("送る形：道具・代わりのモデル（Opus）を付け、temperature・思考の設定・強制の tool_choice は送らない", async () => {
    const f = fakeClaude(toolTurn());
    await new ClaudeClient({ apiKey: "sk-test", fetch: f.fetch }).generate(baseReq({ temperature: 0.2 }));
    const { url, headers, body } = f.sent[0]!;
    expect(url).toContain("/v1/messages");
    expect(headers.get("x-api-key")).toBe("sk-test");
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-06-01");
    expect(body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 8000, system: "あなたは担当です", stream: true, fallbacks: [{ model: "claude-opus-4-8" }] });
    expect(body.tools).toEqual([{ name: "submit_report", description: "報告する", input_schema: { type: "object", properties: { title: { type: "string" } } } }]);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("Haiku には代わりのモデルを付けない。thinkingLevel は effort に写す", async () => {
    const f = fakeClaude(toolTurn("claude-haiku-5-5"));
    await new ClaudeClient({ apiKey: "sk-test", fetch: f.fetch }).generate(baseReq({ model: "claude-haiku-5-5", thinkingLevel: "low" }));
    const { headers, body } = f.sent[0]!;
    expect(headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
    expect(body).not.toHaveProperty("fallbacks");
    expect(body.output_config).toEqual({ effort: "low" });
  });

  it("履歴：前の発言の道具の呼び出しと結果を tool_use・tool_result にし、同じ役割はまとめる", async () => {
    const f = fakeClaude(toolTurn());
    await new ClaudeClient({ apiKey: "sk-test", fetch: f.fetch }).generate(
      baseReq({
        messages: [
          { role: "user", content: "在庫を見て" },
          { role: "assistant", content: [{ type: "text", text: "見ます" }, { type: "tool_call", id: "toolu_0", name: "notify", arguments: { message: "開始" } }] },
          { role: "tool", content: { toolCallId: "toolu_0", name: "notify", result: "ok" } },
          { role: "user", content: "続けて" },
        ],
      }),
    );
    expect(f.sent[0]!.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "在庫を見て" }] },
      { role: "assistant", content: [{ type: "text", text: "見ます" }, { type: "tool_use", id: "toolu_0", name: "notify", input: { message: "開始" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_0", content: "ok" }, { type: "text", text: "続けて" }] },
    ]);
  });

  it("構造化出力：受け付けない制約を外し、object に additionalProperties: false を付ける", async () => {
    const f = fakeClaude(toolTurn());
    const schema = { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 200 }, items: { type: "array", maxItems: 4, items: { type: "object", properties: { id: { type: "string" } } } } }, required: ["text"] };
    await new ClaudeClient({ apiKey: "sk-test", fetch: f.fetch }).generate(baseReq({ tools: [], responseJsonSchema: schema }));
    expect(f.sent[0]!.body.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { text: { type: "string" }, items: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false } } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    });
    expect(claudeJsonSchema({ type: "string", pattern: "^a", default: "a" })).toEqual({ type: "string" });
  });

  it("失敗：5xx・429 は送り直せる LlmError、料金表にないモデルは呼ぶ前に断る", async () => {
    const f = fakeClaude([], 529);
    await expect(new ClaudeClient({ apiKey: "sk-test", fetch: f.fetch }).generate(baseReq())).rejects.toMatchObject({ name: "LlmError", status: 529, retryable: true });
    const g = fakeClaude(toolTurn());
    await expect(new ClaudeClient({ apiKey: "sk-test", fetch: g.fetch }).generate(baseReq({ model: "claude-3-opus" }))).rejects.toMatchObject({ name: "LlmError", retryable: false });
    expect(g.sent).toHaveLength(0);
  });

  it("料金表は Opus 5.5・Sonnet 5.5・Haiku 5.5・Fable 5.1 と代わりの Opus 4.8", () => {
    expect(Object.keys(CLAUDE_PRICES).sort()).toEqual(["claude-fable-5-1", "claude-haiku-5-5", "claude-opus-4-8", "claude-opus-5-5", "claude-sonnet-5-5"]);
  });

  it("呼ぶ前の見積もりの単価は、元のモデルと代わりのモデルの高いほう。見積もりは1回分（estimateMicroUsd を持たない）", () => {
    const client = new ClaudeClient({ apiKey: "sk-test" });
    // Opus 5.5（$4/$20）と代わりの Opus 4.8（$5/$25）の高いほう
    expect(client.priceFor("claude-opus-5-5")).toMatchObject({ inputPerMTokMicroUsd: 5_000_000, outputPerMTokMicroUsd: 25_000_000 });
    // 代わりを持たない Sonnet はそのまま
    expect(client.priceFor("claude-sonnet-5-5")).toMatchObject({ inputPerMTokMicroUsd: 2_000_000, outputPerMTokMicroUsd: 10_000_000 });
    expect(client.priceFor("claude-3-opus")).toBeNull();
    expect((client as { estimateMicroUsd?: unknown }).estimateMicroUsd).toBeUndefined();
  });

  it("代わりのモデル（Opus 4.8）が答えたら、その単価で数える", async () => {
    const f = fakeClaude(toolTurn("claude-opus-4-8"));
    const res = await new ClaudeClient({ apiKey: "sk-test", fetch: f.fetch }).generate(baseReq());
    // 入力 1000 × $5/M ＋ 出力 500 × $25/M = 0.005 + 0.0125
    expect(res.usage.costMicroUsd).toBe(17_500);
  });
});
