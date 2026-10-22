// 判定の入力を作る（G-01 の loadDecideInputs。decide を呼ぶ所が複数あっても出どころを1つにする：M-17）
// 出どころ：policy ＝ タスクのスナップショットの effective_policies[仕事の slug]／
// subject.tool ＝ connector_tools＋connectors.enabled から effectiveArgRoles ／ stepsUsed・costUsd・deniedCount・repeat* ＝ tasks ／
// dayCostUsd ＝ ワークスペースの Asia/Tokyo の当日の usage_records ／ agentDayCostUsd ＝ 当日のうち agent_id か task のエージェントが同じもの ／
// elapsedSec ＝ floor(now − started_at) ／ intentsCount ＝ そのタスクの action_intents の行数 ／
// unknownOutcomeKeys ＝ 同じ job_id のタスク ／ flags ＝ ワークスペースの行を最初にロックして Kill Switch を読む（M-21）／
// taint ＝ tasks.tainted・taint_sources

import {
  argRoleAt,
  effectiveArgRoles,
  effectivePolicyHash,
  fromMicroUsd,
  parseArgPath,
  type ArgRoleMap,
  type Counters,
  type EffectivePolicy,
  type Flags,
  type Hex64,
  type JsonObject,
  type Subject,
  type TaintState,
  type ToolInfo,
} from "@open-team/kernel";
import {
  lockWorkspace,
  system,
  type AgentJobRow,
  type AgentSnapshotRow,
  type ConnectorRow,
  type ConnectorToolRow,
  type Queryable,
  type TaskRow,
  type Tx,
  type WorkspaceRow,
  type WsCtx,
} from "@open-team/db";
import {
  countTaskIntents,
  findConnectorTool,
  getAgentJobRow,
  getAgentSnapshotRow,
  listUnknownOutcomeKeys,
  sumAgentDayCostUsd,
  sumWorkspaceDayCostUsd,
} from "@open-team/db/edge";
import { BUDGET_TIME_ZONE } from "./limits.ts";
import { isPlainObject, toJsonObject } from "./util.ts";

/** DB の行が足りない・壊れている（判定できないので許可しない：NFR-005。呼び出し側は 500 にする） */
export class EdgeDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeDataError";
  }
}

export interface TaskPolicy {
  policy: EffectivePolicy;
  /** 小文字16進64桁（M-07）。intentHash の effectivePolicyHash に使う */
  policyHash: Hex64;
  job: AgentJobRow;
  snapshot: AgentSnapshotRow;
}

/**
 * タスクの仕事の実効ポリシー（D-19：仕事ごと）。スナップショットは開始時に固定（BR-22）。
 * 保存してある hash と計算し直した policyHash が違えば例外（壊れたポリシーで判定しない）
 */
export async function loadTaskPolicy(
  q: Queryable,
  ctx: WsCtx,
  task: Pick<TaskRow, "id" | "job_id" | "agent_snapshot_id">,
): Promise<TaskPolicy> {
  const job = await getAgentJobRow(q, ctx, task.job_id);
  if (job === null) throw new EdgeDataError(`タスク ${task.id} の仕事が見つからない`);
  const snapshot = await getAgentSnapshotRow(q, ctx, task.agent_snapshot_id);
  if (snapshot === null) throw new EdgeDataError(`タスク ${task.id} のスナップショットが見つからない`);
  let entry: { policy: EffectivePolicy; hash: Hex64 } | null = null;
  const policies = snapshot.status === "valid" ? snapshot.effective_policies : null;
  if (policies !== null && Object.hasOwn(policies, job.slug) && policies[job.slug] !== undefined) entry = policies[job.slug]!;
  if (entry === null || !isPlainObject(entry.policy)) throw new EdgeDataError(`仕事 ${job.slug} の実効ポリシーがない`);
  const hash = effectivePolicyHash(entry.policy);
  if (hash !== entry.hash) throw new EdgeDataError(`仕事 ${job.slug} の policyHash が実効ポリシーと合わない`);
  return { policy: entry.policy, policyHash: hash, job, snapshot };
}

/** decide の subject.tool（M-02）。argRoles は effectiveArgRoles（未確定は destination：BR-56） */
export function toolInfoOf(
  connector: Pick<ConnectorRow, "enabled">,
  tool: Pick<ConnectorToolRow, "classification" | "status" | "input_schema" | "arg_roles" | "scope" | "tool_hash">,
): ToolInfo {
  return {
    classification: tool.classification,
    status: tool.status,
    connectorEnabled: connector.enabled === true,
    argRoles: effectiveArgRoles(tool.input_schema, isPlainObject(tool.arg_roles) ? tool.arg_roles : {}),
    scope: tool.scope,
    toolHash: tool.tool_hash,
  };
}

/**
 * destination・option の文字列の前後の空白を除く（KD §8-16：判定と送信の値をずらさない。Gateway は固定した引数をそのまま送る）。
 * content は変えない。写しを返す
 */
export function trimRoleStrings(args: JsonObject, argRoles: ArgRoleMap): JsonObject {
  const out = structuredClone(args);
  for (const path of Object.keys(argRoles)) {
    const role = argRoleAt(argRoles, path);
    if (role !== "destination" && role !== "option") continue;
    const p = parseArgPath(path);
    if (p === null || p.name === "__proto__") continue;
    if (p.kind === "scalar") {
      const v = Object.hasOwn(out, p.name) ? out[p.name] : undefined;
      if (typeof v === "string") out[p.name] = v.trim();
      continue;
    }
    if (p.field === "__proto__") continue;
    const list = Object.hasOwn(out, p.name) ? out[p.name] : undefined;
    if (!Array.isArray(list)) continue;
    for (const el of list) {
      if (!isPlainObject(el) || !Object.hasOwn(el, p.field)) continue;
      const v = (el as JsonObject)[p.field];
      if (typeof v === "string") (el as JsonObject)[p.field] = v.trim();
    }
  }
  return out;
}

/** mcp_call の引数（{ connector, tool, arguments }。runner の ToolArgs['mcp_call']）。形が違えば null（decide で unknown_action） */
export function parseMcpCallArgs(raw: unknown): { connector: string; tool: string; arguments: JsonObject } | null {
  if (!isPlainObject(raw)) return null;
  const { connector, tool } = raw;
  if (typeof connector !== "string" || connector === "" || typeof tool !== "string" || tool === "") return null;
  const inner = raw.arguments === undefined ? {} : toJsonObject(raw.arguments);
  if (inner === null) return null;
  return { connector, tool, arguments: inner };
}

/** 判定に使うコネクタ・ツール */
export interface McpTarget {
  slug: string;
  toolName: string;
  /** 'mcp.<slug>.<tool>' */
  action: string;
  connector: ConnectorRow;
  tool: ConnectorToolRow;
  info: ToolInfo;
}

/**
 * mcp_call の subject（kind は tool_call：M-14。actionType はツール名：M-15）。ツールが見つからなければ tool なし（decide で unknown_action）。
 * 見つかれば役割で引数の空白を除く（trimRoleStrings）
 */
export async function resolveMcpSubject(
  q: Queryable,
  ctx: WsCtx,
  call: { connector: string; tool: string; arguments: JsonObject },
): Promise<{ subject: Subject; mcp: McpTarget | null }> {
  const action = `mcp.${call.connector}.${call.tool}`;
  const hit = await findConnectorTool(q, ctx, call.connector, call.tool);
  if (hit === null) {
    return { subject: { kind: "tool_call", actionType: "mcp_call", action, args: call.arguments, paths: [], origin: "agent" }, mcp: null };
  }
  const info = toolInfoOf(hit.connector, hit.tool);
  const args = trimRoleStrings(call.arguments, info.argRoles);
  return {
    subject: { kind: "tool_call", actionType: "mcp_call", action, args, paths: [], tool: info, origin: "agent" },
    mcp: { slug: call.connector, toolName: call.tool, action, connector: hit.connector, tool: hit.tool, info },
  };
}

function usdOf(text: string): number {
  return fromMicroUsd(system.usdToMicro(text));
}

/** subject によらない判定の入力（同じ応答の中のツール呼び出しはこれを nextCounters で進めて使う） */
export interface DecideBase {
  workspace: WorkspaceRow;
  taskPolicy: TaskPolicy;
  counters: Counters;
  flags: Flags;
  taint: TaintState;
}

export interface LoadDecideOptions {
  /** 読み込み済みならそれを使う（同じタスクの中で固定：BR-22） */
  taskPolicy?: TaskPolicy;
}

/**
 * 判定の入力のうち subject によらないもの。ワークスペースの行を最初に FOR NO KEY UPDATE で取る（M-21：
 * Kill Switch の発動と直列にする）。タスクの行は呼び出し側がこのあとか前に（ワークスペースのあとで）FOR UPDATE する
 */
export async function loadDecideBase(tx: Tx, ctx: WsCtx, task: TaskRow, now: Date, opts: LoadDecideOptions = {}): Promise<DecideBase> {
  const workspace = await lockWorkspace(tx, ctx);
  if (workspace === null) throw new EdgeDataError(`ワークスペース ${ctx.workspaceId} が見つからない`);
  const taskPolicy = opts.taskPolicy ?? (await loadTaskPolicy(tx, ctx, task));
  const dayUsd = await sumWorkspaceDayCostUsd(tx, ctx, now, BUDGET_TIME_ZONE);
  const agentUsd = await sumAgentDayCostUsd(tx, ctx, task.agent_id, now, BUDGET_TIME_ZONE);
  const intentsCount = await countTaskIntents(tx, ctx, task.id);
  const unknownOutcomeKeys = await listUnknownOutcomeKeys(tx, ctx, task.job_id);
  const startedMs = task.started_at?.getTime();
  const elapsedSec = startedMs === undefined ? 0 : Math.max(0, Math.floor((now.getTime() - startedMs) / 1000));
  return {
    workspace,
    taskPolicy,
    counters: {
      stepsUsed: task.steps_used,
      costUsd: usdOf(task.cost_usd),
      dayCostUsd: usdOf(dayUsd),
      agentDayCostUsd: usdOf(agentUsd),
      elapsedSec,
      deniedCount: task.denied_count,
      repeatKey: task.repeat_key,
      repeatCount: task.repeat_count,
      intentsCount,
      unknownOutcomeKeys,
    },
    flags: { killSwitchEngaged: workspace.kill_switch_engaged, taskStatus: task.status },
    taint: { tainted: task.tainted, sources: Array.isArray(task.taint_sources) ? task.taint_sources : [] },
  };
}

export interface DecideInputs extends DecideBase {
  policy: EffectivePolicy;
  policyHash: Hex64;
  /** mcp_call は tool（と空白を除いた引数）を入れたもの。ツールが見つからなければ tool なし */
  subject: Subject;
  mcp: McpTarget | null;
}

/**
 * G-01 の loadDecideInputs(tx, task, subject, now)。decide(policy, subject, counters, flags, taint) にそのまま渡せる形を返す。
 * mcp_call の subject は action（'mcp.<slug>.<tool>'）から DB のツールを引き直す（呼び出し側が入れた tool は使わない）
 */
export async function loadDecideInputs(
  tx: Tx,
  ctx: WsCtx,
  task: TaskRow,
  subject: Subject,
  now: Date,
  opts: LoadDecideOptions = {},
): Promise<DecideInputs> {
  const base = await loadDecideBase(tx, ctx, task, now, opts);
  let finalSubject: Subject = subject;
  let mcp: McpTarget | null = null;
  if (subject.actionType === "mcp_call" && typeof subject.action === "string" && subject.action.startsWith("mcp.")) {
    const rest = subject.action.slice(4);
    const i = rest.indexOf(".");
    if (i > 0 && i < rest.length - 1) {
      const resolved = await resolveMcpSubject(tx, ctx, { connector: rest.slice(0, i), tool: rest.slice(i + 1), arguments: subject.args });
      mcp = resolved.mcp;
      // kind・origin は呼び出し側のまま（deliver は intent：M-14）。tool と引数だけ DB から引き直したものにする
      const { tool: _ignored, ...rest2 } = subject;
      finalSubject = resolved.subject.tool === undefined ? { ...rest2, args: resolved.subject.args } : { ...rest2, args: resolved.subject.args, tool: resolved.subject.tool };
    }
  }
  return { ...base, policy: base.taskPolicy.policy, policyHash: base.taskPolicy.policyHash, subject: finalSubject, mcp };
}
