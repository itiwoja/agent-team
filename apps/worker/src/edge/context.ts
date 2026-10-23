// タスクの文脈（packages/edge/src/context.ts の WorkspaceDO 版。API-036 getTaskContext の中身。formation-runtime.md §2.6・§2.5・§3.9）。
// 本番どおりの材料から組み立てる：テンプレート（agent_jobs.template）・フェーズ（templatePhases）・ツール（selectTaskTools。§2.5 の手順）・
// 付与された MCP のツール（connector_tools）・実効ポリシーの要約（固定の文）・受け渡し（BR-71）・編成（ask_members）・「今」。
// runner は信用しない前提（ADR-003）なので、ツールの宣言は LLM Proxy でもここで作ったものだけを使う。
// Node 版との違い：
// - どれも同期（DO の中で呼ぶ）
// - 4c で動かさない道具（Web・連絡板・利用者への質問・作業場）は TaskContext の tools から外す（DEFERRED_TOOLS。loadTaskSetup のコメント）
// - 連絡板の文脈（始まる前に届いていた連絡・追いのターンの質問）は 4f。teamMessages は空、followupQuestion は付けない

import type { EffectivePolicy, Hex64 } from "@open-team/kernel";
import {
  selectTaskTools,
  templatePhases,
  type McpToolSpec,
  type Shape,
  type TaskContext,
  type TaskRunKind,
  type TemplateId,
  type ToolName,
  type ToolSpec,
} from "@open-team/runner";
import { maskSecrets } from "@open-team/platform";
import { getAgentRow, getAskRow, getAskRunTriggerType, listAskMembers, listConnectorToolsBySlugs, listInputTaskReports } from "../db/repo/edge.ts";
import { listAgentSkills } from "../db/repo/sandbox.ts";
import type { WsDb } from "../db/sqlite.ts";
import type { AgentJobRow, AgentRow, AgentSnapshotRow, AskMemberRow, TaskRow, WorkspaceRow } from "../db/types.ts";
import { SANDBOX_TOOLS } from "../db/types.ts";
import { EdgeDataError, loadTaskPolicy, type TaskPolicy } from "./inputs.ts";
import { EDGE_LIMITS } from "./limits.ts";
import { policySummaryLines } from "./policy-summary.ts";
import { isTrustedSkill, NO_TRUSTED_SKILLS, type TrustedSkillDigests } from "./skill-trust.ts";
import { compareText, isPlainObject, toJstIso } from "./util.ts";

const TEMPLATE_IDS: ReadonlySet<string> = new Set<TemplateId>(["researcher", "briefer", "watcher", "assistant", "dev-coder", "reviewer"]);

/**
 * 4c ではまだ動かせない道具（TaskContext の tools から外し、callTool に来たら TOOL_CALL_NOT_ALLOWED）。
 * Web の検索・取得（web_search・web_fetch）・連絡板（team_post・team_wait）・利用者への質問（ask_user）は 4f 以降、
 * 作業場の道具（list_files など）は作業場（Cloudflare の Sandbox）を移すまで使えない
 */
export const DEFERRED_TOOLS: ReadonlySet<string> = new Set<ToolName>(["web_search", "web_fetch", "team_post", "team_wait", "ask_user", ...SANDBOX_TOOLS]);

/** 1つのタスクの「動かす材料」（getTaskContext と LLM Proxy が同じものを使う） */
export interface TaskSetup {
  task: TaskRow;
  workspace: WorkspaceRow;
  agent: AgentRow;
  job: AgentJobRow;
  snapshot: AgentSnapshotRow;
  taskPolicy: TaskPolicy;
  policy: EffectivePolicy;
  policyHash: Hex64;
  template: TemplateId;
  /** 自分の担当（依頼のタスクのとき） */
  member: (AskMemberRow & { agent_name: string }) | null;
  formation: TaskContext["formation"];
  /** selectTaskTools の結果から DEFERRED_TOOLS を除いたもの（TaskContext.tools。LLM に渡すツールはこの部分集合だけ） */
  tools: ToolSpec[];
  toolNames: ReadonlySet<string>;
  /** 付与された MCP のツール（状態 ok・コネクタが有効なものだけ。'<コネクタ>.<ツール>' の昇順） */
  mcpTools: McpToolSpec[];
  /** 担当のスキル（名前と説明。D-116） */
  skills: Array<{ name: string; description: string }>;
  /** このタスクで作業場（サンドボックス）を使えるか（WorkspaceDO 版は常に false） */
  sandbox: boolean;
}

/**
 * このタスクで作業場を使えるか（D-116）：作業場のプロバイダーがあり、本番の依頼のタスク。
 * 試し実行では使わない（費用と悪用の面）
 */
export function sandboxAllowed(task: Pick<TaskRow, "ask_id" | "is_dry_run" | "kind">, providerAvailable: boolean): boolean {
  return providerAvailable && task.ask_id !== null && !task.is_dry_run && task.kind === "normal";
}

function runKindOf(task: Pick<TaskRow, "is_dry_run">): TaskRunKind {
  return task.is_dry_run ? "dry_run" : "live";
}

/** スナップショットの定義の仕事（slug）の instructions・tuning（利用者が書いたデータ：rt:111） */
function jobTextOf(snapshot: AgentSnapshotRow, slug: string): { instructions: string; tuning: string | null } {
  const def: unknown = snapshot.definition;
  const jobs = isPlainObject(def) && Array.isArray(def.jobs) ? def.jobs : [];
  const job = jobs.find((j) => isPlainObject(j) && j.id === slug);
  if (!isPlainObject(job)) return { instructions: "", tuning: null };
  const instructions = typeof job.instructions === "string" ? job.instructions : "";
  const tuning = typeof job.tuning === "string" && job.tuning.trim() !== "" ? job.tuning : null;
  return { instructions, tuning };
}

/** 付与（実効ポリシーの mcp.grants）× connector_tools（状態 ok・有効なコネクタ）。説明・入力スキーマは確定したもの（tool_hash の材料） */
export function grantedMcpTools(db: WsDb, policy: EffectivePolicy): McpToolSpec[] {
  const grants = policy.mcp.grants;
  const hits = listConnectorToolsBySlugs(db, Object.keys(grants));
  const out: McpToolSpec[] = [];
  for (const { connector, tool } of hits) {
    const granted = Object.hasOwn(grants, connector.slug) ? grants[connector.slug] : undefined;
    if (!Array.isArray(granted) || !granted.includes(tool.name)) continue;
    // 確認待ちのツール・無効のコネクタは見せない（呼んでも decide が tool_needs_review・connector_disabled で拒否する）
    if (tool.status !== "ok" || connector.enabled !== true) continue;
    out.push({
      connector: connector.slug,
      tool: tool.name,
      classification: tool.classification,
      description: tool.description,
      inputSchema: structuredClone(tool.input_schema),
    });
  }
  return out.sort((a, b) => compareText(`${a.connector}.${a.tool}`, `${b.connector}.${b.tool}`));
}

/** タスクの材料を DB から集める（タスクの行・ワークスペースの行は呼び出し側が taskId から引き直したもの） */
export function loadTaskSetup(
  db: WsDb,
  task: TaskRow,
  workspace: WorkspaceRow,
  taskPolicy?: TaskPolicy,
  opts: { sandboxProvider?: boolean; trustedSkills?: TrustedSkillDigests } = {},
): TaskSetup {
  const tp = taskPolicy ?? loadTaskPolicy(db, task);
  const agent = getAgentRow(db, task.agent_id);
  if (agent === null) throw new EdgeDataError(`タスク ${task.id} のエージェントが見つからない`);
  const template = tp.job.template;
  if (!TEMPLATE_IDS.has(template)) throw new EdgeDataError(`仕事 ${tp.job.slug} のテンプレート ${template} は 0-H で動かせない`);

  // 編成（依頼のタスクのとき）。自分の担当は ask_member_id、なければ仕事で引く（仕事と担当は1対1：ask_members_job_uq）
  let member: TaskSetup["member"] = null;
  let formation: TaskContext["formation"] = null;
  let memberCount = 0;
  let shape: Shape | null = null;
  if (task.ask_id !== null) {
    const ask = getAskRow(db, task.ask_id);
    const members = listAskMembers(db, task.ask_id);
    member = members.find((m) => m.id === task.ask_member_id) ?? members.find((m) => m.job_id === task.job_id) ?? null;
    if (ask !== null && ask.shape !== null && member !== null) {
      shape = ask.shape;
      memberCount = members.length;
      const workers = members.filter((m) => !m.is_aggregator);
      const positionOf = (m: AskMemberRow) => m.position ?? workers.findIndex((w) => w.id === m.id) + 1;
      formation = {
        askId: ask.id,
        shape: ask.shape,
        position: member.is_aggregator ? workers.length + 1 : positionOf(member),
        stageCount: workers.length,
        isSpokesperson: member.is_spokesperson,
        isAggregator: member.is_aggregator,
        members: members.map((m) => ({
          name: m.agent_name,
          position: m.is_aggregator ? workers.length + 1 : positionOf(m),
          isAggregator: m.is_aggregator,
          ...(ask.shape === "chain" && !m.is_aggregator ? { dependsOn: [...m.depends_on] } : {}),
        })),
      };
    }
  }

  const sandbox = sandboxAllowed(task, opts.sandboxProvider === true);
  // スキル（パックで入った手順書）。試し実行のタスクにも渡す（読むだけで外へ出ない）。
  // システムプロンプトの「# 使えるスキル」に出すのは、運営のパックと同じ中身（名前・説明・本文）のスキルだけ（SG-05）。
  // システムプロンプトは汚染を付ける前に組み立てるので、確かめられないスキルの名前・説明は出さない（load_skill で読めば包んで汚染する）
  const allSkills = listAgentSkills(db, agent.id);
  const trustedSkills = opts.trustedSkills ?? NO_TRUSTED_SKILLS;
  const skills = allSkills.filter((s) => isTrustedSkill(trustedSkills, s)).map((s) => ({ name: s.name, description: s.description }));
  const selected = selectTaskTools({
    template,
    mcpGrants: tp.policy.mcp.grants,
    webAllowDomains: tp.policy.web.allow_domains,
    formation: shape === null || member === null ? null : { shape, memberCount, isAggregator: member.is_aggregator },
    // 連絡板（FR-064）：2体以上の編成のタスクに team_post・team_wait を渡す（ひとりには作らない）
    teamBoard: shape !== null && shape !== "single",
    followup: task.kind === "followup",
    // 利用者への質問：本番の依頼のタスクだけ（試し実行では聞かない）
    askUser: task.ask_id !== null && !task.is_dry_run && task.kind === "normal",
    sandbox,
    skills: allSkills.length > 0,
  });
  // 4c で動かさない道具を外す（DEFERRED_TOOLS）。WorkspaceDO 版の callTool にまだ実行の中身がない（Web の取得・連絡板・利用者への質問は 4f 以降、
  // 作業場は移していない）ので、エージェントに見せない。runner は TaskContext.tools にない道具を宣言できず（LLM Proxy が 400）、
  // モデルが名前を返しても callTool が TOOL_CALL_NOT_ALLOWED にする。選び方（selectTaskTools）は Node 版のまま、外すのはここだけ
  const tools = selected.filter((t) => !DEFERRED_TOOLS.has(t.name));
  const mcpTools = grantedMcpTools(db, tp.policy);
  return {
    task,
    workspace,
    agent,
    job: tp.job,
    snapshot: tp.snapshot,
    taskPolicy: tp,
    policy: tp.policy,
    policyHash: tp.policyHash,
    template,
    member,
    formation,
    tools,
    toolNames: new Set(tools.map((t) => t.name)),
    mcpTools,
    skills,
    sandbox,
  };
}

/** 受け渡しの本文がないとき（失敗した段など）の決まった文 */
function missingReportText(status: string): string {
  return `（報告がありません：${status}）`;
}

/**
 * TaskContext（API-036）を組み立てる。外から来た文字列（依頼の本文・仕事の指示・受け渡しの本文）は秘密情報をマスクして渡す（BR-32、BD-08）。
 * now は「今」の時刻（実時間の JST で渡す）
 */
export function buildTaskContext(
  db: WsDb,
  setup: TaskSetup,
  opts: {
    now: Date;
    knownSecrets?: readonly string[];
    maxTokens?: number;
    /** 始まる前に届いていた連絡（4f の deliverAtStart が渡し済みにしたもの。BR-75）。それまでは空 */
    teamMessages?: TaskContext["input"]["teamMessages"];
  },
): TaskContext {
  const { task } = setup;
  const secrets = opts.knownSecrets ?? [];
  const mask = (s: string) => maskSecrets(s, secrets);
  const text = jobTextOf(setup.snapshot, setup.job.slug);
  const allInputs = listInputTaskReports(db, task.input_task_ids);
  // 定期の実行（見張り）で渡した「同じ担当の前の回の報告」は、受け渡しではなく前回の報告として渡す（run.ts の previousOf）
  const scheduled = task.ask_run_id !== null && getAskRunTriggerType(db, task.ask_run_id) === "schedule";
  const isPrevious = (t: (typeof allInputs)[number]) =>
    scheduled && t.ask_run_id !== task.ask_run_id && t.ask_member_id !== null && t.ask_member_id === task.ask_member_id;
  const previous = allInputs.find(isPrevious);
  const inputs = allInputs.filter((t) => !isPrevious(t));
  return {
    taskId: task.id,
    runKind: runKindOf(task),
    isDryRun: task.is_dry_run,
    template: setup.template,
    phases: templatePhases(setup.template),
    tools: structuredClone(setup.tools),
    mcpTools: structuredClone(setup.mcpTools),
    policySummary: policySummaryLines(setup.policy, setup.mcpTools),
    policy: structuredClone(setup.policy),
    agent: {
      name: setup.agent.name,
      jobInstructions: mask(text.instructions),
      tuning: text.tuning === null ? null : mask(text.tuning),
      skills: setup.skills.map((s) => ({ name: mask(s.name), description: mask(s.description) })),
      memories: [],
    },
    input: {
      prompt: task.prompt === null ? null : mask(task.prompt),
      handoffs: inputs.map((t) => ({
        fromAgentName: t.agent_name,
        fromTaskId: t.id,
        tainted: t.tainted === true || (Array.isArray(t.taint_sources) && t.taint_sources.length > 0),
        body: mask(t.report ?? missingReportText(t.status)),
      })),
      ...(previous === undefined || previous.report === null
        ? {}
        : {
            previousReport: {
              at: toJstIso(previous.finished_at ?? opts.now),
              tainted: previous.tainted === true || (Array.isArray(previous.taint_sources) && previous.taint_sources.length > 0),
              body: mask(previous.report),
            },
          }),
      // 連絡板（FR-064・BR-75）：始まる前に届いていた連絡。追いのターンの質問（followupQuestion）は 4f で足す
      teamMessages: opts.teamMessages ?? [],
    },
    formation: setup.formation === null ? null : structuredClone(setup.formation),
    now: toJstIso(opts.now),
    limits: { maxTokens: opts.maxTokens ?? EDGE_LIMITS.maxTokensDefault },
  };
}
