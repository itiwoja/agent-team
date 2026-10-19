import type { McpToolSpec, ToolSpec } from "@open-team/runner";
import { describe, expect, it } from "vitest";
import {
  buildToolDeclarations,
  EMPTY_MCP_FUNCTION_TABLE,
  fromGeminiFunctionCall,
  MCP_FUNCTION_PREFIX,
  mcpFunctionName,
  toGeminiFunctionCall,
} from "./tools.ts";

const placeOrderSchema = {
  type: "object",
  properties: {
    supplier_id: { type: "string" },
    items: { type: "array", items: { type: "object", properties: { sku: { type: "string" }, quantity: { type: "integer" } } } },
  },
  required: ["supplier_id", "items"],
  additionalProperties: false,
};
const listInboxSchema = { type: "object", properties: { limit: { type: "integer" } } };

const catalog: ToolSpec[] = [
  { name: "mcp_call", description: "MCP のツールを呼ぶ", inputSchema: { type: "object" } },
  { name: "submit_report", description: "報告を出す", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
  { name: "finish", description: "終える", inputSchema: { type: "object", properties: { outcome: { type: "string" } } } },
];
const mcp: McpToolSpec[] = [
  { connector: "supplier", tool: "place_order", classification: "write", description: "仕入れ先に発注する", inputSchema: placeOrderSchema },
  { connector: "mail", tool: "list_inbox", classification: "read", description: "受信箱を読む", inputSchema: listInboxSchema },
];

/** 引数を変えずに名前が安全か（Gemini の関数名の規則より狭い側） */
const SAFE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

describe("buildToolDeclarations（mcp_call の展開）", () => {
  it("付与された MCP のツールを1つずつ mcp__<connector>__<tool> にし、入力スキーマはそのまま parametersJsonSchema に入れる", () => {
    const { declarations, table } = buildToolDeclarations(catalog, mcp);
    expect(declarations.map((d) => d.name)).toEqual(["submit_report", "finish", "mcp__supplier__place_order", "mcp__mail__list_inbox"]);
    const placeOrder = declarations.find((d) => d.name === "mcp__supplier__place_order");
    expect(placeOrder?.description).toBe("仕入れ先に発注する");
    expect(placeOrder?.parametersJsonSchema).toBe(placeOrderSchema); // 同じもの（手を加えない）
    expect(placeOrder?.parameters).toBeUndefined();
    expect(declarations.find((d) => d.name === "submit_report")?.parametersJsonSchema).toBe(catalog[1]?.inputSchema);
    expect(table.byName.get("mcp__mail__list_inbox")).toEqual({ connector: "mail", tool: "list_inbox" });
  });

  it("mcp_call 自体は宣言しない", () => {
    const { declarations } = buildToolDeclarations(catalog, mcp);
    expect(declarations.some((d) => d.name === "mcp_call")).toBe(false);
  });

  it("tools に mcp_call がなければ mcpTools は無視する（llm/types.ts）", () => {
    const { declarations, table } = buildToolDeclarations(
      catalog.filter((t) => t.name !== "mcp_call"),
      mcp,
    );
    expect(declarations.map((d) => d.name)).toEqual(["submit_report", "finish"]);
    expect(table.byName.size).toBe(0);
  });

  it("付与が1つもなければ MCP の関数はない", () => {
    const { declarations } = buildToolDeclarations(catalog, []);
    expect(declarations.map((d) => d.name)).toEqual(["submit_report", "finish"]);
  });

  it("同じ名前のツール・同じ MCP のツールは1つにする（重なる宣言は Gemini が 400 を返す）", () => {
    const { declarations } = buildToolDeclarations([...catalog, ...catalog], [...mcp, ...mcp]);
    expect(declarations.map((d) => d.name)).toEqual(["submit_report", "finish", "mcp__supplier__place_order", "mcp__mail__list_inbox"]);
  });

  it("入力スキーマがないツールは parametersJsonSchema を省く", () => {
    const { declarations } = buildToolDeclarations(
      [{ name: "finish", description: "終える", inputSchema: undefined }],
      [],
    );
    expect(declarations).toEqual([{ name: "finish", description: "終える" }]);
  });

  it("使えない文字・長すぎる名前は置き換えてハッシュを付け、64文字以内で英字か _ で始まる（戻しは表で正確に）", () => {
    const odd: McpToolSpec[] = [
      { connector: "my.server", tool: "do it/now", classification: "read", description: "", inputSchema: {} },
      { connector: "c".repeat(80), tool: "t".repeat(80), classification: "read", description: "", inputSchema: {} },
      { connector: "店", tool: "注文", classification: "write", description: "", inputSchema: {} },
    ];
    const { declarations, table } = buildToolDeclarations(catalog, odd);
    const names = declarations.map((d) => d.name ?? "").filter((n) => n.startsWith(MCP_FUNCTION_PREFIX));
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
    for (const n of names) expect(n).toMatch(SAFE);
    for (const t of odd) {
      const name = mcpFunctionName(t.connector, t.tool);
      expect(table.byName.get(name)).toEqual({ connector: t.connector, tool: t.tool });
    }
  });

  it("名前が重なる2つのツール（a__b・c と a・b__c）は別の名前にし、それぞれ正しく戻す", () => {
    const pair: McpToolSpec[] = [
      { connector: "a__b", tool: "c", classification: "read", description: "1", inputSchema: {} },
      { connector: "a", tool: "b__c", classification: "write", description: "2", inputSchema: {} },
    ];
    const { declarations, table } = buildToolDeclarations(catalog, pair);
    const names = declarations.map((d) => d.name ?? "").filter((n) => n.startsWith(MCP_FUNCTION_PREFIX));
    expect(names[0]).toBe("mcp__a__b__c");
    expect(names[1]).not.toBe("mcp__a__b__c");
    expect(names[1]).toMatch(SAFE);
    expect(fromGeminiFunctionCall(names[0] ?? "", { x: 1 }, table)).toEqual({
      name: "mcp_call",
      arguments: { connector: "a__b", tool: "c", arguments: { x: 1 } },
    });
    expect(fromGeminiFunctionCall(names[1] ?? "", { y: 2 }, table)).toEqual({
      name: "mcp_call",
      arguments: { connector: "a", tool: "b__c", arguments: { y: 2 } },
    });
    // 履歴の展開も同じ表で同じ名前に戻る
    expect(toGeminiFunctionCall({ name: "mcp_call", arguments: { connector: "a", tool: "b__c", arguments: {} } }, table).name).toBe(names[1]);
  });

  it("MCP の名前がカタログのツール名と重なっても別の名前にする", () => {
    const { declarations, table } = buildToolDeclarations(
      [...catalog, { name: "mcp__x__y" as never, description: "カタログ外の名前", inputSchema: {} }],
      [{ connector: "x", tool: "y", classification: "read", description: "", inputSchema: {} }],
    );
    const names = declarations.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    const expanded = table.byTool.values().next().value;
    expect(expanded).not.toBe("mcp__x__y");
  });

  it("mcpFunctionName は決定論（同じ入力なら同じ名前）", () => {
    expect(mcpFunctionName("my.server", "do it")).toBe(mcpFunctionName("my.server", "do it"));
    expect(mcpFunctionName("supplier", "place_order")).toBe("mcp__supplier__place_order");
  });
});

describe("応答の関数呼び出しを戻す（fromGeminiFunctionCall）", () => {
  const { table } = buildToolDeclarations(catalog, mcp);

  it("mcp__supplier__place_order を mcp_call（{ connector, tool, arguments }）に戻す", () => {
    const args = { supplier_id: "supplier-01", items: [{ sku: "BEAN-HOUSE", quantity: 20 }] };
    expect(fromGeminiFunctionCall("mcp__supplier__place_order", args, table)).toEqual({
      name: "mcp_call",
      arguments: { connector: "supplier", tool: "place_order", arguments: args },
    });
  });

  it("カタログのツールはそのまま", () => {
    expect(fromGeminiFunctionCall("submit_report", { title: "t" }, table)).toEqual({ name: "submit_report", arguments: { title: "t" } });
  });

  it("BR-09：知らない名前はそのまま返す（付与のない MCP・カタログにないツール・mcp_call を直に呼んだもの）", () => {
    expect(fromGeminiFunctionCall("mcp__bank__register_payee", { account: "x" }, table)).toEqual({
      name: "mcp__bank__register_payee",
      arguments: { account: "x" },
    });
    expect(fromGeminiFunctionCall("remember", { content: "x" }, table)).toEqual({ name: "remember", arguments: { content: "x" } });
    const direct = { connector: "supplier", tool: "place_order", arguments: {} };
    expect(fromGeminiFunctionCall("mcp_call", direct, table)).toEqual({ name: "mcp_call", arguments: direct });
    expect(fromGeminiFunctionCall("", {}, table)).toEqual({ name: "", arguments: {} });
  });

  it("空の表では mcp__ の名前もそのまま", () => {
    expect(fromGeminiFunctionCall("mcp__supplier__place_order", {}, EMPTY_MCP_FUNCTION_TABLE).name).toBe("mcp__supplier__place_order");
  });
});

describe("履歴の呼び出しを展開する（toGeminiFunctionCall）", () => {
  const { table } = buildToolDeclarations(catalog, mcp);

  it("mcp_call を展開した名前と中の arguments に戻す", () => {
    expect(
      toGeminiFunctionCall({ name: "mcp_call", arguments: { connector: "mail", tool: "list_inbox", arguments: { limit: 5 } } }, table),
    ).toEqual({ name: "mcp__mail__list_inbox", args: { limit: 5 } });
  });

  it("今回の表にない MCP のツール（付与が外れたなど）も同じ名前の規則で展開する", () => {
    expect(
      toGeminiFunctionCall({ name: "mcp_call", arguments: { connector: "bank", tool: "register_payee", arguments: { account: "a" } } }, table),
    ).toEqual({ name: "mcp__bank__register_payee", args: { account: "a" } });
  });

  it("mcp_call の形でない引数は名前を変えず、JSON のオブジェクトでない引数は {}", () => {
    expect(toGeminiFunctionCall({ name: "mcp_call", arguments: { connector: 1, tool: "x" } }, table)).toEqual({
      name: "mcp_call",
      args: { connector: 1, tool: "x" },
    });
    expect(toGeminiFunctionCall({ name: "mcp_call", arguments: { connector: "mail", tool: "list_inbox", arguments: "x" } }, table)).toEqual({
      name: "mcp__mail__list_inbox",
      args: {},
    });
    expect(toGeminiFunctionCall({ name: "finish", arguments: null }, table)).toEqual({ name: "finish", args: {} });
    expect(toGeminiFunctionCall({ name: "finish", arguments: [1, 2] }, table)).toEqual({ name: "finish", args: {} });
    expect(toGeminiFunctionCall({ name: "finish", arguments: { outcome: "unable" } }, table)).toEqual({
      name: "finish",
      args: { outcome: "unable" },
    });
  });
});

describe("展開と戻しの往復（性質）", () => {
  const pieces = ["supplier", "place_order", "a__b", "x.y", "do it", "店", "ü", "-dash", "_u", "UPPER", "a".repeat(70), "", "1st", "a:b"];

  it("どの connector・tool の組でも、宣言の名前から元の組に戻り、履歴の展開は同じ名前になる", () => {
    const tools: McpToolSpec[] = [];
    for (const connector of pieces) {
      for (const tool of pieces) tools.push({ connector, tool, classification: "read", description: "", inputSchema: {} });
    }
    const { declarations, table } = buildToolDeclarations(catalog, tools);
    const names = declarations.map((d) => d.name ?? "");
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      const name = table.byTool.get(`${t.connector}\u0000${t.tool}`);
      expect(name).toBeDefined();
      expect(name).toMatch(SAFE);
      const back = fromGeminiFunctionCall(name ?? "", { k: 1 }, table);
      expect(back).toEqual({ name: "mcp_call", arguments: { connector: t.connector, tool: t.tool, arguments: { k: 1 } } });
      expect(toGeminiFunctionCall(back, table)).toEqual({ name, args: { k: 1 } });
    }
  });
});
