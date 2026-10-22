// 試験の edge（偽の gateway・ScriptedLlmClient・手で進める時計）。DB は @open-team/db/testing の試験ごとのデータベース

import type { GatewayClient, GwExecuteResponse, GwToolsCallRequest, GwToolsCallResponse, GwToolsSyncResponse } from "@open-team/gateway-client";
import { DEFAULT_AGENT_MODEL, ScriptedLlmClient, type ScriptedResponder, type ScriptedStep } from "@open-team/llm";
import { manualClock, memoryLogger, type ManualClock } from "@open-team/platform";
import type { AssistantPart, EdgePort, LlmMessagesRequest } from "@open-team/runner";
import type { Db, IntentStatus, TaskStatus, Uuid } from "@open-team/db";
import { createEdge } from "../edge.ts";
import type { EdgeDeps } from "../runtime.ts";
import type { EdgeLimits, SpendLimits } from "../limits.ts";
import { T0 } from "./seed.ts";

export type ReadHandler = (req: GwToolsCallRequest, token: string) => GwToolsCallResponse | Promise<GwToolsCallResponse>;

/** 偽の gateway（EP-49 の読み取りだけ。edge は EP-50・51 を呼ばない） */
export class FakeGateway implements GatewayClient {
  readonly calls: Array<{ token: string; req: GwToolsCallRequest }> = [];
  handler: ReadHandler;
  constructor(handler?: ReadHandler) {
    this.handler = handler ?? ((req) => ({ ok: true, content: JSON.stringify({ tool: req.tool, items: [] }), isError: false, truncated: false }));
  }
  async callReadTool(token: string, req: GwToolsCallRequest): Promise<GwToolsCallResponse> {
    this.calls.push({ token, req: structuredClone(req) });
    return this.handler(req, token);
  }
  async executeIntent(): Promise<GwExecuteResponse> {
    throw new Error("edge は executeIntent を呼ばない（実行は app の intents：M-20）");
  }
  async syncTools(): Promise<GwToolsSyncResponse> {
    throw new Error("edge は syncTools を呼ばない");
  }
  async revokeCredential(): Promise<void> {
    throw new Error("edge は revokeCredential を呼ばない");
  }
}

export interface HookCall {
  hook: "onIntentRecorded" | "onReportSubmitted" | "onTaskTerminal";
  taskId: Uuid;
  status: IntentStatus | TaskStatus;
  intentId?: Uuid;
}

export interface TestEdge {
  edge: EdgePort;
  llm: ScriptedLlmClient;
  gateway: FakeGateway;
  clock: ManualClock;
  hooks: HookCall[];
  sleeps: number[];
  logs: ReturnType<typeof memoryLogger>;
}

export function buildEdge(
  db: Db,
  o: {
    script?: readonly ScriptedStep[] | ScriptedResponder;
    gateway?: FakeGateway;
    limits?: Partial<EdgeLimits>;
    spendLimits?: Partial<SpendLimits>;
    now?: Date;
    knownSecrets?: string[];
    extra?: Partial<EdgeDeps>;
  } = {},
): TestEdge {
  const clock = manualClock(o.now ?? T0);
  const llm = new ScriptedLlmClient(o.script ?? []);
  const gateway = o.gateway ?? new FakeGateway();
  const hooks: HookCall[] = [];
  const sleeps: number[] = [];
  const logs = memoryLogger();
  let seq = 0;
  const edge = createEdge({
    db,
    llm,
    gateway,
    clock,
    log: logs.logger,
    models: { agentModel: DEFAULT_AGENT_MODEL, plannerModel: DEFAULT_AGENT_MODEL },
    retry: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
    newId: () => `gen-${++seq}`,
    ...(o.limits ? { limits: o.limits } : {}),
    ...(o.spendLimits ? { spendLimits: o.spendLimits } : {}),
    ...(o.knownSecrets ? { knownSecrets: o.knownSecrets } : {}),
    hooks: {
      onIntentRecorded: (_ctx, e) => void hooks.push({ hook: "onIntentRecorded", taskId: e.taskId, status: e.status, intentId: e.intentId }),
      onReportSubmitted: (_ctx, e) => void hooks.push({ hook: "onReportSubmitted", taskId: e.taskId, status: e.status }),
      onTaskTerminal: (_ctx, e) => void hooks.push({ hook: "onTaskTerminal", taskId: e.taskId, status: e.status }),
    },
    ...o.extra,
  });
  return { edge, llm, gateway, clock, hooks, sleeps, logs };
}

// ---- LLM の応答の部品 ----

export const text = (t: string): AssistantPart => ({ type: "text", text: t });
export const call = (id: string, name: string, args: unknown = {}): AssistantPart => ({ type: "tool_call", id, name, arguments: args });
export const mcp = (id: string, connector: string, tool: string, args: Record<string, unknown> = {}): AssistantPart =>
  call(id, "mcp_call", { connector, tool, arguments: args });
export const report = (id: string, extra: Record<string, unknown> = {}): AssistantPart =>
  call(id, "submit_report", { title: "発注の報告", body: "豆が残り2kgなので20kg発注します。", sources: [], ...extra });

/** runner が送るのと同じ形の要求（ツールは文脈のツールの名前） */
export function llmRequest(tools: ReadonlyArray<{ name: string }>, o: Partial<LlmMessagesRequest> = {}): LlmMessagesRequest {
  return {
    phase: "plan",
    system: "あなたは試験のエージェントです。",
    messages: [{ role: "user", content: "仕事を始めてください。" }],
    tools: tools.map((t) => ({ name: t.name as LlmMessagesRequest["tools"][number]["name"], description: "", inputSchema: {} })),
    maxTokens: 1000,
    ...o,
  };
}

/** 決まった量の使用量（費用を決めるため） */
export const USAGE = { inputTokens: 1000, outputTokens: 100, thinkingTokens: 0 } as const;
