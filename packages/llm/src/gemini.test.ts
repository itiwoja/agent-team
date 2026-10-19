import { ApiError, BlockedReason, FinishReason } from "@google/genai";
import type { GenerateContentParameters, Part } from "@google/genai";
import type { ChatMessage, McpToolSpec, ToolSpec } from "@open-team/runner";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVertexAi,
  fromGeminiResponse,
  GeminiClient,
  inputTokensUpperBound,
  isRetryableStatus,
  LLM_TIMEOUT_MS,
  toGeminiContents,
  toGeminiRequest,
  toLlmError,
  unpricedModelError,
  type FromGeminiContext,
  type GeminiRequestParams,
  type GeminiResponse,
  type GenerateContentFn,
} from "./gemini.ts";
import { costMicroUsd, FALLBACK_PRICE, GROUNDING_QUERY_MICRO_USD, PRICE_TABLE } from "./pricing.ts";
import type { RetryInfo } from "./retry.ts";
import { buildToolDeclarations, EMPTY_MCP_FUNCTION_TABLE } from "./tools.ts";
import { LlmError, type LlmClient, type LlmRequest } from "./types.ts";

// ---- 試験の材料（仕入れ係：sim-world の supplier・mail） ----

const placeOrderSchema = {
  type: "object",
  properties: {
    supplier_id: { type: "string" },
    items: { type: "array", items: { type: "object", properties: { sku: { type: "string" }, quantity: { type: "integer" } } } },
  },
  required: ["supplier_id", "items"],
  additionalProperties: false,
};
const catalog: ToolSpec[] = [
  { name: "mcp_call", description: "MCP のツールを呼ぶ", inputSchema: { type: "object" } },
  { name: "submit_report", description: "報告を出す", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
  { name: "finish", description: "終える", inputSchema: { type: "object", properties: { outcome: { type: "string" } } } },
];
const mcp: McpToolSpec[] = [
  { connector: "supplier", tool: "place_order", classification: "write", description: "仕入れ先に発注する", inputSchema: placeOrderSchema },
  { connector: "mail", tool: "list_inbox", classification: "read", description: "受信箱を読む", inputSchema: { type: "object" } },
];
const ORDER_ARGS = { supplier_id: "supplier-01", items: [{ sku: "BEAN-HOUSE", quantity: 20 }] };

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "gemini-3.8-flash",
    system: "あなたは仕入れ係です。",
    messages: [{ role: "user", content: "在庫を見て、足りなければ発注してください" }],
    tools: catalog,
    mcpTools: mcp,
    maxTokens: 8_000,
    ...over,
  };
}

function modelResponse(parts: Part[], finishReason: FinishReason = FinishReason.STOP): GeminiResponse {
  return {
    candidates: [{ content: { role: "model", parts }, finishReason }],
    usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 200, thoughtsTokenCount: 300, totalTokenCount: 1_500 },
  };
}

/** 渡された引数を記録し、順に応答（か失敗）を返す偽の generateContent */
function fakeGenerate(...steps: Array<GeminiResponse | Error>): { calls: GenerateContentParameters[]; fn: GenerateContentFn } {
  const calls: GenerateContentParameters[] = [];
  const fn: GenerateContentFn = async (params) => {
    calls.push(params);
    const step = steps[calls.length - 1];
    if (step === undefined) throw new Error("偽の generateContent：応答の用意がない");
    if (step instanceof Error) throw step;
    return step;
  };
  return { calls, fn };
}

/** gen-1, gen-2, … を順に返す */
function sequentialIds(): () => string {
  let n = 0;
  return () => `gen-${++n}`;
}

const noWait = { sleep: async (): Promise<void> => {} };

function ctxFor(over: Partial<FromGeminiContext> = {}): FromGeminiContext {
  return {
    model: "gemini-3.8-flash",
    table: buildToolDeclarations(catalog, mcp).table,
    newId: sequentialIds(),
    maxTokens: 8_000,
    requestTokensUpperBound: () => 12_345,
    ...over,
  };
}

function declaredNames(params: GeminiRequestParams): string[] | undefined {
  const tool = params.config.tools?.[0];
  if (tool === undefined || !("functionDeclarations" in tool)) return undefined;
  return tool.functionDeclarations?.map((d) => d.name ?? "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---- 要求 ----

describe("要求の組み立て（toGeminiRequest）", () => {
  it("model・systemInstruction・maxOutputTokens・temperature を渡す", () => {
    const { params } = toGeminiRequest(request({ temperature: 0.2 }));
    expect(params.model).toBe("gemini-3.8-flash");
    expect(params.config.systemInstruction).toBe("あなたは仕入れ係です。");
    expect(params.config.maxOutputTokens).toBe(8_000);
    expect(params.config.temperature).toBe(0.2);
    expect(params.config.responseMimeType).toBeUndefined();
    expect(params.config.responseJsonSchema).toBeUndefined();
  });

  it("system が空なら systemInstruction を送らず、temperature を省けば送らない", () => {
    const { params } = toGeminiRequest(request({ system: "" }));
    expect("systemInstruction" in params.config).toBe(false);
    expect("temperature" in params.config).toBe(false);
  });

  it("thinkingLevel を渡せば thinkingConfig に入れ、省けば送らない（モデルの既定）", () => {
    expect(toGeminiRequest(request({ thinkingLevel: "low" })).params.config.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    expect("thinkingConfig" in toGeminiRequest(request()).params.config).toBe(false);
  });

  it("関数の宣言は1つの Tool に入れ、MCP のツールは展開して入力スキーマをそのまま渡す（mcp_call は宣言しない）", () => {
    const { params, table } = toGeminiRequest(request());
    expect(params.config.tools).toHaveLength(1);
    expect(declaredNames(params)).toEqual(["submit_report", "finish", "mcp__supplier__place_order", "mcp__mail__list_inbox"]);
    const tool = params.config.tools?.[0];
    const decl = tool !== undefined && "functionDeclarations" in tool ? tool.functionDeclarations?.[2] : undefined;
    expect(decl?.parametersJsonSchema).toBe(placeOrderSchema);
    expect(table.byName.get("mcp__supplier__place_order")).toEqual({ connector: "supplier", tool: "place_order" });
  });

  it("ツールがなければ tools を送らない", () => {
    const { params } = toGeminiRequest(request({ tools: [], mcpTools: [] }));
    expect(params.config.tools).toBeUndefined();
  });

  it("構造化出力：responseMimeType は application/json、responseJsonSchema はそのまま、ツールは渡さない", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { scenarios: { type: "array", maxItems: 20 } },
      required: ["scenarios"],
      additionalProperties: false,
    };
    const { params, table } = toGeminiRequest(request({ responseJsonSchema: schema }));
    expect(params.config.responseMimeType).toBe("application/json");
    expect(params.config.responseJsonSchema).toBe(schema);
    expect(params.config.tools).toBeUndefined();
    expect(table).toBe(EMPTY_MCP_FUNCTION_TABLE);
  });
});

// ---- 会話の変換 ----

describe("会話の変換（toGeminiContents）", () => {
  const { table } = buildToolDeclarations(catalog, mcp);

  it("user → user、assistant → model、tool → user の functionResponse（結果は output）。呼び出しと応答に同じ ID と名前", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "在庫を見て" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "受信箱を読みます" },
          { type: "tool_call", id: "call-1", name: "mcp_call", arguments: { connector: "mail", tool: "list_inbox", arguments: { limit: 5 } } },
        ],
      },
      { role: "tool", content: { toolCallId: "call-1", name: "mcp_call", result: '<untrusted source="mcp:mail.list_inbox">…</untrusted>' } },
      { role: "assistant", content: [{ type: "tool_call", id: "call-2", name: "submit_report", arguments: { title: "t", body: "b", sources: [] } }] },
      { role: "tool", content: { toolCallId: "call-2", name: "submit_report", result: "受け付けました" } },
    ];
    expect(toGeminiContents(messages, table)).toEqual([
      { role: "user", parts: [{ text: "在庫を見て" }] },
      {
        role: "model",
        parts: [{ text: "受信箱を読みます" }, { functionCall: { id: "call-1", name: "mcp__mail__list_inbox", args: { limit: 5 } } }],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call-1",
              name: "mcp__mail__list_inbox",
              response: { output: '<untrusted source="mcp:mail.list_inbox">…</untrusted>' },
            },
          },
        ],
      },
      { role: "model", parts: [{ functionCall: { id: "call-2", name: "submit_report", args: { title: "t", body: "b", sources: [] } } }] },
      { role: "user", parts: [{ functionResponse: { id: "call-2", name: "submit_report", response: { output: "受け付けました" } } }] },
    ]);
  });

  it("並列の呼び出しの応答は1つの Content にまとめ、続く user の発言も同じ Content に入れる（役割を交互にする）", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "始めて" },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "a", name: "mcp_call", arguments: { connector: "mail", tool: "list_inbox", arguments: {} } },
          { type: "tool_call", id: "b", name: "mcp_call", arguments: { connector: "supplier", tool: "place_order", arguments: ORDER_ARGS } },
        ],
      },
      { role: "tool", content: { toolCallId: "a", name: "mcp_call", result: "受信箱" } },
      { role: "tool", content: { toolCallId: "b", name: "mcp_call", result: '{"intentId":"i-1","status":"pending_approval"}' } },
      { role: "user", content: "submit_report か finish を呼んでください" },
    ];
    const contents = toGeminiContents(messages, table);
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents[2]?.parts).toEqual([
      { functionResponse: { id: "a", name: "mcp__mail__list_inbox", response: { output: "受信箱" } } },
      { functionResponse: { id: "b", name: "mcp__supplier__place_order", response: { output: '{"intentId":"i-1","status":"pending_approval"}' } } },
      { text: "submit_report か finish を呼んでください" },
    ]);
    expect(contents[1]?.parts?.[1]).toEqual({ functionCall: { id: "b", name: "mcp__supplier__place_order", args: ORDER_ARGS } });
  });

  it("空の文字は送らず、署名のある空の文字は送る。部品がすべて空なら model の Content を作らない", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "" },
      { role: "user", content: "やって" },
      { role: "assistant", content: [{ type: "text", text: "" }] },
      { role: "assistant", content: [] },
      { role: "user", content: "まだ？" },
      { role: "assistant", content: [{ type: "text", text: "完了", }, { type: "text", text: "", signature: "sig-end" }] },
    ];
    expect(toGeminiContents(messages, table)).toEqual([
      { role: "user", parts: [{ text: "やって" }, { text: "まだ？" }] },
      { role: "model", parts: [{ text: "完了" }, { text: "", thoughtSignature: "sig-end" }] },
    ]);
    // 空の署名は「署名なし」と同じ
    expect(
      toGeminiContents(
        [
          { role: "user", content: "x" },
          { role: "assistant", content: [{ type: "text", text: "", signature: "" }, { type: "tool_call", id: "1", name: "finish", arguments: {}, signature: "" }] },
        ],
        table,
      )[1]?.parts,
    ).toEqual([{ functionCall: { id: "1", name: "finish", args: {} } }]);
  });

  it("前の呼び出しが見つからない tool のメッセージは、その name のまま（ID は入れる）", () => {
    const contents = toGeminiContents(
      [
        { role: "user", content: "x" },
        { role: "assistant", content: [{ type: "tool_call", id: "other", name: "finish", arguments: {} }] },
        { role: "tool", content: { toolCallId: "lost", name: "mcp_call", result: "r" } },
      ],
      table,
    );
    expect(contents[2]?.parts).toEqual([{ functionResponse: { id: "lost", name: "mcp_call", response: { output: "r" } } }]);
  });

  it("付与が外れた MCP のツールの履歴も mcp__<connector>__<tool> で見せ、応答の名前も合わせる", () => {
    const contents = toGeminiContents(
      [
        { role: "user", content: "x" },
        { role: "assistant", content: [{ type: "tool_call", id: "p", name: "mcp_call", arguments: { connector: "bank", tool: "register_payee", arguments: { account: "1" } } }] },
        { role: "tool", content: { toolCallId: "p", name: "mcp_call", result: "ポリシーにより拒否（not_granted）" } },
      ],
      table,
    );
    expect(contents[1]?.parts).toEqual([{ functionCall: { id: "p", name: "mcp__bank__register_payee", args: { account: "1" } } }]);
    expect(contents[2]?.parts?.[0]?.functionResponse?.name).toBe("mcp__bank__register_payee");
  });
});

// ---- 応答の変換 ----

describe("応答の変換（fromGeminiResponse）", () => {
  it("文字と関数呼び出しを順に戻し、mcp__ の関数は mcp_call にする（モデルの ID を使う）", () => {
    const res = fromGeminiResponse(
      modelResponse([
        { text: "発注します" },
        { functionCall: { id: "fc-9", name: "mcp__supplier__place_order", args: ORDER_ARGS } },
        { functionCall: { id: "fc-10", name: "submit_report", args: { title: "発注した" } } },
      ]),
      ctxFor(),
    );
    expect(res.parts).toEqual([
      { type: "text", text: "発注します" },
      { type: "tool_call", id: "fc-9", name: "mcp_call", arguments: { connector: "supplier", tool: "place_order", arguments: ORDER_ARGS } },
      { type: "tool_call", id: "fc-10", name: "submit_report", arguments: { title: "発注した" } },
    ]);
  });

  it("ID がない・空・重なる呼び出しは newId で作る", () => {
    const res = fromGeminiResponse(
      modelResponse([
        { functionCall: { name: "finish", args: { outcome: "unable" } } },
        { functionCall: { id: "", name: "finish", args: {} } },
        { functionCall: { id: "dup", name: "finish", args: {} } },
        { functionCall: { id: "dup", name: "finish", args: {} } },
      ]),
      ctxFor(),
    );
    expect(res.parts.map((p) => (p.type === "tool_call" ? p.id : null))).toEqual(["gen-1", "gen-2", "dup", "gen-3"]);
  });

  it("§2.6 作った ID がモデルの ID と重ならない（モデルの ID の後に、ID のない呼び出しが来ても）", () => {
    const res = fromGeminiResponse(
      modelResponse([
        { functionCall: { id: "gen-1", name: "finish", args: {} } },
        { functionCall: { name: "finish", args: {} } },
      ]),
      ctxFor(),
    );
    const ids = res.parts.map((p) => (p.type === "tool_call" ? p.id : null));
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(["gen-1", "gen-2"]);
  });

  it("§2.6・§3.11-2 ID は会話の全体で重ならない：前の応答と同じ ID をモデルが返したら作り直す（ID は governance・callTool の鍵）", async () => {
    const fake = fakeGenerate(
      modelResponse([{ functionCall: { id: "call-1", name: "mcp__mail__list_inbox", args: {} } }]),
      modelResponse([{ functionCall: { id: "call-1", name: "mcp__mail__list_inbox", args: { limit: 1 } } }]),
    );
    const client = new GeminiClient({ generateContent: fake.fn, newId: sequentialIds() });
    const first = await client.generate(request());
    const messages: ChatMessage[] = [
      ...request().messages,
      { role: "assistant", content: first.parts },
      { role: "tool", content: { toolCallId: "call-1", name: "mcp_call", result: "受信箱" } },
    ];
    const second = await client.generate(request({ messages }));
    expect(first.parts.map((p) => (p.type === "tool_call" ? p.id : null))).toEqual(["call-1"]);
    expect(second.parts.map((p) => (p.type === "tool_call" ? p.id : null))).toEqual(["gen-1"]);
    // 作り直した ID で履歴の呼び出しと応答の組を作る（次の呼び出しで送る形）
    const next = toGeminiContents([...messages, { role: "assistant", content: second.parts }, { role: "tool", content: { toolCallId: "gen-1", name: "mcp_call", result: "1件" } }], buildToolDeclarations(catalog, mcp).table);
    expect(next.at(-2)?.parts?.[0]?.functionCall?.id).toBe("gen-1");
    expect(next.at(-1)?.parts?.[0]?.functionResponse).toMatchObject({ id: "gen-1", name: "mcp__mail__list_inbox" });
  });

  it("既定の ID は crypto.randomUUID", async () => {
    const fake = fakeGenerate(modelResponse([{ functionCall: { name: "finish", args: {} } }]));
    const res = await new GeminiClient({ generateContent: fake.fn }).generate(request());
    const part = res.parts[0];
    expect(part?.type === "tool_call" ? part.id : "").toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("BR-09：知らない名前（付与のない MCP・カタログにないツール）はそのまま返す（edge が拒否する）", () => {
    const res = fromGeminiResponse(
      modelResponse([
        { functionCall: { id: "1", name: "mcp__bank__register_payee", args: { account: "x" } } },
        { functionCall: { id: "2", name: "remember", args: { content: "x" } } },
        { functionCall: { id: "3", args: {} } },
      ]),
      ctxFor(),
    );
    expect(res.parts).toEqual([
      { type: "tool_call", id: "1", name: "mcp__bank__register_payee", arguments: { account: "x" } },
      { type: "tool_call", id: "2", name: "remember", arguments: { content: "x" } },
      { type: "tool_call", id: "3", name: "", arguments: {} },
    ]);
  });

  it("tools に mcp_call がなかった呼び出しでは、mcp__ の名前もそのまま返す", async () => {
    const fake = fakeGenerate(modelResponse([{ functionCall: { id: "1", name: "mcp__supplier__place_order", args: ORDER_ARGS } }]));
    const res = await new GeminiClient({ generateContent: fake.fn }).generate(
      request({ tools: catalog.filter((t) => t.name !== "mcp_call") }),
    );
    expect(res.parts).toEqual([{ type: "tool_call", id: "1", name: "mcp__supplier__place_order", arguments: ORDER_ARGS }]);
  });

  it("引数のない関数呼び出しは arguments が {}", () => {
    const res = fromGeminiResponse(modelResponse([{ functionCall: { id: "1", name: "mcp__mail__list_inbox" } }]), ctxFor());
    expect(res.parts).toEqual([
      { type: "tool_call", id: "1", name: "mcp_call", arguments: { connector: "mail", tool: "list_inbox", arguments: {} } },
    ]);
  });

  it("署名を TextPart・ToolCallPart の signature に入れる", () => {
    const res = fromGeminiResponse(
      modelResponse([
        { text: "考えた", thoughtSignature: "sig-t" },
        { functionCall: { id: "1", name: "finish", args: {} }, thoughtSignature: "sig-f" },
        { text: "", thoughtSignature: "sig-end" },
      ]),
      ctxFor(),
    );
    expect(res.parts).toEqual([
      { type: "text", text: "考えた", signature: "sig-t" },
      { type: "tool_call", id: "1", name: "finish", arguments: {}, signature: "sig-f" },
      { type: "text", text: "", signature: "sig-end" },
    ]);
  });

  it("思考の要約・使わない種類の部品は捨て、署名だけ空の文字の部品で残す。署名のない空の文字も捨てる", () => {
    const res = fromGeminiResponse(
      modelResponse([
        { text: "（思考の要約）", thought: true },
        { text: "（署名つきの思考）", thought: true, thoughtSignature: "sig-th" },
        { inlineData: { mimeType: "image/png", data: "AAAA" } },
        { executableCode: { code: "print(1)" }, thoughtSignature: "sig-code" },
        { text: "" },
        { text: "本文" },
      ]),
      ctxFor(),
    );
    expect(res.parts).toEqual([
      { type: "text", text: "", signature: "sig-th" },
      { type: "text", text: "", signature: "sig-code" },
      { type: "text", text: "本文" },
    ]);
    expect(JSON.stringify(res.parts)).not.toContain("思考");
  });

  it("2つ目以降の候補は使わない", () => {
    const res = fromGeminiResponse(
      {
        candidates: [
          { content: { role: "model", parts: [{ text: "1つ目" }] }, finishReason: FinishReason.STOP },
          { content: { role: "model", parts: [{ text: "2つ目" }] }, finishReason: FinishReason.STOP },
        ],
      },
      ctxFor(),
    );
    expect(res.parts).toEqual([{ type: "text", text: "1つ目" }]);
  });

  it("stopReason：ツール呼び出しがあれば tool_call、なければ finishReason の小文字", () => {
    const stop = (r: GeminiResponse) => fromGeminiResponse(r, ctxFor()).stopReason;
    expect(stop(modelResponse([{ functionCall: { id: "1", name: "finish" } }], FinishReason.STOP))).toBe("tool_call");
    expect(stop(modelResponse([{ text: "x" }], FinishReason.STOP))).toBe("stop");
    expect(stop(modelResponse([{ text: "x" }], FinishReason.MAX_TOKENS))).toBe("max_tokens");
    expect(stop(modelResponse([], FinishReason.SAFETY))).toBe("safety");
    expect(stop(modelResponse([], FinishReason.MALFORMED_FUNCTION_CALL))).toBe("malformed_function_call");
    expect(stop({ candidates: [{ content: { role: "model", parts: [{ text: "x" }] } }] })).toBe("unknown");
  });

  it("候補がない：プロンプトが止められたら prompt_blocked、ほかは no_candidate（部品は空）", () => {
    const blocked = fromGeminiResponse(
      { promptFeedback: { blockReason: BlockedReason.SAFETY }, usageMetadata: { promptTokenCount: 50 } },
      ctxFor(),
    );
    expect(blocked).toMatchObject({ parts: [], stopReason: "prompt_blocked" });
    expect(blocked.usage).toMatchObject({ inputTokens: 50, outputTokens: 0, thinkingTokens: 0 });
    expect(fromGeminiResponse({ candidates: [] }, ctxFor()).stopReason).toBe("no_candidate");
  });
});

// ---- 使用量と費用 ----

describe("使用量と費用（usageMetadata・SO §3.12-6）", () => {
  it("SO-BUD-12：入力 1,000・出力 200・思考 300 を取り、思考は出力の単価で数える", () => {
    const res = fromGeminiResponse(modelResponse([{ text: "ok" }]), ctxFor());
    const tokens = { inputTokens: 1_000, outputTokens: 200, thinkingTokens: 300 };
    expect(res.usage).toEqual({ ...tokens, costMicroUsd: costMicroUsd("gemini-3.8-flash", tokens) });
    expect(res.usage.costMicroUsd).toBe(5_250);
  });

  it("入力にサーバー側のツールの結果を足し、キャッシュの分も定価で数える（安全側）", () => {
    const res = fromGeminiResponse(
      {
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: FinishReason.STOP }],
        usageMetadata: { promptTokenCount: 1_000, cachedContentTokenCount: 800, toolUsePromptTokenCount: 50, candidatesTokenCount: 10 },
      },
      ctxFor(),
    );
    expect(res.usage).toMatchObject({ inputTokens: 1_050, outputTokens: 10, thinkingTokens: 0 });
  });

  it("省かれた値は 0（proto3 の JSON は 0 を省く）。小数は切り上げ、負は 0", () => {
    const res = fromGeminiResponse(
      { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 10.2, candidatesTokenCount: -5 } },
      ctxFor(),
    );
    expect(res.usage).toMatchObject({ inputTokens: 11, outputTokens: 0, thinkingTokens: 0 });
  });

  it("usageMetadata がないときは上限で数える（入力は送った本文のバイト数、出力は maxTokens）", () => {
    const res = fromGeminiResponse({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] }, ctxFor());
    expect(res.usage).toMatchObject({ inputTokens: 12_345, outputTokens: 8_000, thinkingTokens: 0 });
    expect(res.usage.costMicroUsd).toBe(costMicroUsd("gemini-3.8-flash", { inputTokens: 12_345, outputTokens: 8_000, thinkingTokens: 0 }));
  });

  it("usageMetadata がない応答の入力の上限は、送った本文（system・会話・ツールの宣言）の UTF-8 のバイト数以上", async () => {
    const longText = "在庫".repeat(500);
    const fake = fakeGenerate({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] });
    const res = await new GeminiClient({ generateContent: fake.fn }).generate(request({ messages: [{ role: "user", content: longText }] }));
    const minimum = Buffer.byteLength(longText, "utf8") + Buffer.byteLength("あなたは仕入れ係です。", "utf8");
    expect(res.usage.inputTokens).toBeGreaterThan(minimum);
    expect(res.usage.outputTokens).toBe(8_000);
  });

  it("SO §9 I-15：inputTokensUpperBound は usageMetadata がないときの入力の量と同じで、本文・ツールが増えれば増える", async () => {
    const req = request({ messages: [{ role: "user", content: "在庫".repeat(100) }] });
    const fake = fakeGenerate({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] });
    const res = await new GeminiClient({ generateContent: fake.fn }).generate(req);
    expect(res.usage.inputTokens).toBe(inputTokensUpperBound(req));
    expect(inputTokensUpperBound(req)).toBeGreaterThan(Buffer.byteLength("在庫".repeat(100), "utf8"));
    const longer = request({ messages: [...req.messages, { role: "assistant", content: [{ type: "text", text: "はい" }] }, { role: "user", content: "続けて" }] });
    expect(inputTokensUpperBound(longer)).toBeGreaterThan(inputTokensUpperBound(req));
    expect(inputTokensUpperBound(request({ tools: [], mcpTools: [] }))).toBeLessThan(inputTokensUpperBound(request()));
  });

  it("BR-10・SO §3.12-2 構造化出力の JSON Schema も送る本文なので、入力の上限に数える", () => {
    const schema = { type: "object", properties: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`field_${i}`, { type: "string", description: "状況の説明".repeat(5) }])) };
    const base = request({ tools: [], mcpTools: [], responseJsonSchema: { type: "object" } });
    const big = request({ tools: [], mcpTools: [], responseJsonSchema: schema });
    expect(inputTokensUpperBound(big) - inputTokensUpperBound(base)).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(schema), "utf8") - 20);
  });

  it("LlmResponse.model は要求したモデル（応答の modelVersion ではない）", () => {
    const res = fromGeminiResponse({ ...modelResponse([{ text: "ok" }]), modelVersion: "gemini-3.8-flash-002" }, ctxFor());
    expect(res.model).toBe("gemini-3.8-flash");
  });

  it("表にないモデルは高めの既定の単価で数える", () => {
    const res = fromGeminiResponse(modelResponse([{ text: "ok" }]), ctxFor({ model: "gemini-unknown" }));
    expect(res.usage.costMicroUsd).toBe(costMicroUsd("gemini-unknown", { inputTokens: 1_000, outputTokens: 200, thinkingTokens: 300 }));
    expect(res.usage.costMicroUsd).toBeGreaterThan(5_250);
  });
});

// ---- 失敗の分類 ----

describe("失敗の分類（toLlmError）", () => {
  const apiError = (status: number, message = '{"error":{"code":0,"message":"x","status":"X"}}') => new ApiError({ message, status });

  it("429・5xx（と 408）はやり直す（status つき）", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const e = toLlmError(apiError(status));
      expect(e).toBeInstanceOf(LlmError);
      expect(e).toMatchObject({ status, retryable: true });
    }
  });

  it("400・401・403・404 はやり直さない", () => {
    for (const status of [400, 401, 403, 404]) expect(toLlmError(apiError(status))).toMatchObject({ status, retryable: false });
  });

  it("isRetryableStatus の境目", () => {
    const cases: Array<[number, boolean]> = [
      [407, false],
      [408, true],
      [409, false],
      [428, false],
      [429, true],
      [430, false],
      [499, false],
      [500, true],
      [599, true],
    ];
    for (const [status, retryable] of cases) expect(isRetryableStatus(status)).toBe(retryable);
  });

  it("ネットワークの失敗（fetch failed の cause のコード・Node のコード）は status null でやり直す", () => {
    const reset = toLlmError(new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }));
    expect(reset).toMatchObject({ status: null, retryable: true });
    expect(reset.message).toContain("ECONNRESET");
    expect(toLlmError(Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" }))).toMatchObject({ status: null, retryable: true });
    expect(toLlmError(new TypeError("fetch failed"))).toMatchObject({ status: null, retryable: true });
    expect(toLlmError(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } })).message).toContain("UND_ERR_SOCKET");
  });

  it("AbortError・TimeoutError（SDK のタイムアウト）は status null でやり直す", () => {
    expect(toLlmError(new DOMException("This operation was aborted", "AbortError"))).toMatchObject({ status: null, retryable: true });
    expect(toLlmError(new DOMException("timed out", "TimeoutError"))).toMatchObject({ status: null, retryable: true });
  });

  it("ほかの失敗（認証の設定がない等）はやり直さない", () => {
    const e = toLlmError(new Error("Could not load the default credentials."));
    expect(e).toMatchObject({ status: null, retryable: false });
    expect(e.message).toContain("Could not load the default credentials");
    expect(toLlmError("文字列で投げられた")).toMatchObject({ status: null, retryable: false });
    expect(toLlmError(new TypeError("x is not a function"))).toMatchObject({ retryable: false });
  });

  it("google-auth の失敗は response.status を見る", () => {
    expect(toLlmError(Object.assign(new Error("Service Unavailable"), { response: { status: 503 } }))).toMatchObject({
      status: 503,
      retryable: true,
    });
  });

  it("SyntaxError の文は出さない（応答の本文の断片が入りうる：SO §3.12-8）", () => {
    const e = toLlmError(new SyntaxError(`Unexpected token '秘', "秘密の応答の本文" is not valid JSON`));
    expect(e.message).not.toContain("秘密");
    expect(e).toMatchObject({ status: null, retryable: false });
  });

  it("エラーの文は1行・300文字ほどまで", () => {
    const e = toLlmError(apiError(400, `${"x".repeat(1_000)}\n二行目`));
    expect(e.message).not.toContain("\n");
    expect(e.message.length).toBeLessThan(400);
  });

  it("LlmError はそのまま", () => {
    const original = new LlmError("x", 503, true);
    expect(toLlmError(original)).toBe(original);
  });
});

// ---- GeminiClient ----

describe("GeminiClient：会話の往復（関数呼び出し・応答・署名・mcp_call）", () => {
  it("応答の署名と mcp_call を runner の形で返し、次の呼び出しで同じ部品・同じ ID・展開した名前で送り返す", async () => {
    const first = modelResponse([
      { text: "受信箱を確かめます", thoughtSignature: "sig-text-1" },
      { functionCall: { id: "fc-1", name: "mcp__mail__list_inbox", args: { limit: 5 } }, thoughtSignature: "sig-call-1" },
    ]);
    const second = modelResponse([
      { functionCall: { name: "mcp__supplier__place_order", args: ORDER_ARGS }, thoughtSignature: "sig-call-2" },
      { functionCall: { name: "submit_report", args: { title: "発注した", body: "20袋", sources: [] } } },
    ]);
    const fake = fakeGenerate(first, second);
    const client = new GeminiClient({ generateContent: fake.fn, newId: sequentialIds() });

    const req1 = request();
    const res1 = await client.generate(req1);
    expect(res1).toMatchObject({ model: "gemini-3.8-flash", stopReason: "tool_call" });
    expect(res1.parts).toEqual([
      { type: "text", text: "受信箱を確かめます", signature: "sig-text-1" },
      {
        type: "tool_call",
        id: "fc-1",
        name: "mcp_call",
        arguments: { connector: "mail", tool: "list_inbox", arguments: { limit: 5 } },
        signature: "sig-call-1",
      },
    ]);

    // runner が応答と結果を履歴に足して、もう一度呼ぶ
    const messages: ChatMessage[] = [
      ...req1.messages,
      { role: "assistant", content: res1.parts },
      { role: "tool", content: { toolCallId: "fc-1", name: "mcp_call", result: '<untrusted source="mcp:mail.list_inbox">値上がりの知らせ</untrusted>' } },
    ];
    const res2 = await client.generate(request({ messages }));
    expect(fake.calls[1]?.contents).toEqual([
      { role: "user", parts: [{ text: "在庫を見て、足りなければ発注してください" }] },
      {
        role: "model",
        parts: [
          { text: "受信箱を確かめます", thoughtSignature: "sig-text-1" },
          { functionCall: { id: "fc-1", name: "mcp__mail__list_inbox", args: { limit: 5 } }, thoughtSignature: "sig-call-1" },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "fc-1",
              name: "mcp__mail__list_inbox",
              response: { output: '<untrusted source="mcp:mail.list_inbox">値上がりの知らせ</untrusted>' },
            },
          },
        ],
      },
    ]);
    expect(res2.parts).toEqual([
      {
        type: "tool_call",
        id: "gen-1",
        name: "mcp_call",
        arguments: { connector: "supplier", tool: "place_order", arguments: ORDER_ARGS },
        signature: "sig-call-2",
      },
      { type: "tool_call", id: "gen-2", name: "submit_report", arguments: { title: "発注した", body: "20袋", sources: [] } },
    ]);
  });

  it("署名の往復は何回くり返しても変わらない（性質：応答 → 履歴 → 要求）", async () => {
    const fake = fakeGenerate(
      ...Array.from({ length: 10 }, (_, i) =>
        modelResponse([
          { text: `手順${i}`, thoughtSignature: `sig-t-${i}` },
          { functionCall: { id: `c-${i}`, name: i % 2 === 0 ? "mcp__mail__list_inbox" : "mcp__supplier__place_order", args: { n: i } }, thoughtSignature: `sig-c-${i}` },
        ]),
      ),
    );
    const client = new GeminiClient({ generateContent: fake.fn });
    let messages: ChatMessage[] = [{ role: "user", content: "始めて" }];
    for (let i = 0; i < 10; i++) {
      const res = await client.generate(request({ messages }));
      messages = [...messages, { role: "assistant", content: res.parts }, { role: "tool", content: { toolCallId: `c-${i}`, name: "mcp_call", result: `結果${i}` } }];
    }
    const last = fake.calls[9]?.contents as Array<{ role: string; parts: Part[] }>;
    const modelParts = last.filter((c) => c.role === "model").flatMap((c) => c.parts);
    expect(modelParts.map((p) => p.thoughtSignature)).toEqual(Array.from({ length: 9 }, (_, i) => [`sig-t-${i}`, `sig-c-${i}`]).flat());
    const responses = last.filter((c) => c.role === "user").flatMap((c) => c.parts).filter((p) => p.functionResponse !== undefined);
    expect(responses.map((p) => [p.functionResponse?.id, p.functionResponse?.name])).toEqual(
      Array.from({ length: 9 }, (_, i) => [`c-${i}`, i % 2 === 0 ? "mcp__mail__list_inbox" : "mcp__supplier__place_order"]),
    );
  });

  it("構造化出力の応答は文字の部品で返る（呼び出し側が Zod で検証する）", async () => {
    const json = '{"scenarios":[{"faults":[{"id":"F-02"}]}]}';
    const fake = fakeGenerate(modelResponse([{ text: json }]));
    const res = await new GeminiClient({ generateContent: fake.fn }).generate(
      request({ model: "gemini-3.1-pro-preview", tools: [], mcpTools: [], responseJsonSchema: { type: "object" } }),
    );
    expect(res.parts).toEqual([{ type: "text", text: json }]);
    expect(res.stopReason).toBe("stop");
    expect(fake.calls[0]?.config?.responseMimeType).toBe("application/json");
  });

  it("SDK には abortSignal つきの config を渡す", async () => {
    const fake = fakeGenerate(modelResponse([{ text: "ok" }]));
    await new GeminiClient({ generateContent: fake.fn }).generate(request());
    expect(fake.calls[0]?.config?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(fake.calls[0]?.config?.maxOutputTokens).toBe(8_000);
  });

  it("会話が空なら呼ばずに LlmError（やり直さない）", async () => {
    const fake = fakeGenerate(modelResponse([{ text: "ok" }]));
    await expect(new GeminiClient({ generateContent: fake.fn }).generate(request({ messages: [] }))).rejects.toMatchObject({
      status: null,
      retryable: false,
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("SO §3.12-2・07:284：価格表にないモデルは既定で呼ばない（送る前に LlmError。status null・やり直さない・onRetry も呼ばない）", async () => {
    const fake = fakeGenerate(modelResponse([{ text: "ok" }]));
    const retries: RetryInfo[] = [];
    const client = new GeminiClient({ generateContent: fake.fn, retry: { delaysMs: [0, 0], sleep: async () => {}, onRetry: (i) => retries.push(i) } });
    for (const model of ["gemini-9-ultra", "gemini-3.8-flash-002", "gemini-2.5", ""]) {
      const err = await client.generate(request({ model })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect(err).toMatchObject({ status: null, retryable: false });
      expect((err as Error).message).toContain("価格表にないモデル");
    }
    expect(fake.calls).toHaveLength(0);
    expect(retries).toEqual([]);
    // 長いモデル ID は切って文に入れる
    expect(unpricedModelError("x".repeat(500)).message.length).toBeLessThan(200);
  });

  it("価格表のモデルは今までどおり呼ぶ（大文字・publishers/ の接頭辞は normalizeModelId で表の行に当たる）", async () => {
    for (const model of [...PRICE_TABLE.map((p) => p.model), "GEMINI-3.8-FLASH", "publishers/google/models/gemini-3.1-pro-preview"]) {
      const fake = fakeGenerate(modelResponse([{ text: "ok" }]));
      await expect(new GeminiClient({ generateContent: fake.fn }).generate(request({ model }))).resolves.toMatchObject({ model });
      expect(fake.calls).toHaveLength(1);
    }
  });

  it("allowUnpricedModels を明示したときだけ表にないモデルを呼び、費用は高めの単価（FALLBACK_PRICE）で数える", async () => {
    const usageMetadata = { promptTokenCount: 1_000, candidatesTokenCount: 200, thoughtsTokenCount: 300 };
    const fake = fakeGenerate({ ...modelResponse([{ text: "ok" }]), usageMetadata });
    const res = await new GeminiClient({ generateContent: fake.fn, allowUnpricedModels: true }).generate(request({ model: "gemini-9-ultra" }));
    expect(fake.calls[0]?.model).toBe("gemini-9-ultra");
    expect(res.model).toBe("gemini-9-ultra");
    expect(res.usage.costMicroUsd).toBe(
      Math.ceil((1_000 * FALLBACK_PRICE.inputPerMTokMicroUsd + 200 * FALLBACK_PRICE.outputPerMTokMicroUsd + 300 * FALLBACK_PRICE.thinkingPerMTokMicroUsd) / 1_000_000),
    );
    // 同じ使用量でも表のモデルより高い（費用の上限が甘くならない側）
    expect(res.usage.costMicroUsd).toBeGreaterThan(costMicroUsd("gemini-3.1-pro-preview", { inputTokens: 1_000, outputTokens: 200, thinkingTokens: 300 }));
    // false を明示しても既定と同じ（呼ばない）
    const off = fakeGenerate(modelResponse([{ text: "ok" }]));
    await expect(new GeminiClient({ generateContent: off.fn, allowUnpricedModels: false }).generate(request({ model: "gemini-9-ultra" }))).rejects.toBeInstanceOf(LlmError);
    expect(off.calls).toHaveLength(0);
  });

  it("GeminiClient は LlmClient として使える", async () => {
    const client: LlmClient = new GeminiClient({ generateContent: fakeGenerate(modelResponse([{ text: "ok" }])).fn });
    await expect(client.generate(request())).resolves.toMatchObject({ parts: [{ type: "text", text: "ok" }] });
  });
});

describe("GeminiClient：再試行・タイムアウト・中断", () => {
  it("HL-13 / SO-BUD-13：503 が4回続くと 1・4・16秒あけて3回やり直し、LlmError(503・retryable) を投げる", async () => {
    const fake = fakeGenerate(...Array.from({ length: 4 }, () => new ApiError({ message: "unavailable", status: 503 })));
    const delays: number[] = [];
    const client = new GeminiClient({ generateContent: fake.fn, retry: { sleep: async (ms) => void delays.push(ms) } });
    const error = await client.generate(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ status: 503, retryable: true });
    expect(fake.calls).toHaveLength(4);
    expect(delays).toEqual([1_000, 4_000, 16_000]);
  });

  it("429 のあと通れば応答を返し、onRetry に失敗した回を渡す", async () => {
    const fake = fakeGenerate(new ApiError({ message: "quota", status: 429 }), modelResponse([{ text: "ok" }]));
    const retries: RetryInfo[] = [];
    const client = new GeminiClient({ generateContent: fake.fn, retry: { ...noWait, onRetry: (i) => retries.push(i) } });
    const res = await client.generate(request());
    expect(res.parts).toEqual([{ type: "text", text: "ok" }]);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ retry: 1, delayMs: 1_000, error: { status: 429, retryable: true } });
  });

  it("400 はやり直さず、すぐ LlmError(400)", async () => {
    const fake = fakeGenerate(new ApiError({ message: "bad request", status: 400 }), modelResponse([{ text: "ok" }]));
    await expect(new GeminiClient({ generateContent: fake.fn, retry: noWait }).generate(request())).rejects.toMatchObject({
      status: 400,
      retryable: false,
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("ネットワークの失敗はやり直す", async () => {
    const fake = fakeGenerate(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }), modelResponse([{ text: "ok" }]));
    const res = await new GeminiClient({ generateContent: fake.fn, retry: noWait }).generate(request());
    expect(res.parts).toEqual([{ type: "text", text: "ok" }]);
    expect(fake.calls).toHaveLength(2);
  });

  it("タイムアウトの既定は120秒", () => {
    expect(LLM_TIMEOUT_MS).toBe(120_000);
  });

  it("タイムアウト：応答がなければ timeoutMs で打ち切り、status null の retryable（やり直しも同じ時間で打ち切る）", async () => {
    let calls = 0;
    const never: GenerateContentFn = () => {
      calls++;
      return new Promise(() => {});
    };
    const client = new GeminiClient({ generateContent: never, timeoutMs: 20, retry: { delaysMs: [0], sleep: async () => {} } });
    const started = Date.now();
    const error = await client.generate(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ status: null, retryable: true });
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("タイムアウトで SDK に渡した abortSignal を中断する", async () => {
    let seen: AbortSignal | undefined;
    const fn: GenerateContentFn = (params) => {
      seen = params.config?.abortSignal;
      return new Promise(() => {});
    };
    await new GeminiClient({ generateContent: fn, timeoutMs: 5, retry: { delaysMs: [] } }).generate(request()).catch(() => undefined);
    expect(seen?.aborted).toBe(true);
  });

  it("SDK が自分のタイムアウトで AbortError を投げたときも status null の retryable", async () => {
    const fake = fakeGenerate(new DOMException("This operation was aborted", "AbortError"));
    await expect(new GeminiClient({ generateContent: fake.fn, retry: { delaysMs: [] } }).generate(request())).rejects.toMatchObject({
      status: null,
      retryable: true,
    });
  });

  it("SO-KS-07：呼び出し中に中断（Kill Switch）すると、応答を待たずに中断の LlmError（やり直さない）", async () => {
    const ctrl = new AbortController();
    let calls = 0;
    let seen: AbortSignal | undefined;
    const slow: GenerateContentFn = (params) => {
      calls++;
      seen = params.config?.abortSignal;
      return new Promise(() => {}); // 60秒かかる偽の LLM の代わり（返らない）
    };
    const client = new GeminiClient({ generateContent: slow, retry: noWait });
    const started = Date.now();
    const p = client.generate(request(), { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 5);
    await expect(p).rejects.toMatchObject({ status: null, retryable: false });
    expect(calls).toBe(1);
    expect(seen?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("中断のあとに SDK が失敗を返しても、中断として扱う", async () => {
    const ctrl = new AbortController();
    const fn: GenerateContentFn = () => {
      ctrl.abort();
      return Promise.reject(new ApiError({ message: "unavailable", status: 503 }));
    };
    await expect(new GeminiClient({ generateContent: fn, retry: noWait }).generate(request(), { signal: ctrl.signal })).rejects.toMatchObject({
      status: null,
      retryable: false,
    });
  });

  it("中断済みなら呼ばない", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fake = fakeGenerate(modelResponse([{ text: "ok" }]));
    await expect(new GeminiClient({ generateContent: fake.fn }).generate(request(), { signal: ctrl.signal })).rejects.toMatchObject({
      retryable: false,
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("同期で投げる generateContent の失敗も LlmError にする", async () => {
    const fn: GenerateContentFn = () => {
      throw new ApiError({ message: "bad", status: 400 });
    };
    await expect(new GeminiClient({ generateContent: fn, retry: noWait }).generate(request())).rejects.toMatchObject({ status: 400 });
  });
});

describe("Vertex AI のクライアント（ADR-032：API キーを使わず ADC で呼ぶ）", () => {
  type Internals = {
    apiKey?: string;
    apiClient: {
      isVertexAI(): boolean;
      getProject(): string | undefined;
      getLocation(): string | undefined;
      getBaseUrl(): string;
      clientOptions: {
        apiKey?: string;
        auth: { apiKey?: string; googleAuth?: unknown };
        httpOptions?: { timeout?: number; retryOptions?: unknown };
      };
    };
  };

  it("generateContent を渡さず project もなければ作らない", () => {
    expect(() => new GeminiClient({})).toThrow(/GOOGLE_CLOUD_PROJECT/);
    expect(() => new GeminiClient({ project: "  " })).toThrow(/GOOGLE_CLOUD_PROJECT/);
  });

  it("project があれば作れる（作るだけでは通信しない）", () => {
    expect(() => new GeminiClient({ project: "open-team-hack" })).not.toThrow();
  });

  it("vertexai・project・location で作り、環境変数の GEMINI_API_KEY・GOOGLE_API_KEY を使わない（認証は ADC）", () => {
    vi.stubEnv("GEMINI_API_KEY", "must-not-be-used-1");
    vi.stubEnv("GOOGLE_API_KEY", "must-not-be-used-2");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const ai = createVertexAi({ project: "open-team-hack", location: "global", timeoutMs: LLM_TIMEOUT_MS });
    debug.mockRestore();
    const internals = ai as unknown as Internals;
    expect(ai.vertexai).toBe(true);
    expect(internals.apiKey).toBeUndefined();
    expect(internals.apiClient.clientOptions.apiKey).toBeUndefined();
    expect(internals.apiClient.clientOptions.auth.apiKey).toBeUndefined();
    expect(internals.apiClient.clientOptions.auth.googleAuth).toBeDefined();
    expect(internals.apiClient.isVertexAI()).toBe(true);
    expect(internals.apiClient.getProject()).toBe("open-team-hack");
    expect(internals.apiClient.getLocation()).toBe("global");
    expect(internals.apiClient.getBaseUrl()).toBe("https://aiplatform.googleapis.com/");
  });

  it("SDK の再試行は使わず（やり直しは withRetry の1か所）、タイムアウトは120秒", () => {
    const ai = createVertexAi({ project: "p", location: "asia-northeast1", timeoutMs: LLM_TIMEOUT_MS });
    const internals = ai as unknown as Internals;
    expect(internals.apiClient.clientOptions.httpOptions?.retryOptions).toBeUndefined();
    expect(internals.apiClient.clientOptions.httpOptions?.timeout).toBe(120_000);
    expect(internals.apiClient.getBaseUrl()).toBe("https://asia-northeast1-aiplatform.googleapis.com/");
  });
});

describe("Google 検索の Grounding（web_search）", () => {
  it("googleSearch のときは関数の宣言・構造化出力を渡さず googleSearch のツールだけ", () => {
    const { params } = toGeminiRequest(request({ googleSearch: true, responseJsonSchema: { type: "object" } }));
    expect(params.config.tools).toEqual([{ googleSearch: {} }]);
    expect(params.config.responseJsonSchema).toBeUndefined();
    expect(params.config.responseMimeType).toBeUndefined();
  });

  it("検索の語句と出典（URL で重なりを除く）を返し、検索の回数を費用に足す", () => {
    const res: GeminiResponse = {
      ...modelResponse([{ text: "Claude Opus 5.5 は Anthropic のモデルです。" }]),
    };
    res.candidates![0]!.groundingMetadata = {
      webSearchQueries: ["Claude Opus 5.5", "Anthropic Opus 5.5 release", ""],
      groundingChunks: [
        { web: { uri: "https://a.example/1", title: "anthropic.com" } },
        { web: { uri: "https://a.example/1", title: "dup" } },
        { web: { uri: "https://b.example/2", domain: "example.com" } },
        { web: {} },
      ],
    };
    const out = fromGeminiResponse(res, ctxFor());
    expect(out.grounding).toEqual({
      queries: ["Claude Opus 5.5", "Anthropic Opus 5.5 release"],
      sources: [
        { title: "anthropic.com", url: "https://a.example/1" },
        { title: "example.com", url: "https://b.example/2" },
      ],
    });
    const plain = fromGeminiResponse(modelResponse([{ text: "Claude Opus 5.5 は Anthropic のモデルです。" }]), ctxFor());
    expect(plain.grounding).toBeUndefined();
    expect(out.usage.costMicroUsd - plain.usage.costMicroUsd).toBe(2 * GROUNDING_QUERY_MICRO_USD);
  });
});
