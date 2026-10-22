// selectTaskTools（formation-runtime.md §2.5 の手順1〜8）とツールの宣言・テンプレートの試験
import { describe, expect, it } from "vitest";
import {
  AGGREGATOR_TOOLS,
  FOLLOWUP_TOOLS,
  TEAM_TOOLS,
  TOOL_ORDER,
  TOOL_SPECS,
  selectTaskToolNames,
  selectTaskTools,
  type TaskToolSelection,
} from "./tools.ts";
import { TEMPLATE_RUNTIME_0H, templatePhases } from "./templates.ts";
import type { Shape, TemplateId, TeamMessageKind } from "./types.ts";

const base: TaskToolSelection = {
  template: "researcher",
  mcpGrants: { mail: ["list_inbox"] },
  webAllowDomains: [],
  formation: { shape: "chain", memberCount: 2, isAggregator: false },
  teamBoard: false,
  followup: false,
};

const sel = (over: Partial<TaskToolSelection>): TaskToolSelection => ({ ...base, ...over });

describe("selectTaskTools（§2.5）", () => {
  it("PR-04 受信箱係（Web の付与なし）は mcp_call・notify・submit_report・finish", () => {
    expect(selectTaskToolNames(base)).toEqual(["mcp_call", "notify", "submit_report", "finish"]);
  });

  it("PR-05 仕入れ係も同じ並び（mcp_call は読み書き）で、remember を含まない", () => {
    const names = selectTaskToolNames(
      sel({
        template: "assistant",
        mcpGrants: { store: ["get_inventory"], supplier: ["list_products", "place_order"], bank: ["register_payee"] },
      }),
    );
    expect(names).toEqual(["mcp_call", "notify", "submit_report", "finish"]);
    expect(names).not.toContain("remember");
  });

  it("PR-06・TB-11 ひとりの編成には team_post・team_wait を足さない（連絡板があっても）", () => {
    const names = selectTaskToolNames(
      sel({ formation: { shape: "single", memberCount: 1, isAggregator: false }, teamBoard: true }),
    );
    expect(names).not.toContain("team_post");
    expect(names).not.toContain("team_wait");
  });

  it("§2.5-5 2体以上の編成で連絡板があれば team_post・team_wait を足す（ag:299）", () => {
    for (const shape of ["chain", "parallel", "aggregate"] as const) {
      const names = selectTaskToolNames(sel({ formation: { shape, memberCount: 2, isAggregator: false }, teamBoard: true }));
      expect(names).toEqual(["mcp_call", "notify", "submit_report", "finish", "team_post", "team_wait"]);
    }
  });

  it("§2.5-5 連絡板がない間（Should を作るまで）は足さない", () => {
    expect(selectTaskToolNames(sel({ teamBoard: false }))).not.toContain("team_post");
  });

  it("§2.5-5 編成でないタスク（formation = null）には足さない", () => {
    expect(selectTaskToolNames(sel({ formation: null, teamBoard: true }))).not.toContain("team_post");
  });

  it("PR-07 追いのターンは team_post・finish だけ（読み取り・書き込み・報告をしない）", () => {
    // 並びはほかと同じ TOOL_ORDER（finish → team_post）
    expect(selectTaskToolNames(sel({ followup: true, teamBoard: true }))).toEqual(["finish", "team_post"]);
    expect(selectTaskToolNames(sel({ template: "assistant", followup: true, teamBoard: true }))).toEqual(["finish", "team_post"]);
  });

  it("§2.5-3・C-46 mcp_call は付与されたツールが1つもなければ外す（空の配列だけのコネクタも同じ）", () => {
    expect(selectTaskToolNames(sel({ mcpGrants: {} }))).toEqual(["notify", "submit_report", "finish"]);
    expect(selectTaskToolNames(sel({ mcpGrants: { mail: [] } }))).toEqual(["notify", "submit_report", "finish"]);
  });

  it("§2.5-3・C-47 Web の付与があれば web_search・web_fetch が入る／なければ外す", () => {
    const owner = sel({ webAllowDomains: ["*"] });
    expect(selectTaskToolNames(owner)).toEqual(["mcp_call", "web_search", "web_fetch", "notify", "submit_report", "finish"]);
    expect(selectTaskToolNames(sel({ webAllowDomains: [] }))).toEqual([
      "mcp_call",
      "notify",
      "submit_report",
      "finish",
    ]);
  });

  it("BR-72 まとめ役は submit_report・notify・finish だけ（付与・Web があっても）", () => {
    const names = selectTaskToolNames(
      sel({
        template: "briefer",
        webAllowDomains: ["*"],
        formation: { shape: "aggregate", memberCount: 3, isAggregator: true },
      }),
    );
    expect(names).toEqual(["notify", "submit_report", "finish"]);
  });

  it("BR-72 まとめ役でも連絡板があれば team_post・team_wait は足す", () => {
    const names = selectTaskToolNames(
      sel({ template: "briefer", formation: { shape: "aggregate", memberCount: 3, isAggregator: true }, teamBoard: true }),
    );
    expect(names).toEqual(["notify", "submit_report", "finish", "team_post", "team_wait"]);
  });

  it("§2.5-2 finish は常に入る・§2.5-4 remember・load_skill は入らない（C-48）", () => {
    for (const template of ["researcher", "briefer", "watcher", "assistant"] as const) {
      const names = selectTaskToolNames(sel({ template, mcpGrants: {}, webAllowDomains: [] }));
      expect(names).toContain("finish");
      expect(names).not.toContain("remember");
      expect(names).not.toContain("load_skill");
    }
  });

  it("BR-40 watcher（見張り）は書き込みを提案できない（mcp_call は読み取りだけ）。10/14 から編成で使う", () => {
    expect(TEMPLATE_RUNTIME_0H.watcher.mcpByLlm).toBe("read");
    expect(TEMPLATE_RUNTIME_0H.watcher.in0H).toBe(true);
  });

  it("作業場の道具は sandbox のときだけ、load_skill はスキルのある担当だけ（D-116）", () => {
    const base: TaskToolSelection = { template: "dev-coder", mcpGrants: {}, webAllowDomains: [], formation: null, teamBoard: false, followup: false };
    expect(selectTaskToolNames(base)).toEqual(["notify", "submit_report", "finish"]);
    expect(selectTaskToolNames({ ...base, sandbox: true })).toEqual(["notify", "submit_report", "finish", "list_files", "read_file", "search", "write_file", "delete_file", "run_command"]);
    expect(selectTaskToolNames({ ...base, template: "reviewer", sandbox: true })).not.toContain("write_file");
    expect(selectTaskToolNames({ ...base, template: "researcher", sandbox: true })).not.toContain("run_command");
    expect(selectTaskToolNames({ ...base, template: "researcher", skills: true })).toContain("load_skill");
    expect(selectTaskToolNames({ ...base, template: "researcher" })).not.toContain("load_skill");
  });

  it("ask_user は本番の依頼の担当にだけ渡す（まとめ役・追いのターンには渡さない）", () => {
    const base: TaskToolSelection = { template: "researcher", mcpGrants: {}, webAllowDomains: ["*"], formation: null, teamBoard: false, followup: false };
    expect(selectTaskToolNames(base)).not.toContain("ask_user");
    expect(selectTaskToolNames({ ...base, askUser: true })).toContain("ask_user");
    expect(selectTaskToolNames({ ...base, askUser: true, formation: { shape: "aggregate", memberCount: 3, isAggregator: true } })).not.toContain("ask_user");
    expect(selectTaskToolNames({ ...base, askUser: true, followup: true })).not.toContain("ask_user");
  });

  it("BR-23・§2.5 すべての組み合わせで：テンプレート ∩ 付与（＋finish・連絡板）を超えない・並びが固定・重複なし", () => {
    const templates: TemplateId[] = ["researcher", "briefer", "watcher", "assistant"];
    const grantsList: Array<Record<string, string[]>> = [{}, { mail: [] }, { mail: ["list_inbox"] }];
    const webList = [[], ["*"]];
    const formations: TaskToolSelection["formation"][] = [null];
    for (const shape of ["single", "chain", "parallel", "aggregate"] as Shape[]) {
      for (const memberCount of [1, 2, 5]) {
        for (const isAggregator of [false, true]) formations.push({ shape, memberCount, isAggregator });
      }
    }
    let n = 0;
    for (const template of templates)
      for (const mcpGrants of grantsList)
        for (const webAllowDomains of webList)
          for (const formation of formations)
            for (const teamBoard of [false, true])
              for (const followup of [false, true]) {
                const s: TaskToolSelection = { template, mcpGrants, webAllowDomains, formation, teamBoard, followup };
                const names = selectTaskToolNames(s);
                n += 1;
                expect(names).toContain("finish");
                expect(new Set(names).size).toBe(names.length);
                expect(names).toEqual(TOOL_ORDER.filter((t) => names.includes(t)));
                expect(names).not.toContain("remember");
                expect(names).not.toContain("load_skill");
                if (followup) {
                  expect(names).toEqual(TOOL_ORDER.filter((t) => FOLLOWUP_TOOLS.includes(t)));
                  continue;
                }
                const allowed = new Set<string>([...TEMPLATE_RUNTIME_0H[template].tools, "finish", ...TEAM_TOOLS]);
                for (const t of names) expect(allowed.has(t)).toBe(true);
                const granted = Object.values(mcpGrants).flat().length > 0;
                if (!granted) expect(names).not.toContain("mcp_call");
                if (webAllowDomains.length === 0) {
                  expect(names).not.toContain("web_search");
                  expect(names).not.toContain("web_fetch");
                }
                if (formation?.isAggregator) {
                  for (const t of names) expect([...AGGREGATOR_TOOLS, ...TEAM_TOOLS]).toContain(t);
                }
                const team = names.includes("team_post");
                expect(team).toBe(teamBoard && formation !== null && formation.shape !== "single" && formation.memberCount >= 2);
                expect(names.includes("team_wait")).toBe(team);
              }
    expect(n).toBeGreaterThan(1000);
  });

  it("BD-05 宣言はタスクごとに別のオブジェクト（片方を書き換えても、もう片方と TOOL_SPECS は変わらない）", () => {
    const a = selectTaskTools(base);
    const b = selectTaskTools(base);
    const first = a[0];
    expect(first?.name).toBe("mcp_call");
    (first!.inputSchema as { type: string }).type = "changed";
    expect((b[0]!.inputSchema as { type: string }).type).toBe("object");
    expect((TOOL_SPECS.mcp_call.inputSchema as { type: string }).type).toBe("object");
  });

  it("BD-05 TOOL_SPECS・TEMPLATE_RUNTIME_0H は奥まで凍っていて、書き換えると例外になる（タスクの間で値を混ぜない）", () => {
    expect(Object.isFrozen(TOOL_SPECS)).toBe(true);
    expect(Object.isFrozen((TOOL_SPECS.submit_report.inputSchema as { properties: object }).properties)).toBe(true);
    expect(() => {
      (TOOL_SPECS.mcp_call as { description: string }).description = "書き換え";
    }).toThrow(TypeError);
    expect(Object.isFrozen(TEMPLATE_RUNTIME_0H.assistant.phases)).toBe(true);
    expect(() => {
      (TEMPLATE_RUNTIME_0H.assistant.phases[0] as { systemPrompt: string }).systemPrompt = "書き換え";
    }).toThrow(TypeError);
    // 写しは書き換えられる（edge・llm が自分の形に直してよい）
    const copy = selectTaskTools(base)[0]!;
    copy.description = "写し";
    expect(copy.description).toBe("写し");
  });

  it("selectTaskTools は selectTaskToolNames と同じ並びの宣言を返す", () => {
    expect(selectTaskTools(base).map((t) => t.name)).toEqual(selectTaskToolNames(base));
  });
});

describe("ツールの宣言（catalogs.md:79-86）", () => {
  type Schema = {
    type: string;
    properties: Record<string, { type?: string; enum?: string[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; items?: Schema }>;
    required: string[];
    additionalProperties: boolean;
  };
  const schema = (name: keyof typeof TOOL_SPECS) => TOOL_SPECS[name].inputSchema as Schema;

  it("名前と宣言の名前が一致し、どれも object の JSON Schema（余計なキーなし）", () => {
    for (const [name, spec] of Object.entries(TOOL_SPECS)) {
      expect(spec.name).toBe(name);
      expect(spec.description.length).toBeGreaterThan(0);
      const s = spec.inputSchema as Schema;
      expect(s.type).toBe("object");
      expect(s.additionalProperties).toBe(false);
      for (const r of s.required) expect(Object.keys(s.properties)).toContain(r);
    }
  });

  it("mcp_call：connector・tool・arguments が必須（ToolArgs['mcp_call']）", () => {
    expect(schema("mcp_call").required).toEqual(["connector", "tool", "arguments"]);
  });

  it("submit_report：title 1〜256・body 50,000 まで・sources 必須・kind は answer だけ（ab:194、BR-45、ag:267）", () => {
    const s = schema("submit_report");
    expect(s.required).toEqual(["title", "body", "sources"]);
    expect(s.properties.title).toMatchObject({ minLength: 1, maxLength: 256 });
    expect(s.properties.body).toMatchObject({ maxLength: 50_000 });
    expect(s.properties.kind?.enum).toEqual(["answer"]);
    expect(s.properties.sources?.items?.properties.kind?.enum).toEqual(["url", "mcp", "agent"]);
  });

  it("finish：outcome は no_change / unable（cat:79）", () => {
    expect(schema("finish").properties.outcome?.enum).toEqual(["no_change", "unable"]);
    expect(schema("finish").required).toEqual(["outcome", "reason"]);
  });

  it("notify：title 60・body 500 まで、priority は normal / high（§8-27）", () => {
    const s = schema("notify");
    expect(s.properties.title?.maxLength).toBe(60);
    expect(s.properties.body?.maxLength).toBe(500);
    expect(s.properties.priority?.enum).toEqual(["normal", "high"]);
  });

  it("web_search：max_results は 1〜10（cat:83）", () => {
    expect(schema("web_search").properties.max_results).toMatchObject({ type: "integer", minimum: 1, maximum: 10 });
  });

  it("team_post：kind は TeamMessageKind と同じ、本文は 2,000 文字まで（BR-77）", () => {
    const kinds: TeamMessageKind[] = ["share", "question", "reply", "revise_request"];
    expect(schema("team_post").properties.kind?.enum).toEqual(kinds);
    expect(schema("team_post").properties.body?.maxLength).toBe(2_000);
  });

  it("team_wait：timeout は 300 秒まで（A-104）", () => {
    expect(schema("team_wait").properties.timeout).toMatchObject({ minimum: 1, maximum: 300 });
  });

  it("TOOL_ORDER は宣言のあるツールを1回ずつ含む", () => {
    expect([...TOOL_ORDER].sort()).toEqual(Object.keys(TOOL_SPECS).sort());
  });
});

describe("TEMPLATE_RUNTIME_0H（FR-029、pol:324-327）", () => {
  it("§8-7 フェーズと llmPhase の対応", () => {
    const map = (t: TemplateId) => TEMPLATE_RUNTIME_0H[t].phases.map((p) => `${p.name}:${p.llmPhase}`);
    expect(map("researcher")).toEqual(["調査:investigate", "整理:plan", "要約:report"]);
    expect(map("briefer")).toEqual(["収集:investigate", "要約:report"]);
    expect(map("assistant")).toEqual(["計画:plan", "実行:implement"]);
    expect(map("watcher")).toEqual(["取得:investigate", "比較:plan", "要約:report"]);
  });

  it("ツールの上限は kernel-compose-classify.md の TEMPLATES と同じ（D-32 の submit_report を含む）", () => {
    expect(TEMPLATE_RUNTIME_0H.researcher.tools).toEqual(["web_search", "web_fetch", "mcp_call", "submit_report", "notify", "finish"]);
    expect(TEMPLATE_RUNTIME_0H.briefer.tools).toEqual(["web_search", "web_fetch", "mcp_call", "submit_report", "notify", "finish"]);
    expect(TEMPLATE_RUNTIME_0H.watcher.tools).toEqual(["web_search", "web_fetch", "mcp_call", "notify", "submit_report", "finish"]);
    expect(TEMPLATE_RUNTIME_0H.assistant.tools).toEqual(["mcp_call", "web_search", "web_fetch", "notify", "submit_report", "finish"]);
  });

  it("§8-1 書き込みを LLM が提案できるのは assistant だけ・編成で使うのは researcher・briefer・assistant・watcher・dev-coder・reviewer", () => {
    const writers = Object.values(TEMPLATE_RUNTIME_0H).filter((t) => t.mcpByLlm === "read_write").map((t) => t.id);
    expect(writers).toEqual(["assistant"]);
    const in0H = Object.values(TEMPLATE_RUNTIME_0H).filter((t) => t.in0H).map((t) => t.id).sort();
    expect(in0H).toEqual(["assistant", "briefer", "dev-coder", "researcher", "reviewer", "watcher"]);
  });

  it("templatePhases はタスクごとに別の配列を返す", () => {
    const a = templatePhases("researcher");
    a[0]!.systemPrompt = "changed";
    expect(templatePhases("researcher")[0]!.systemPrompt).not.toBe("changed");
    expect(TEMPLATE_RUNTIME_0H.researcher.phases[0]!.systemPrompt).not.toBe("changed");
  });

  it("D-54・R-43 テンプレートの文に、障害を狙い撃ちした語を入れない", () => {
    // F-01 再発注・F-02 仕込まれた指示・F-03 振込先・F-04 単位・F-05 価格の急変 などに向けた文を本番のプロンプトに足さない
    const targeted = ["振込先", "詐欺", "なりすまし", "値上", "急変", "単位", "二重", "再発注", "タイムアウト", "不審", "怪しい"];
    for (const t of Object.values(TEMPLATE_RUNTIME_0H)) {
      for (const p of t.phases) for (const w of targeted) expect(p.systemPrompt).not.toContain(w);
    }
  });
});
