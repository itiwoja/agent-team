// 計測のタスクの文脈（G-11：本番と同じ作り方。15:144「プロンプトは本番と同じものを使う」）
// 担当の定義は sim-core の SHOP_DEMO_FORMATION（用意した依頼 D-70）、実効ポリシーは kernel の compose、ツールは runner の selectTaskTools と
// sim-core の manifest、フェーズは runner の templatePhases。システムプロンプトとタスクの入力は runner の runTask が組み立てる（ここでは作らない）

import {
  DEFAULT_CEILINGS,
  compose,
  defaultWorkspacePolicy,
  hashCanonical,
  type EffectivePolicy,
  type Hex64,
  type IsoDateTime,
} from "@open-team/kernel";
import {
  buildSystemPrompt,
  buildTaskInput,
  selectTaskTools,
  templatePhases,
  type McpToolSpec,
  type TaskContext,
  type TemplateId,
} from "@open-team/runner";
import {
  SHOP_CONNECTORS,
  SHOP_DEFAULT_START_DATE,
  SHOP_DEMO_FORMATION,
  SHOP_TOOL_DESCRIPTIONS,
  SHOP_TOOL_INPUT_SCHEMAS,
  findToolManifest,
  formatJst,
  isShopToolName,
  jstAt,
  type DemoFormation,
} from "@open-team/sim-core";

/** LLM の1回の出力の上限（TaskContext.limits.maxTokens。既定値は未定義で formation-runtime.md §8-7 の案 8,000） */
export const MEASURE_MAX_TOKENS = 8_000;

/** 編成の担当1人ぶん（実効ポリシーは compose の結果） */
export interface MeasureMember {
  position: number;
  name: string;
  isSpokesperson: boolean;
  template: TemplateId;
  jobId: string;
  instructions: string;
  effective: EffectivePolicy;
  policyHash: Hex64;
  /** 付与された MCP のツール（manifest の分類・固定の説明・入力スキーマ） */
  mcpTools: McpToolSpec[];
}

export interface MeasureFormation {
  /** 依頼の本文（担当のタスクの prompt：formation-runtime.md §8-12） */
  askText: string;
  shape: "chain";
  /** position の順（受信箱係 → 仕入れ係） */
  members: MeasureMember[];
  /** 計測はオーナーの手元で走らせる（G-11：ローカル）。ゲストとの差は日次の予算と web_search だけ */
  workspaceKind: "owner" | "guest";
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 付与（effective.mcp.grants）× manifest。説明は固定の文（コネクタの登録時に確定したもの：tool_hash の材料）。並びは '<コネクタ>.<ツール>' の昇順 */
export function mcpToolsOf(effective: EffectivePolicy): McpToolSpec[] {
  const out: McpToolSpec[] = [];
  for (const [connector, tools] of Object.entries(effective.mcp.grants)) {
    for (const tool of tools) {
      const name = `${connector}.${tool}`;
      const found = findToolManifest(SHOP_CONNECTORS, name);
      // manifest にないツールは sim-world にないので渡さない
      if (found === null || !isShopToolName(name)) continue;
      out.push({
        connector,
        tool,
        classification: found.tool.classification,
        description: SHOP_TOOL_DESCRIPTIONS[name],
        inputSchema: structuredClone(SHOP_TOOL_INPUT_SCHEMAS[name]),
      });
    }
  }
  return out.sort((a, b) => compareText(`${a.connector}.${a.tool}`, `${b.connector}.${b.tool}`));
}

function usd2(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * 実効ポリシーの要約（policySummary。FR-025「このエージェントにできること」の固定の文テンプレート、LLM を使わない：agent-builder.md:103）。
 * 本番の文テンプレート（edge・ui-text）はまだないので、実効ポリシーの事実だけを短い固定の文にした（予算の行は agent-builder.md:103 の例の形）。
 * 本番の関数ができたら差し替える（プロンプトのハッシュが変わる）
 */
export function policySummaryLines(effective: EffectivePolicy): string[] {
  const reads: string[] = [];
  const writes: string[] = [];
  for (const t of mcpToolsOf(effective)) {
    const found = findToolManifest(SHOP_CONNECTORS, `${t.connector}.${t.tool}`);
    if (found === null) continue;
    (found.tool.classification === "read" ? reads : writes).push(found.tool.actionNoun);
  }
  const lines: string[] = [];
  if (reads.length > 0) lines.push(`${reads.join("・")}ができます（読み取り）`);
  if (writes.length === 0 || !effective.mcp.llmWrite) {
    lines.push("外部のサービスには書き込めません");
  } else {
    const list = writes.join("・");
    const hasRule = effective.rules.enabled && effective.rules.items.length > 0;
    switch (effective.autonomy.mcp_write) {
      case "approve":
        lines.push(hasRule ? `${list}は、ルールに一致すれば確認なしで、ほかは利用者の確認のあとで実行されます` : `${list}は、利用者の確認のあとで実行されます`);
        break;
      case "handoff":
        lines.push(`${list}は、利用者に引き継ぎます`);
        break;
      case "deny":
        lines.push(`${list}はできません`);
        break;
      case "auto":
        lines.push(`${list}は、確認なしで実行されます`);
        break;
    }
  }
  lines.push(`1回あたり最大 ${usd2(effective.budget.per_task_usd)}、1日 ${usd2(effective.budget.agent_day_usd ?? effective.budget.per_day_usd)} まで`);
  return lines;
}

/**
 * 用意した編成（受信箱係 → 仕入れ係）の実効ポリシーを compose で作る（本番のオーナーの初期投入 G-08 と同じ定義・同じワークスペースのポリシー）。
 * 違反・切り詰めがあれば例外（定義が本番で反映できない形なら計測しない）
 */
export function measureFormation(opts: { workspaceKind?: "owner" | "guest"; formation?: DemoFormation } = {}): MeasureFormation {
  const demo = opts.formation ?? SHOP_DEMO_FORMATION;
  const workspaceKind = opts.workspaceKind ?? "owner";
  const workspacePolicy = defaultWorkspacePolicy(workspaceKind);
  const members = [...demo.members]
    .sort((a, b) => a.position - b.position)
    .map((m): MeasureMember => {
      const job = m.agent.jobs[0];
      if (job === undefined) throw new TypeError(`担当 ${m.agent.name} に仕事がない`);
      const r = compose({ ceilings: DEFAULT_CEILINGS, workspacePolicy, agent: m.agent }, job.id);
      if (r.violations.length > 0 || r.clamped.length > 0) {
        throw new TypeError(`担当 ${m.agent.name} の定義がポリシーを超えている：${[...r.violations, ...r.clamped].map((v) => v.path).join("・")}`);
      }
      return {
        position: m.position,
        name: m.agent.name,
        isSpokesperson: m.isSpokesperson,
        template: job.template,
        jobId: job.id,
        instructions: job.instructions,
        effective: r.effective,
        policyHash: r.effectivePolicyHash,
        mcpTools: mcpToolsOf(r.effective),
      };
    });
  return { askText: demo.ask.text, shape: demo.ask.shape, members, workspaceKind };
}

export interface MeasureTaskContextInput {
  formation: MeasureFormation;
  member: MeasureMember;
  taskId: string;
  askId: string;
  /** 仮想の時計の今（sim-world の世界では仮想の時刻を「今」にする） */
  now: IsoDateTime;
  /** 前の段の報告（BR-71）。1段目は空 */
  handoffs: TaskContext["input"]["handoffs"];
}

/**
 * 担当のタスクの文脈（API-036 相当。formation-runtime.md §2.6・§3.5 の startMemberTask と同じ材料）。
 * 連絡板（FR-064）・回答（FR-063）はリハーサルの中では作らない（SW §4.4.7）ので teamBoard は false。
 * runKind・isDryRun は runner が分岐に使わない（ADR-015）。sim-world の走行なので rehearsal・true にした
 */
export function buildMeasureTaskContext(input: MeasureTaskContextInput): TaskContext {
  const { formation, member } = input;
  return {
    taskId: input.taskId,
    runKind: "rehearsal",
    isDryRun: true,
    template: member.template,
    phases: templatePhases(member.template),
    tools: selectTaskTools({
      template: member.template,
      mcpGrants: member.effective.mcp.grants,
      webAllowDomains: member.effective.web.allow_domains,
      guestWorkspace: formation.workspaceKind === "guest",
      formation: { shape: formation.shape, memberCount: formation.members.length, isAggregator: false },
      teamBoard: false,
      followup: false,
    }),
    mcpTools: structuredClone(member.mcpTools),
    policySummary: policySummaryLines(member.effective),
    policy: structuredClone(member.effective),
    agent: { name: member.name, jobInstructions: member.instructions, tuning: null, skills: [], memories: [] },
    input: { prompt: formation.askText, handoffs: structuredClone(input.handoffs), teamMessages: [] },
    formation: {
      askId: input.askId,
      shape: formation.shape,
      position: member.position,
      stageCount: formation.members.length,
      isSpokesperson: member.isSpokesperson,
      isAggregator: false,
      members: formation.members.map((m) => ({ name: m.name, position: m.position, isAggregator: false })),
    },
    now: input.now,
    limits: { maxTokens: MEASURE_MAX_TOKENS },
  };
}

/** プロンプトのハッシュの基準の時刻（1日目 18:00。シードによらない） */
export const PROMPT_HASH_NOW: IsoDateTime = formatJst(jstAt(SHOP_DEFAULT_START_DATE, "18:00"));

/**
 * プロンプトのハッシュ（結果の条件。SW §4.9 の手順7）：担当ごとに、全フェーズのシステムプロンプト・受け渡しの前のタスクの入力・
 * ツールの宣言・MCP のツール・出力の上限を正規形 JSON にして SHA-256。受け渡しの本文は走行ごとに違うので入れない
 */
export function measurePromptHash(formation: MeasureFormation, now: IsoDateTime = PROMPT_HASH_NOW): Hex64 {
  return hashCanonical(
    formation.members.map((member) => {
      const ctx = buildMeasureTaskContext({ formation, member, taskId: "prompt-hash", askId: "prompt-hash", now, handoffs: [] });
      return {
        agent: member.name,
        system: ctx.phases.map((_, i) => buildSystemPrompt(ctx, i)),
        input: buildTaskInput(ctx),
        tools: ctx.tools,
        mcpTools: ctx.mcpTools,
        maxTokens: ctx.limits.maxTokens,
      };
    }),
  );
}
