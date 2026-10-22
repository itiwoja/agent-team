import type { ToolCallPart } from "@open-team/runner";
import { describe, expect, it } from "vitest";
import { costMicroUsd } from "./pricing.ts";
import { ScriptedLlmClient, type ScriptedReply } from "./scripted.ts";
import { LlmError, type LlmClient, type LlmRequest } from "./types.ts";

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "gemini-3.8-flash",
    system: "あなたは仕入れ係です。",
    messages: [{ role: "user", content: "在庫を見て" }],
    tools: [],
    mcpTools: [],
    maxTokens: 8_000,
    ...over,
  };
}

const order: ToolCallPart = {
  type: "tool_call",
  id: "call-1",
  name: "mcp_call",
  arguments: { connector: "supplier", tool: "place_order", arguments: { supplier_id: "supplier-01", items: [{ sku: "BEAN-HOUSE", quantity: 20 }] } },
};

describe("ScriptedLlmClient（試験・CI・オフラインのデモ用の決定論の偽物）", () => {
  it("応答の列を順に返し、受けた要求を記録する", async () => {
    const client = new ScriptedLlmClient([{ parts: [order] }, { parts: [{ type: "text", text: "発注しました" }] }]);
    const r1 = await client.generate(request());
    const r2 = await client.generate(request({ messages: [{ role: "user", content: "続けて" }] }));
    expect(r1.parts).toEqual([order]);
    expect(r1.stopReason).toBe("tool_call");
    expect(r2.parts).toEqual([{ type: "text", text: "発注しました" }]);
    expect(r2.stopReason).toBe("stop");
    expect(client.requests.map((r) => r.messages[0])).toEqual([
      { role: "user", content: "在庫を見て" },
      { role: "user", content: "続けて" },
    ]);
  });

  it("列が尽きたら LlmError（やり直さない）", async () => {
    const client = new ScriptedLlmClient([{ parts: [] }]);
    await client.generate(request());
    const error = await client.generate(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ status: null, retryable: false });
    expect((error as LlmError).message).toContain("2回目");
  });

  it("要求から応答を作る関数を受ける（index は 0 から）", async () => {
    const client = new ScriptedLlmClient((req, index) => ({ parts: [{ type: "text", text: `${index}:${req.model}` }] }));
    expect((await client.generate(request())).parts).toEqual([{ type: "text", text: "0:gemini-3.8-flash" }]);
    expect((await client.generate(request({ model: "gemini-3.1-pro-preview" }))).parts).toEqual([{ type: "text", text: "1:gemini-3.1-pro-preview" }]);
  });

  it("列の中に関数を混ぜられ、関数が投げた失敗はそのまま返る", async () => {
    const client = new ScriptedLlmClient([
      async () => ({ parts: [{ type: "text", text: "非同期" }] }),
      () => {
        throw new LlmError("試験の 503", 503, true);
      },
    ]);
    expect((await client.generate(request())).parts).toEqual([{ type: "text", text: "非同期" }]);
    await expect(client.generate(request())).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it("使用量を指定すればそれを使い（ない項目は 0）、費用は価格表で出す", async () => {
    const client = new ScriptedLlmClient([{ parts: [], usage: { inputTokens: 1_000, outputTokens: 200, thinkingTokens: 300 } }, { parts: [], usage: { inputTokens: 10 } }]);
    const r1 = await client.generate(request());
    expect(r1.usage).toEqual({ inputTokens: 1_000, outputTokens: 200, thinkingTokens: 300, costMicroUsd: 5_250 });
    const r2 = await client.generate(request());
    expect(r2.usage).toEqual({ inputTokens: 10, outputTokens: 0, thinkingTokens: 0, costMicroUsd: costMicroUsd("gemini-3.8-flash", { inputTokens: 10, outputTokens: 0, thinkingTokens: 0 }) });
  });

  it("使用量を指定しなければ文字数からの目安（決定論：同じ要求・応答なら同じ値）", async () => {
    const reply: ScriptedReply = { parts: [order] };
    const a = await new ScriptedLlmClient([reply]).generate(request());
    const b = await new ScriptedLlmClient([reply]).generate(request());
    expect(a.usage).toEqual(b.usage);
    expect(a.usage.inputTokens).toBeGreaterThan(0);
    expect(a.usage.outputTokens).toBeGreaterThan(0);
    expect(a.usage.thinkingTokens).toBe(0);
    expect(a.usage.costMicroUsd).toBe(costMicroUsd("gemini-3.8-flash", a.usage));
    // 入力が長いほど多く数える
    const longer = await new ScriptedLlmClient([reply]).generate(request({ messages: [{ role: "user", content: "在庫".repeat(1_000) }] }));
    expect(longer.usage.inputTokens).toBeGreaterThan(a.usage.inputTokens);
  });

  it("model・stopReason を指定できる（費用はそのモデルの単価）", async () => {
    const r = await new ScriptedLlmClient([{ parts: [], model: "gemini-3.1-pro-preview", stopReason: "max_tokens", usage: { outputTokens: 1_000 } }]).generate(request());
    expect(r.model).toBe("gemini-3.1-pro-preview");
    expect(r.stopReason).toBe("max_tokens");
    expect(r.usage.costMicroUsd).toBe(costMicroUsd("gemini-3.1-pro-preview", { inputTokens: 0, outputTokens: 1_000, thinkingTokens: 0 }));
  });

  it("返した部品を書き換えても台本は変わらない", async () => {
    const reply: ScriptedReply = { parts: [{ type: "text", text: "元のまま" }] };
    const client = new ScriptedLlmClient([reply, reply]);
    const r1 = await client.generate(request());
    const first = r1.parts[0];
    if (first?.type === "text") first.text = "書き換えた";
    expect((await client.generate(request())).parts).toEqual([{ type: "text", text: "元のまま" }]);
  });

  it("中断済みなら呼ばずに中断の LlmError", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const client = new ScriptedLlmClient([{ parts: [] }]);
    await expect(client.generate(request(), { signal: ctrl.signal })).rejects.toMatchObject({ status: null, retryable: false });
    expect(client.requests).toHaveLength(0);
  });

  it("応答を作っている間に中断したら中断の LlmError", async () => {
    const ctrl = new AbortController();
    const client = new ScriptedLlmClient(() => {
      ctrl.abort();
      return { parts: [] };
    });
    await expect(client.generate(request(), { signal: ctrl.signal })).rejects.toMatchObject({ retryable: false });
  });

  it("LlmClient として使える", async () => {
    const client: LlmClient = new ScriptedLlmClient([{ parts: [{ type: "text", text: "ok" }] }]);
    await expect(client.generate(request())).resolves.toMatchObject({ model: "gemini-3.8-flash", parts: [{ type: "text", text: "ok" }] });
  });
});
