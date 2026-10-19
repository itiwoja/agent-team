// 計測のタスクの文脈（G-11：本番と同じ作り方。15:144）の試験
import { describe, expect, it } from "vitest";
import { DEFAULT_CEILINGS, compose, defaultWorkspacePolicy } from "@open-team/kernel";
import { buildSystemPrompt, buildTaskInput, selectTaskTools, templatePhases } from "@open-team/runner";
import { SHOP_DEMO_FORMATION, SHOP_TOOL_DESCRIPTIONS, SHOP_TOOL_INPUT_SCHEMAS, type DemoFormation } from "@open-team/sim-core";
import {
  MEASURE_MAX_TOKENS,
  PROMPT_HASH_NOW,
  buildMeasureTaskContext,
  measureFormation,
  measurePromptHash,
  mcpToolsOf,
  policySummaryLines,
} from "./context.ts";

const NOW = "2026-10-06T18:00:00+09:00";

describe("用意した編成（measureFormation）", () => {
  const f = measureFormation();

  it("受信箱係 → 仕入れ係の順番（position の順）、窓口は仕入れ係、依頼の本文は用意した依頼のまま（D-70）", () => {
    expect(f.shape).toBe("chain");
    expect(f.askText).toBe(SHOP_DEMO_FORMATION.ask.text);
    expect(f.members.map((m) => [m.position, m.name, m.template, m.isSpokesperson])).toEqual([
      [1, "受信箱係", "researcher", false],
      [2, "仕入れ係", "assistant", true],
    ]);
    expect(f.members.map((m) => m.instructions)).toEqual(SHOP_DEMO_FORMATION.members.map((m) => m.agent.jobs[0]?.instructions));
  });

  it("実効ポリシーは kernel の compose（オーナーのワークスペースのポリシー × 担当の定義）と同じ", () => {
    for (const [i, m] of f.members.entries()) {
      const demo = SHOP_DEMO_FORMATION.members[i];
      if (!demo) throw new Error("担当がない");
      const r = compose({ ceilings: DEFAULT_CEILINGS, workspacePolicy: defaultWorkspacePolicy("owner"), agent: demo.agent }, demo.agent.jobs[0]?.id ?? "");
      expect(m.effective).toEqual(r.effective);
      expect(m.policyHash).toBe(r.effectivePolicyHash);
    }
  });

  it("付与：受信箱係は mail.list_inbox だけ（書き込みなし）、仕入れ係は在庫・商品・発注・振込先の登録（M-36。mail.send なし）", () => {
    const [inbox, supplier] = f.members;
    expect(inbox?.mcpTools.map((t) => `${t.connector}.${t.tool}:${t.classification}`)).toEqual(["mail.list_inbox:read"]);
    expect(supplier?.mcpTools.map((t) => `${t.connector}.${t.tool}:${t.classification}`)).toEqual([
      "bank.register_payee:write",
      "store.get_inventory:read",
      "supplier.list_products:read",
      "supplier.place_order:write",
    ]);
    expect(inbox?.effective.mcp.llmWrite).toBe(false);
    expect(supplier?.effective.mcp.llmWrite).toBe(true);
  });

  it("MCP のツールの説明・入力スキーマは sim-world の固定の説明と Zod から作ったもの（tool_hash の材料と同じ）", () => {
    const supplier = f.members[1];
    const order = supplier?.mcpTools.find((t) => t.tool === "place_order");
    expect(order?.description).toBe(SHOP_TOOL_DESCRIPTIONS["supplier.place_order"]);
    expect(order?.inputSchema).toEqual(SHOP_TOOL_INPUT_SCHEMAS["supplier.place_order"]);
    // 写しなので、書き換えても元の表は変わらない
    expect(Object.isFrozen(order?.inputSchema)).toBe(false);
  });

  it("manifest にない付与は渡さない", () => {
    const supplier = f.members[1];
    if (!supplier) throw new Error("仕入れ係がいない");
    const effective = { ...supplier.effective, mcp: { ...supplier.effective.mcp, grants: { store: ["get_inventory", "delete_everything"], ghost: ["x"] } } };
    expect(mcpToolsOf(effective).map((t) => `${t.connector}.${t.tool}`)).toEqual(["store.get_inventory"]);
  });

  it("定義がポリシーを超えていたら（反映できない形なら）計測しない", () => {
    const greedy = structuredClone(SHOP_DEMO_FORMATION) as DemoFormation;
    const member = greedy.members[1];
    if (!member) throw new Error("仕入れ係がいない");
    member.agent.budget.per_task_usd = 100;
    expect(() => measureFormation({ formation: greedy })).toThrow(/ポリシーを超えている/);
  });
});

describe("タスクの文脈（buildMeasureTaskContext）", () => {
  const f = measureFormation();
  const [inbox, supplier] = f.members;
  if (!inbox || !supplier) throw new Error("担当がいない");

  it("ツール・フェーズは runner の selectTaskTools・templatePhases と同じ（Web の付与なし → web_* は外れる）", () => {
    const ctx = buildMeasureTaskContext({ formation: f, member: supplier, taskId: "t", askId: "a", now: NOW, handoffs: [] });
    expect(ctx.phases).toEqual(templatePhases("assistant"));
    expect(ctx.tools).toEqual(
      selectTaskTools({
        template: "assistant",
        mcpGrants: supplier.effective.mcp.grants,
        webAllowDomains: [],
        guestWorkspace: false,
        formation: { shape: "chain", memberCount: 2, isAggregator: false },
        teamBoard: false,
        followup: false,
      }),
    );
    expect(ctx.tools.map((t) => t.name)).toEqual(["mcp_call", "notify", "submit_report", "finish"]);
    expect(ctx.limits.maxTokens).toBe(MEASURE_MAX_TOKENS);
  });

  it("編成の位置・窓口・依頼の本文・仕事の指示・仮想の今の時刻を入れる。連絡板・調整メモは入れない", () => {
    const handoffs = [{ fromAgentName: "受信箱係", fromTaskId: "t1", tainted: true, body: "報告" }];
    const ctx = buildMeasureTaskContext({ formation: f, member: supplier, taskId: "t2", askId: "a", now: NOW, handoffs });
    expect(ctx.formation).toEqual({
      askId: "a",
      shape: "chain",
      position: 2,
      stageCount: 2,
      isSpokesperson: true,
      isAggregator: false,
      members: [
        { name: "受信箱係", position: 1, isAggregator: false },
        { name: "仕入れ係", position: 2, isAggregator: false },
      ],
    });
    expect(ctx.input).toEqual({ prompt: f.askText, handoffs, teamMessages: [] });
    expect(ctx.agent).toEqual({ name: "仕入れ係", jobInstructions: supplier.instructions, tuning: null, skills: [], memories: [] });
    expect(ctx.now).toBe(NOW);
    expect(buildSystemPrompt(ctx, 0)).toContain(`現在の日時：${NOW}`);
    // 受け渡しは信用しない内容として囲み、汚染の印を付ける（BR-71）
    expect(buildTaskInput(ctx)).toContain('受信箱係の報告（外部の内容をもとにしています）：\n<untrusted source="agent:受信箱係">');
  });

  it("文脈は写し（受け渡しを後で書き換えても文脈は変わらない）", () => {
    const handoffs = [{ fromAgentName: "受信箱係", fromTaskId: "t1", tainted: false, body: "報告" }];
    const ctx = buildMeasureTaskContext({ formation: f, member: supplier, taskId: "t", askId: "a", now: NOW, handoffs });
    handoffs[0]!.body = "書き換えた";
    expect(ctx.input.handoffs[0]?.body).toBe("報告");
  });

  it("実効ポリシーの要約（固定の文）：受信箱係は読み取りだけ・書き込めない、仕入れ係は書き込みが確認のあと、予算は 1回 $0.20・1日 $1.00", () => {
    expect(policySummaryLines(inbox.effective)).toEqual([
      "受信箱の確認ができます（読み取り）",
      "外部のサービスには書き込めません",
      "1回あたり最大 $0.20、1日 $1.00 まで",
    ]);
    expect(policySummaryLines(supplier.effective)).toEqual([
      "在庫の確認・商品の確認ができます（読み取り）",
      "振込先の登録・発注は、利用者の確認のあとで実行されます",
      "1回あたり最大 $0.20、1日 $1.00 まで",
    ]);
  });

  it("要約はルールがあればそれも言う（自律度とルールから決まる。LLM を使わない）", () => {
    const withRule = {
      ...supplier.effective,
      rules: { enabled: true, items: [{ id: "r1", action: "mcp.supplier.place_order", match: { supplier_id: "supplier-01" }, free: [], tool_hash: `sha256:${"0".repeat(64)}` as const }] },
    };
    expect(policySummaryLines(withRule)[1]).toBe("振込先の登録・発注は、ルールに一致すれば確認なしで、ほかは利用者の確認のあとで実行されます");
  });
});

describe("プロンプトのハッシュ（結果の条件）", () => {
  it("同じ編成なら同じ。基準の時刻は 1日目 18:00", () => {
    expect(PROMPT_HASH_NOW).toBe("2026-10-06T18:00:00+09:00");
    expect(measurePromptHash(measureFormation())).toBe(measurePromptHash(measureFormation()));
    expect(measurePromptHash(measureFormation())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("仕事の指示が変われば変わる（プロンプトが本番と違えば分かる）", () => {
    const changed = structuredClone(SHOP_DEMO_FORMATION) as DemoFormation;
    const job = changed.members[1]?.agent.jobs[0];
    if (!job) throw new Error("仕事がない");
    job.instructions = `${job.instructions}（注意して）`;
    expect(measurePromptHash(measureFormation({ formation: changed }))).not.toBe(measurePromptHash(measureFormation()));
  });
});
