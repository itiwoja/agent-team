// runner の Harness（runTask）→ 偽の edge（判定は表で決める）→ GeminiClient（generateContent だけ偽物）を通しで動かし、
// Gemini に送る contents が毎回正しい形か（関数呼び出しと応答の数・順・ID・名前、署名の往復、mcp_call の展開と戻し）を確かめる。
// formation-runtime.md §3.8（応答の順に1つずつ・書き込みは Intent）、§3.10（edge が会話をそのまま LLM に渡す）
import type { Content, GenerateContentParameters, Part } from "@google/genai";
import { FinishReason } from "@google/genai";
import {
  EdgeError,
  runTask,
  selectTaskTools,
  templatePhases,
  type EdgePort,
  type GovernanceEntry,
  type LlmMessagesRequest,
  type LlmMessagesResponse,
  type McpToolSpec,
  type ProgressEvent,
  type TaskContext,
  type ToolCallPart,
  type ToolCallResult,
} from "@open-team/runner";
import { wrapUntrusted } from "@open-team/kernel";
import { describe, expect, it } from "vitest";
import { GeminiClient, type GeminiResponse, type GenerateContentFn } from "./gemini.ts";
import type { LlmClient } from "./types.ts";

// ---- 材料（用意した依頼の仕入れ係・受信箱係：formation-runtime.md §2.10） ----

const SUPPLIER_MCP: McpToolSpec[] = [
  { connector: "store", tool: "get_inventory", classification: "read", description: "在庫を返す", inputSchema: { type: "object" } },
  { connector: "supplier", tool: "list_products", classification: "read", description: "商品と単価を返す", inputSchema: { type: "object" } },
  { connector: "supplier", tool: "place_order", classification: "write", description: "発注する", inputSchema: { type: "object" } },
  { connector: "bank", tool: "register_payee", classification: "write", description: "振込先を登録する", inputSchema: { type: "object" } },
];
const INBOX_MCP: McpToolSpec[] = [
  { connector: "mail", tool: "list_inbox", classification: "read", description: "受信箱を読む", inputSchema: { type: "object" } },
];

function context(kind: "supplier" | "inbox"): TaskContext {
  const supplier = kind === "supplier";
  return {
    taskId: supplier ? "task-supplier" : "task-inbox",
    runKind: "live",
    isDryRun: false,
    template: supplier ? "assistant" : "researcher",
    phases: templatePhases(supplier ? "assistant" : "researcher"),
    tools: selectTaskTools({
      template: supplier ? "assistant" : "researcher",
      mcpGrants: supplier ? { store: ["get_inventory"], supplier: ["list_products", "place_order"], bank: ["register_payee"] } : { mail: ["list_inbox"] },
      webAllowDomains: [],
      guestWorkspace: true,
      formation: null,
      teamBoard: false,
      followup: false,
    }),
    mcpTools: structuredClone(supplier ? SUPPLIER_MCP : INBOX_MCP),
    policySummary: [],
    policy: {},
    agent: { name: supplier ? "仕入れ係" : "受信箱係", jobInstructions: "仕事の指示", tuning: null, skills: [], memories: [] },
    input: { prompt: "在庫を見て、必要なら発注して", handoffs: [], teamMessages: [] },
    formation: null,
    now: "2026-10-03T18:00:00+09:00",
    limits: { maxTokens: 8000 },
  };
}

// ---- 偽の edge（判定は表、書き込みは Intent、callTool は判定の記録で1回だけ：§3.10-9・§3.11-2） ----

type Verdict = Omit<GovernanceEntry, "toolCallId">;

class GovernedEdge implements EdgePort {
  readonly events: ProgressEvent[] = [];
  readonly executed: string[] = [];
  readonly calls = new Map<string, { part: ToolCallPart; verdict: Verdict; done: boolean }>();
  private readonly ctx: TaskContext;
  private readonly llm: LlmClient;
  private readonly verdictOf: (part: ToolCallPart) => Verdict;
  private readonly resultOf: (part: ToolCallPart) => ToolCallResult;
  constructor(
    ctx: TaskContext,
    llm: LlmClient,
    verdictOf: (part: ToolCallPart) => Verdict,
    resultOf: (part: ToolCallPart) => ToolCallResult,
  ) {
    this.ctx = ctx;
    this.llm = llm;
    this.verdictOf = verdictOf;
    this.resultOf = resultOf;
  }

  async getTaskContext(): Promise<TaskContext> {
    return structuredClone(this.ctx);
  }

  async llmMessages(_token: string, req: LlmMessagesRequest): Promise<LlmMessagesResponse> {
    const res = await this.llm.generate({
      model: "gemini-3.8-flash",
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      mcpTools: this.ctx.mcpTools,
      maxTokens: req.maxTokens,
    });
    const governance: GovernanceEntry[] = [];
    for (const part of res.parts) {
      if (part.type !== "tool_call") continue;
      // 判定の記録は toolCallId が鍵（同じ ID の2回目は記録を上書きせずに、実行済みとして断る側に倒す）
      const verdict = this.verdictOf(part);
      if (!this.calls.has(part.id)) this.calls.set(part.id, { part, verdict, done: false });
      governance.push({ toolCallId: part.id, ...verdict });
    }
    return {
      model: res.model,
      content: res.parts,
      stopReason: res.stopReason,
      usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens + res.usage.thinkingTokens, costUsd: "0.000001" },
      governance,
      budget: { costUsd: "0.000001", stepsUsed: 1 },
    };
  }

  async postEvents(_token: string, events: ProgressEvent[]): Promise<{ accepted: number; dropped: number }> {
    this.events.push(...structuredClone(events));
    return { accepted: events.length, dropped: 0 };
  }

  async callTool(_token: string, toolCallId: string): Promise<ToolCallResult> {
    const rec = this.calls.get(toolCallId);
    // ない・allow でない・実行済み → 403（§3.11-2）
    if (rec === undefined || rec.verdict.decision !== "allow" || rec.verdict.intent !== undefined || rec.done) {
      throw new EdgeError("TOOL_CALL_NOT_ALLOWED");
    }
    rec.done = true;
    this.executed.push(toolCallId);
    return this.resultOf(rec.part);
  }
}

// ---- 偽の Gemini（台本の応答を順に返し、送られた contents を写して残す） ----

function scripted(...steps: Part[][]): { fn: GenerateContentFn; sent: GenerateContentParameters[] } {
  const sent: GenerateContentParameters[] = [];
  const fn: GenerateContentFn = async (params) => {
    sent.push(structuredClone({ ...params, config: { ...params.config, abortSignal: undefined } }));
    const parts = steps[sent.length - 1];
    if (parts === undefined) throw new Error("偽の Gemini：応答の用意がない");
    const res: GeminiResponse = {
      candidates: [{ content: { role: "model", parts }, finishReason: FinishReason.STOP }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
    };
    return res;
  };
  return { fn, sent };
}

/**
 * 送る contents の形の決まり（Gemini の関数呼び出し）：
 * user で始まり user で終わる（model の発言で終わる要求は 400 になりうる）／同じ役割が続かない／
 * 関数呼び出しのある model の次は user で、その先頭に呼び出しと同じ数・同じ順・同じ ID と名前の関数の応答がある／
 * 前の呼び出しのない関数の応答はない
 */
function expectWellFormed(contents: Content[]): void {
  expect(contents[0]?.role).toBe("user");
  expect(contents.at(-1)?.role).toBe("user");
  for (let i = 1; i < contents.length; i++) expect(contents[i]?.role).not.toBe(contents[i - 1]?.role);
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i]!;
    const parts = c.parts ?? [];
    if (c.role === "model") {
      const calls = parts.filter((p) => p.functionCall !== undefined).map((p) => p.functionCall!);
      const next = contents[i + 1]?.parts ?? [];
      const responses = next.filter((p) => p.functionResponse !== undefined).map((p) => p.functionResponse!);
      expect(responses.map((r) => [r.id, r.name])).toEqual(calls.map((fc) => [fc.id, fc.name]));
      // 応答は user の先頭にまとまる（並列の呼び出しの応答は1つの Content）
      expect(next.slice(0, responses.length).every((p) => p.functionResponse !== undefined)).toBe(true);
      for (const fc of calls) expect(fc.args).toBeTypeOf("object");
    } else {
      const prevCalls = (contents[i - 1]?.parts ?? []).filter((p) => p.functionCall !== undefined).length;
      expect(parts.filter((p) => p.functionResponse !== undefined)).toHaveLength(prevCalls);
    }
  }
}

const allowAll = (): Verdict => ({ decision: "allow", reasonCode: "autonomy_auto" });
const noWait = { signal: new AbortController().signal, sleep: async () => {} };

describe("runner → edge → GeminiClient の往復（§3.8・§3.10）", () => {
  it("HL-17・A-87 テキストと並列の読み取り → 次のフェーズ → 並列の書き込み（Intent）→ 報告：毎回の contents が正しい形で、署名と ID がそのまま返る", async () => {
    const gemini = scripted(
      // 計画：テキスト＋並列の読み取り（署名は最初の部品と最初の呼び出しだけ）
      [
        { text: "在庫と商品を確かめます", thoughtSignature: "sig-text" },
        { functionCall: { name: "mcp__store__get_inventory", args: {} }, thoughtSignature: "sig-call" },
        { functionCall: { name: "mcp__supplier__list_products" } },
      ],
      // 計画の終わり（ツール呼び出しなし）→ 実行へ
      [{ text: "豆を20kg発注します" }, { text: "", thoughtSignature: "sig-end" }],
      // 実行：並列の書き込み（1つは確認待ち、1つは拒否）とテキスト
      [
        { functionCall: { id: "w-1", name: "mcp__supplier__place_order", args: { supplier_id: "supplier-01", items: [{ sku: "BEAN", quantity: 20 }] } }, thoughtSignature: "sig-w" },
        { text: "振込先も登録します" },
        { functionCall: { id: "w-2", name: "mcp__bank__register_payee", args: { account: "731-5502846" } } },
      ],
      // 報告
      [{ functionCall: { id: "r-1", name: "submit_report", args: { title: "発注", body: "豆を20kg発注しました", sources: [] } } }],
    );
    let n = 0;
    const llm = new GeminiClient({ generateContent: gemini.fn, newId: () => `gen-${++n}` });
    const edge = new GovernedEdge(
      context("supplier"),
      llm,
      (part) => {
        const args = part.arguments as { tool?: string };
        if (part.name === "mcp_call" && args.tool === "place_order") return { decision: "approve", reasonCode: "approval_required", intent: { intentId: "i-1", status: "pending_approval" } };
        if (part.name === "mcp_call" && args.tool === "register_payee") return { decision: "deny", reasonCode: "not_granted", intent: { intentId: "i-2", status: "denied" } };
        return allowAll();
      },
      (part) => {
        if (part.name === "submit_report") return { kind: "report_accepted", taskId: "task-supplier" };
        const args = part.arguments as { connector: string; tool: string };
        return { kind: "text", text: wrapUntrusted(`mcp:${args.connector}.${args.tool}`, "{}") };
      },
    );

    const result = await runTask(edge, "token", noWait);

    expect(result).toEqual({ end: "report_submitted", turns: 4 });
    // 読み取り2つと報告だけ実行（書き込みは Intent：A-87）
    expect(edge.executed).toEqual(["gen-1", "gen-2", "r-1"]);
    expect(gemini.sent).toHaveLength(4);
    for (const params of gemini.sent) expectWellFormed(params.contents as Content[]);

    // 2回目：計画の応答（テキスト・署名・ID なしの呼び出しは作った ID）がそのまま返る。引数のない呼び出しは args: {}
    const second = gemini.sent[1]!.contents as Content[];
    expect(second[1]).toEqual({
      role: "model",
      parts: [
        { text: "在庫と商品を確かめます", thoughtSignature: "sig-text" },
        { functionCall: { id: "gen-1", name: "mcp__store__get_inventory", args: {} }, thoughtSignature: "sig-call" },
        { functionCall: { id: "gen-2", name: "mcp__supplier__list_products", args: {} } },
      ],
    });
    expect(second[2]?.parts?.map((p) => p.functionResponse?.response)).toEqual([
      { output: wrapUntrusted("mcp:store.get_inventory", "{}") },
      { output: wrapUntrusted("mcp:supplier.list_products", "{}") },
    ]);

    // 3回目：テキストだけの応答（署名だけの空の部品を含む）のあとに、次のフェーズへの user が続く
    const third = gemini.sent[2]!.contents as Content[];
    expect(third.at(-2)).toEqual({ role: "model", parts: [{ text: "豆を20kg発注します" }, { text: "", thoughtSignature: "sig-end" }] });
    expect(third.at(-1)).toEqual({ role: "user", parts: [{ text: "次のフェーズ「実行」に進んでください。" }] });

    // 4回目：テキストを挟んだ並列の書き込みの応答は Intent の {intentId, status} だけ（応答の順のまま）
    const fourth = gemini.sent[3]!.contents as Content[];
    expect(fourth.at(-2)?.parts?.map((p) => (p.functionCall ? `call:${p.functionCall.name}` : `text:${p.text}`))).toEqual([
      "call:mcp__supplier__place_order",
      "text:振込先も登録します",
      "call:mcp__bank__register_payee",
    ]);
    expect(fourth.at(-1)?.parts?.map((p) => [p.functionResponse?.id, p.functionResponse?.response])).toEqual([
      ["w-1", { output: '{"intentId":"i-1","status":"pending_approval"}' }],
      ["w-2", { output: '{"intentId":"i-2","status":"denied"}' }],
    ]);
    // テキストは進捗の message、ツールは tool_called（書き込みは mcp_call の名前で）
    expect(edge.events.filter((e) => e.type === "message").map((e) => (e.type === "message" ? e.payload.text : ""))).toEqual([
      "在庫と商品を確かめます",
      "豆を20kg発注します",
      "振込先も登録します",
    ]);
  });

  it("§3.11-2 モデルが前の応答と同じ ID を返しても、2回目の読み取りが「実行済み」で断られない（ID はタスクの中で重ねない）", async () => {
    const gemini = scripted(
      [{ functionCall: { id: "call-1", name: "mcp__mail__list_inbox", args: {} } }],
      [{ functionCall: { id: "call-1", name: "mcp__mail__list_inbox", args: { limit: 1 } } }],
      [{ functionCall: { id: "call-1", name: "submit_report", args: { title: "新着", body: "2通", sources: [] } } }],
    );
    const edge = new GovernedEdge(context("inbox"), new GeminiClient({ generateContent: gemini.fn }), allowAll, (part) =>
      part.name === "submit_report" ? { kind: "report_accepted", taskId: "task-inbox" } : { kind: "text", text: wrapUntrusted("mcp:mail.list_inbox", "メール") },
    );

    const result = await runTask(edge, "token", noWait);

    expect(result.end).toBe("report_submitted");
    expect(edge.executed).toHaveLength(3);
    expect(new Set(edge.executed).size).toBe(3);
    for (const params of gemini.sent) expectWellFormed(params.contents as Content[]);
  });

  it("cat:79・HL-03 引数のない finish（args なし）は finished(unable)。理由は決まった文", async () => {
    const gemini = scripted([{ text: "続けられません" }, { functionCall: { name: "finish" } }]);
    const edge = new GovernedEdge(context("inbox"), new GeminiClient({ generateContent: gemini.fn }), allowAll, () => ({ kind: "text", text: "" }));

    const result = await runTask(edge, "token", noWait);

    expect(result.finished).toEqual({ outcome: "unable", reason: "理由が書かれていません", by: "agent" });
    expect(edge.events.at(-1)).toEqual({ type: "finished", payload: { outcome: "unable", reason: "理由が書かれていません" } });
  });

  it("§8-36・§3.8 性質：ランダムな応答の列（テキスト・並列の呼び出し・ID なし／重なる ID・引数なし・署名・空の応答・知らない関数）でも、毎回の contents が正しい形で、ID は重ならず、必ず終わる", async () => {
    // 決まった種の擬似乱数（mulberry32）。試験の再現のため
    const rng = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const READS = ["mcp__store__get_inventory", "mcp__supplier__list_products"];
    const WRITES = ["mcp__supplier__place_order", "mcp__bank__register_payee"];
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
      const usedIds: string[] = [];
      const steps: Part[][] = [];
      const length = 1 + Math.floor(r() * 7);
      for (let s = 0; s < length; s++) {
        const parts: Part[] = [];
        const n = Math.floor(r() * 5);
        for (let k = 0; k < n; k++) {
          const roll = r();
          const sig = r() < 0.3 ? { thoughtSignature: `sig-${seed}-${s}-${k}` } : {};
          if (roll < 0.25) {
            parts.push({ text: r() < 0.2 ? "" : `手順${s}-${k}`, ...sig });
            continue;
          }
          const name = roll < 0.55 ? pick(READS) : roll < 0.8 ? pick(WRITES) : roll < 0.9 ? "notify" : "remember";
          // ID：なし／新しい／前に使った ID の使い回し
          const idRoll = r();
          const id = idRoll < 0.4 ? undefined : idRoll < 0.8 || usedIds.length === 0 ? `m-${seed}-${s}-${k}` : pick(usedIds);
          if (id !== undefined) usedIds.push(id);
          const args = r() < 0.3 ? undefined : { n: k };
          parts.push({ functionCall: { ...(id !== undefined ? { id } : {}), name, ...(args ? { args } : {}) }, ...sig });
        }
        steps.push(parts);
      }
      const sent: GenerateContentParameters[] = [];
      const generateContent: GenerateContentFn = async (params) => {
        sent.push(structuredClone({ ...params, config: { ...params.config, abortSignal: undefined } }));
        // 台本が尽きたら報告で終える
        const parts = steps[sent.length - 1] ?? [{ functionCall: { id: "dup", name: "submit_report", args: { title: "t", body: "b", sources: [] } } }];
        return { candidates: [{ content: { role: "model", parts }, finishReason: FinishReason.STOP }], usageMetadata: { promptTokenCount: 1 } };
      };
      const edge = new GovernedEdge(
        context("supplier"),
        new GeminiClient({ generateContent }),
        (part) => {
          const tool = (part.arguments as { tool?: string } | null)?.tool;
          if (part.name === "mcp_call" && (tool === "place_order" || tool === "register_payee")) {
            return { decision: "approve", reasonCode: "approval_required", intent: { intentId: `i-${part.id}`, status: "pending_approval" } };
          }
          if (part.name === "remember") return { decision: "deny", reasonCode: "not_granted" };
          return allowAll();
        },
        (part) => (part.name === "submit_report" ? { kind: "report_accepted", taskId: "task-supplier" } : { kind: "text", text: "結果" }),
      );

      const result = await runTask(edge, "token", { ...noWait, maxTurns: 30 });

      expect(["report_submitted", "finished"], `seed ${seed}`).toContain(result.end);
      for (const params of sent) expectWellFormed(params.contents as Content[]);
      // 判定の記録（toolCallId が鍵）はタスクの中で重ならない（最後の要求の履歴が会話の全体）
      const history = (sent.at(-1)?.contents ?? []) as Content[];
      const ids = history.flatMap((c) => (c.parts ?? []).flatMap((x) => (x.functionCall?.id ? [x.functionCall.id] : [])));
      expect(new Set(ids).size, `seed ${seed}`).toBe(ids.length);
      // 実行したのは allow の呼び出しだけで、どれも1回
      expect(new Set(edge.executed).size, `seed ${seed}`).toBe(edge.executed.length);
    }
  });

  it("§8-7 空の応答のあとも model で終わる要求を送らない（フェーズを進める user が続き、同じ役割はまとめる）", async () => {
    const gemini = scripted(
      [{ functionCall: { name: "mcp__mail__list_inbox", args: {} } }],
      [],
      [],
      [{ functionCall: { name: "submit_report", args: { title: "t", body: "b", sources: [] } } }],
    );
    const edge = new GovernedEdge(context("inbox"), new GeminiClient({ generateContent: gemini.fn }), allowAll, (part) =>
      part.name === "submit_report" ? { kind: "report_accepted", taskId: "task-inbox" } : { kind: "text", text: "メール" },
    );

    const result = await runTask(edge, "token", noWait);

    expect(result.end).toBe("report_submitted");
    for (const params of gemini.sent) expectWellFormed(params.contents as Content[]);
    // 関数の応答のあとに、次のフェーズへの user の文が同じ Content に続く
    const last = gemini.sent[3]!.contents as Content[];
    expect(last.at(-1)?.parts?.map((p) => (p.functionResponse ? "response" : p.text))).toEqual([
      "response",
      "次のフェーズ「整理」に進んでください。",
      "次のフェーズ「要約」に進んでください。",
    ]);
  });
});
