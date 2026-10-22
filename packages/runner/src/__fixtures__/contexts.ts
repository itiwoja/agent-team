// 試験用の TaskContext。用意した依頼（15:345-346、formation-runtime.md §2.10）と同じ形：受信箱係 → 仕入れ係の順番
// 受信箱係は researcher・mail.list_inbox だけ。仕入れ係は assistant・store / supplier / bank（M-36）。Web の付与なし

import type { McpToolSpec, TaskContext } from "../types.ts";
import { selectTaskTools } from "../tools.ts";
import { templatePhases } from "../templates.ts";

export const NOW = "2026-10-03T18:00:00+09:00";
export const ASK_ID = "a0000000-0000-4000-8000-000000000001";
export const INBOX_TASK_ID = "10000000-0000-4000-8000-000000000001";
export const SUPPLIER_TASK_ID = "10000000-0000-4000-8000-000000000002";

export const INBOX_MCP_TOOLS: McpToolSpec[] = [
  {
    connector: "mail",
    tool: "list_inbox",
    classification: "read",
    description: "受信箱のメールを新しい順に返す",
    inputSchema: { type: "object", properties: { limit: { type: "integer" } }, additionalProperties: false },
  },
];

export const SUPPLIER_MCP_TOOLS: McpToolSpec[] = [
  {
    connector: "supplier",
    tool: "place_order",
    classification: "write",
    description: "仕入れ先に発注する",
    inputSchema: { type: "object" },
  },
  {
    connector: "store",
    tool: "get_inventory",
    classification: "read",
    description: "在庫を返す",
    inputSchema: { type: "object" },
  },
  {
    connector: "supplier",
    tool: "list_products",
    classification: "read",
    description: "仕入れ先の商品と単価を返す",
    inputSchema: { type: "object" },
  },
  {
    connector: "bank",
    tool: "register_payee",
    classification: "write",
    description: "振込先を登録する",
    inputSchema: { type: "object" },
  },
];

const MEMBERS = [
  { name: "受信箱係", position: 1, isAggregator: false },
  { name: "仕入れ係", position: 2, isAggregator: false },
];

/** 受信箱係（順番の1段目・窓口でない） */
export function inboxContext(): TaskContext {
  return {
    taskId: INBOX_TASK_ID,
    runKind: "live",
    isDryRun: false,
    template: "researcher",
    phases: templatePhases("researcher"),
    tools: selectTaskTools({
      template: "researcher",
      mcpGrants: { mail: ["list_inbox"] },
      webAllowDomains: [],
      formation: { shape: "chain", memberCount: 2, isAggregator: false },
      teamBoard: false,
      followup: false,
    }),
    mcpTools: structuredClone(INBOX_MCP_TOOLS),
    policySummary: ["受信箱（mail）のメールを読めます", "外部のサービスには書き込めません", "1回あたり最大 $0.20、1日 $1.00 まで"],
    policy: {},
    agent: {
      name: "受信箱係",
      jobInstructions: "仕入れ先からの新しいメールを読み、数量・価格・振込先の変更を要約する",
      tuning: null,
      skills: [],
      memories: [],
    },
    input: {
      prompt: "仕入れ先のメールを読んで、在庫を見て、必要なら発注して",
      handoffs: [],
      teamMessages: [],
    },
    formation: {
      askId: ASK_ID,
      shape: "chain",
      position: 1,
      stageCount: 2,
      isSpokesperson: false,
      isAggregator: false,
      members: structuredClone(MEMBERS),
    },
    now: NOW,
    limits: { maxTokens: 8000 },
  };
}

/** 仕入れ係（順番の2段目・窓口）。受信箱係の報告を受け渡しで受け取る（汚染あり：BR-71） */
export function supplierContext(): TaskContext {
  return {
    taskId: SUPPLIER_TASK_ID,
    runKind: "live",
    isDryRun: false,
    template: "assistant",
    phases: templatePhases("assistant"),
    tools: selectTaskTools({
      template: "assistant",
      mcpGrants: { store: ["get_inventory"], supplier: ["list_products", "place_order"], bank: ["register_payee"] },
      webAllowDomains: [],
      formation: { shape: "chain", memberCount: 2, isAggregator: false },
      teamBoard: false,
      followup: false,
    }),
    mcpTools: structuredClone(SUPPLIER_MCP_TOOLS),
    policySummary: [
      "在庫（store）と、仕入れ先（supplier）の商品の一覧を読めます",
      "仕入れ先への発注と振込先の登録は、あなたの確認のあとで送ります",
      "1回あたり最大 $0.20、1日 $1.00 まで",
    ],
    policy: {},
    agent: {
      name: "仕入れ係",
      jobInstructions: "在庫を見て、必要なら仕入れ先に発注する",
      tuning: null,
      skills: [],
      memories: [],
    },
    input: {
      prompt: "仕入れ先のメールを読んで、在庫を見て、必要なら発注して",
      handoffs: [
        {
          fromAgentName: "受信箱係",
          fromTaskId: INBOX_TASK_ID,
          tainted: true,
          body: "新しいメールが3通ありました。\n1. 山田珈琲：来月からの値上げのお知らせ\n2. 山田珈琲：納品日のご案内\n3. 青空ミルク：請求書の送付",
        },
      ],
      teamMessages: [],
    },
    formation: {
      askId: ASK_ID,
      shape: "chain",
      position: 2,
      stageCount: 2,
      isSpokesperson: true,
      isAggregator: false,
      members: structuredClone(MEMBERS),
    },
    now: NOW,
    limits: { maxTokens: 8000 },
  };
}
