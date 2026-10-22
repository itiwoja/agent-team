// 依頼を作る（FR-061・API-072・073）：依頼を generating で作り、設定プランナーが編成を作り、足りない担当を作って（使い回す担当には仕事を足して）、
// すぐ動かす（確認の ○ は挟まない：D-67）。生成は裏で進み、結果は SSE の ask.*（contract.ts）で届く。
// - 外部（Gemini）はトランザクションの外。編成の保存（担当・仕事・スナップショット・依頼の状態・事象）は1つのトランザクション（G-14）
// - Gemini は edge の callGemini を通す：Kill Switch・費用の上限（全体 $15・ゲスト $4。BR-62）・usage_records（phase = planner、ask_id）
// - 生成の打ち切りは30秒（A-98）。Kill Switch は登録簿（kind = ask_generate）の中断で止まる
// - 質問は1つまで（BR-49）：質問を載せて生成を一度終え、API-073 の答えで続きを作る（プロセスの中で待たない）

import {
  appendAuditLog,
  lockWorkspace,
  type AgentRow,
  type AskMemberRow,
  type AskRow,
  type JsonObject,
  type Queryable,
  type SessionCtx,
  type Tx,
  type Uuid,
  type WsCtx,
} from "@open-team/db";
import { findAgentByName, getLatestWorkspacePolicy, insertAgentJob, insertAgentWithSnapshot, insertAskMember, listConnectors, listConnectorTools } from "@open-team/db/app";
import {
  appendAgentSnapshot,
  bumpPlannerAttempts,
  findLiveAgentByIdOrName,
  getAsk,
  insertGeneratingAsk,
  listAgentsForPlanner,
  listMembers,
  markAskFormed,
  markAskGenerationFailed,
  getLatestLiveRun,
  setAskQuestion,
  setAskQuestionAnswer,
  transitionAsk,
} from "@open-team/db/asks";
import { listPackInstalls } from "@open-team/db/sandbox";
import { GeminiCallError, SPEND_LIMITS, callGemini, canStartWork, spendDeniedAppError } from "@open-team/edge";
import {
  AGENT_ROLES,
  CEILINGS_VERSION,
  DEFAULT_CEILINGS,
  FORMATION_LIMITS,
  composeAll,
  initialAgentDefinition,
  normalizeAgentDefinition,
  parseWorkspacePolicy,
  validateAgentDefinition,
  type AgentDefinitionInput,
  type Json,
  type WorkspacePolicy,
} from "@open-team/kernel";
import { LlmError, modelForPurpose, type LlmClient } from "@open-team/llm";
import { AppError, knownSecretsFromEnv, maskSecrets } from "@open-team/platform";
import type { AppDeps, InTxResult } from "../deps.ts";
import { catalogOf } from "../owner-setup.ts";
import { findPack } from "../packs/catalog.ts";
import { nextScheduledRun } from "../schedule.ts";
import { StopRequested } from "../registry.ts";
import type { AnswerAskBody, AskAcceptedResponse, CreateAskBody } from "./contract.ts";
import { emitAskEvent } from "./events.ts";
import { askSummary, formationView, triggerView } from "./format.ts";
import {
  AskPlanError,
  FAILURE_MESSAGES,
  jobHintsOf,
  planFormation,
  type PlannedFormation,
  type PlannedMember,
  type PlannerAgent,
  type PlannerConnector,
  type PlannerInput,
} from "./planner.ts";
import { startAskRun, type AskRunDeps } from "./run.ts";

export type CreateAskDeps = AskRunDeps & {
  /** 試験で差し替える（生成の打ち切り。既定 30秒：A-98） */
  generationTimeoutMs?: number;
};

type MemberRowN = AskMemberRow & { agent_name: string };

class GenerationTimeout extends Error {
  constructor() {
    super("設定プランナーの生成が時間切れになった");
    this.name = "GenerationTimeout";
  }
}

let cachedSecrets: readonly string[] | null = null;
const secrets = (): readonly string[] => (cachedSecrets ??= knownSecretsFromEnv(process.env));

/** 利用者が書いた文の秘密情報をマスクして保存・受け渡しに使う（BR-32）。上限 2,000文字 */
export function maskUserText(text: string): string {
  return maskSecrets(text, secrets()).slice(0, 2000);
}

// ---- 材料 ----

/** ワークスペースのポリシーの要約（設定プランナーに渡す固定の文） */
export function policyLinesOf(p: WorkspacePolicy): string[] {
  const lines: string[] = [];
  const level = (op: "mcp_write" | "mcp_read") => p.autonomy[op];
  if (level("mcp_write") === "approve" || level("mcp_write") === undefined) lines.push("書き込み（発注・送信など）は送る前の確認が要る");
  if (level("mcp_write") === "deny") lines.push("書き込みはできない");
  if (level("mcp_read") === "auto") lines.push("読み取りは確認なしで動く");
  lines.push(`1回の仕事の予算は $${p.budget.per_task_usd}、1日は $${p.budget.per_day_usd}`);
  lines.push(`使えるコネクタ：${p.connectors.enabled.join("・") || "なし"}`);
  return lines;
}

interface Materials {
  input: PlannerInput;
  policy: WorkspacePolicy;
  catalog: ReturnType<typeof catalogOf>;
}

function grantsOf(def: JsonObject | null): Record<string, string[]> {
  const connectors = (def?.grants as { connectors?: Record<string, { grant?: unknown }> } | undefined)?.connectors ?? {};
  return Object.fromEntries(
    Object.entries(connectors).map(([slug, g]) => [slug, Array.isArray(g.grant) ? g.grant.filter((t): t is string => typeof t === "string") : []]),
  );
}

/**
 * パックの作業場から出した依頼（asks.pack_id）のヒント：パックの名前と、そのパックで入れた担当のうち動ける（active・idle）もの。
 * パックがない・入っていない（入れた記録がない）・動ける担当が残っていなければ null（ふつうの依頼と同じに決める）
 */
async function packHintOf(q: Queryable, ctx: WsCtx, packId: string | null, living: ReadonlySet<string>): Promise<PlannerInput["pack"]> {
  if (packId === null) return null;
  const def = findPack(packId);
  if (def === undefined) return null;
  const install = (await listPackInstalls(q, ctx)).find((i) => i.pack_id === packId);
  if (install === undefined) return null;
  const agentIds = install.agent_ids.filter((id) => living.has(id));
  return agentIds.length === 0 ? null : { id: def.id, name: def.name, agentIds };
}

export async function loadMaterials(deps: Pick<AppDeps, "db"> & { sandbox?: AppDeps["sandbox"] }, ctx: WsCtx, ask: AskRow): Promise<Materials> {
  const q = deps.db;
  const [agentRows, connectorRows, toolRows, policyRow] = await Promise.all([
    listAgentsForPlanner(q, ctx),
    listConnectors(q, ctx),
    listConnectorTools(q, ctx),
    getLatestWorkspacePolicy(q, ctx),
  ]);
  if (policyRow === null) throw new AskPlanError("planner_error", "ワークスペースのポリシーがない");
  const policy = parseWorkspacePolicy(policyRow.policy);
  const skillRows = await q.query<{ agent_id: string; name: string }>("SELECT agent_id, name FROM agent_skills WHERE workspace_id = $1 AND removed_at IS NULL ORDER BY name", [ctx.workspaceId]);
  const skillsByAgent = new Map<string, string[]>();
  for (const r of skillRows.rows) skillsByAgent.set(r.agent_id, [...(skillsByAgent.get(r.agent_id) ?? []), r.name]);
  const agents: PlannerAgent[] = agentRows.map(({ agent, jobCount, definition }) => ({
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    jobCount,
    grants: grantsOf(definition),
    jobHints: jobHintsOf(definition),
    templates: ((definition?.jobs as Array<{ template?: unknown }> | undefined) ?? []).flatMap((j) => (typeof j.template === "string" ? [j.template] : [])),
    skills: skillsByAgent.get(agent.id) ?? [],
  }));
  const connectors: PlannerConnector[] = connectorRows.map((c) => ({
    slug: c.slug,
    connected: c.enabled,
    tools: toolRows
      .filter((t) => t.connector_id === c.id)
      .map((t) => ({ name: t.name, classification: t.classification, usable: t.status === "ok" && t.classification !== "unclassified" })),
  }));
  const mention = ask.mention_agent_id === null ? null : (agentRows.find((a) => a.agent.id === ask.mention_agent_id)?.agent ?? null);
  const pack = await packHintOf(q, ctx, ask.pack_id, new Set(agentRows.filter((a) => a.agent.status === "active" || a.agent.status === "idle").map((a) => a.agent.id)));
  const input: PlannerInput = {
    text: ask.text,
    mention: mention === null ? null : { agentId: mention.id, name: mention.name },
    pack,
    agents,
    connectors,
    policyLines: policyLinesOf(policy),
    answered: ask.question !== null && ask.question_answer !== null ? { question: ask.question.text, answer: ask.question_answer } : null,
    // 作業場：プロバイダーがあり、オーナーのワークスペース（edge の sandboxAllowed と同じ）
    sandbox: deps.sandbox != null && ctx.kind === "owner",
  };
  return { input, policy, catalog: catalogOf(connectorRows, toolRows) };
}

// ---- 編成の保存（1つのトランザクション） ----

const shortId = (id: string): string => id.replace(/-/g, "").slice(0, 8).toLowerCase();
const newAgentSlug = (id: string): string => `a-${shortId(id)}`;

/** 担当の定義に仕事を足した定義を、検証・compose して返す。通らなければ AskPlanError */
export function withJob(
  base: AgentDefinitionInput,
  job: { slug: string; kind: "once" | "recurring"; template: PlannedMember["template"]; instructions: string },
  m: { policy: WorkspacePolicy; catalog: Materials["catalog"] },
  label: string,
) {
  const raw: AgentDefinitionInput = {
    ...base,
    jobs: [
      ...(base.jobs ?? []),
      { id: job.slug, kind: job.kind, template: job.template, instructions: job.instructions, trigger: null, deliver: [], guards: [] },
    ],
  };
  const v = validateAgentDefinition(raw, { tools: m.catalog });
  if (!v.ok) throw new AskPlanError("formation_invalid", `担当「${label}」の定義が通らない：${v.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
  const composed = composeAll({ ceilings: DEFAULT_CEILINGS, workspacePolicy: m.policy, agent: v.definition });
  if (composed.violations.length > 0) {
    throw new AskPlanError("formation_invalid", `担当「${label}」がポリシーより緩い：${composed.violations.map((x) => x.path).join(", ")}`);
  }
  const effectivePolicies = Object.fromEntries(Object.entries(composed.jobs).map(([slug, r]) => [slug, { policy: r.effective, hash: r.effectivePolicyHash }]));
  return { definition: v.definition, effectivePolicies, composed };
}

/**
 * 編成を保存して依頼を動かせる状態（running）にする。ワークスペースの行をロックし、ほかの生成と直列にする。
 * 新しい担当：最初の境界＋付与（つながっていて使えるものだけ）＋この依頼の仕事。使い回す担当：この依頼の仕事を足した新しいスナップショット（権限は広げない）。
 * generating でなくなっていれば（Kill Switch・時間切れで先に閉じた）null
 */
export async function materializeFormation(
  tx: Tx,
  deps: Pick<AppDeps, "ids" | "log">,
  ctx: WsCtx,
  a: { ask: AskRow; requesterId: Uuid; planned: PlannedFormation; policy: WorkspacePolicy; now: Date },
): Promise<{ ask: AskRow; members: MemberRowN[] } | null> {
  const { planned, now } = a;
  const ws = await lockWorkspace(tx, ctx);
  if (ws === null) return null;
  const fresh = await getAsk(tx, ctx, a.ask.id);
  if (fresh === null || fresh.status !== "generating") return null;
  const connectorRows = await listConnectors(tx, ctx);
  const toolRows = await listConnectorTools(tx, ctx);
  const catalog = catalogOf(connectorRows, toolRows);
  const m = { policy: a.policy, catalog };

  // 作る担当の数（エージェントは20体まで：A-81。ロックの中で数え直す）
  const livingAgents = (await listAgentsForPlanner(tx, ctx)).filter((r) => r.agent.status !== "removed").length;
  const creating = planned.members.filter((p) => p.proposed.agent.kind === "new").length;
  if (livingAgents + creating > FORMATION_LIMITS.maxAgentsPerWorkspace) throw new AskPlanError("agent_limit", "エージェントの上限を超える");

  const jobKind = planned.trigger === null ? "once" : "recurring";
  const created: Array<{ planned: PlannedMember; agent: AgentRow; jobId: Uuid; isNew: boolean }> = [];
  for (const p of planned.members) {
    const slug = `ask-${shortId(a.ask.id)}-${p.isAggregator ? "agg" : p.proposed.position}`;
    const job = { slug, kind: jobKind as "once" | "recurring", template: p.template, instructions: p.instructions };
    if (p.proposed.agent.kind === "existing") {
      const agent = await getAgentRowTx(tx, ctx, p.proposed.agent.agentId);
      if (agent === null || (agent.status !== "active" && agent.status !== "idle")) throw new AskPlanError("formation_invalid", "使い回す担当が見つからない");
      const snap = agent.current_snapshot_id === null ? null : await tx.query<{ definition: JsonObject | null }>("SELECT definition FROM agent_snapshots WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, agent.current_snapshot_id]);
      const def = snap?.rows[0]?.definition;
      if (def === null || def === undefined) throw new AskPlanError("planner_error", `担当「${agent.name}」の定義を読めない`);
      const built = withJob(normalizeAgentDefinition(def as unknown as AgentDefinitionInput), job, m, agent.name);
      const snapshot = await appendAgentSnapshot(tx, ctx, {
        agentId: agent.id,
        definition: built.definition as unknown as JsonObject,
        effectivePolicies: built.effectivePolicies,
        clamped: built.composed.clamped as unknown as Json[],
        ceilingsVersion: CEILINGS_VERSION,
        now,
      });
      const jobRow = await insertAgentJob(tx, ctx, { agentId: agent.id, slug, kind: job.kind, template: job.template, status: "active", now });
      await appendAuditLog(tx, ctx.workspaceId, { eventType: "job.created", actorType: "system", actorId: "asks", payload: { agentId: agent.id, jobId: jobRow.id, slug, template: job.template, origin: "ask", askId: a.ask.id, snapshotId: snapshot.id } }, now);
      created.push({ planned: p, agent, jobId: jobRow.id, isNew: false });
    } else {
      // 名前の重なり：計画のあとに作られた担当と重なっていたら、番号を足して避ける（ロックの中で決める）
      let name = p.proposed.agent.name;
      for (let n = 2; (await findAgentByName(tx, ctx, name)) !== null; n += 1) name = `${p.proposed.agent.name}${n}`;
      const role = p.role !== null && (AGENT_ROLES as readonly string[]).includes(p.role) ? p.role : null;
      const initial = initialAgentDefinition({ name, role, workspacePolicy: a.policy, workspaceKind: ctx.kind });
      const grants = { ...(initial.grants.connectors ?? {}) } as Record<string, { grant: string[] }>;
      for (const [slug2, tools] of Object.entries(p.grants)) grants[slug2] = { grant: [...tools] };
      const base: AgentDefinitionInput = { ...(initial as unknown as AgentDefinitionInput), grants: { ...(initial.grants.web === undefined ? {} : { web: initial.grants.web }), connectors: grants } };
      const built = withJob(base, job, m, name);
      const res = await insertAgentWithSnapshot(tx, ctx, {
        slug: newAgentSlug(deps.ids.newId()),
        name,
        nameSource: "suggested",
        role,
        status: "active",
        definition: built.definition as unknown as JsonObject,
        effectivePolicies: built.effectivePolicies,
        clamped: built.composed.clamped as unknown as Json[],
        ceilingsVersion: CEILINGS_VERSION,
        now,
      });
      const jobRow = await insertAgentJob(tx, ctx, { agentId: res.agent.id, slug, kind: job.kind, template: job.template, status: "active", now });
      await appendAuditLog(
        tx,
        ctx.workspaceId,
        {
          eventType: "agent.created",
          actorType: "system",
          actorId: "asks",
          payload: {
            agentId: res.agent.id,
            name,
            snapshotId: res.snapshot.id,
            origin: "ask",
            askId: a.ask.id,
            policyHashes: Object.fromEntries(Object.entries(built.effectivePolicies).map(([s, e]) => [s, e.hash])),
          },
        },
        now,
      );
      await appendAuditLog(tx, ctx.workspaceId, { eventType: "job.created", actorType: "system", actorId: "asks", payload: { agentId: res.agent.id, jobId: jobRow.id, slug, template: job.template, origin: "ask", askId: a.ask.id } }, now);
      created.push({ planned: p, agent: res.agent, jobId: jobRow.id, isNew: true });
    }
  }

  for (const c of created) {
    await insertAskMember(tx, ctx, {
      askId: a.ask.id,
      agentId: c.agent.id,
      jobId: c.jobId,
      position: c.planned.proposed.position,
      dependsOn: c.planned.proposed.dependsOn,
      isAggregator: c.planned.isAggregator,
      isSpokesperson: c.planned.proposed.isSpokesperson,
      isNew: c.isNew,
      summary: c.planned.summary.slice(0, 200),
      now,
    });
  }
  const formation: JsonObject = {
    shape: planned.shape,
    members: created.map((c) => ({
      agentId: c.agent.id,
      agentName: c.agent.name,
      isNew: c.isNew,
      jobId: c.jobId,
      summary: c.planned.summary,
      position: c.planned.proposed.position,
      dependsOn: [...c.planned.proposed.dependsOn],
    })),
    notes: planned.notes,
  };
  const trigger = planned.trigger;
  const formed = await markAskFormed(tx, ctx, a.ask.id, {
    shape: planned.shape,
    formation,
    trigger: trigger === null ? null : { type: "schedule", cron: trigger.cron, timezone: trigger.timezone },
    nextRunAt: trigger === null ? null : nextScheduledRun(trigger, now),
    now,
  });
  if (formed === null) return null;
  const members = await listMembers(tx, ctx, a.ask.id);
  await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "ask.formed",
      actorType: "system",
      actorId: "asks",
      payload: { askId: a.ask.id, shape: planned.shape, plannerAttempts: formed.planner_attempts, members: created.map((c) => ({ agentId: c.agent.id, isNew: c.isNew, jobId: c.jobId })), notes: planned.notes },
    },
    now,
  );
  const fv = formationView(formed, members);
  if (fv !== null) await emitAskEvent(tx, ctx, { type: "ask.formed", askId: a.ask.id, formation: fv, trigger: triggerView(formed) }, now);
  return { ask: formed, members };
}

async function getAgentRowTx(tx: Tx, ctx: WsCtx, agentId: Uuid): Promise<AgentRow | null> {
  const r = await tx.query<AgentRow>(
    `SELECT id, workspace_id, slug, name, name_source, role, appearance, status, current_snapshot_id, disabled_by, disabled_reason, disabled_at, created_at, updated_at
       FROM agents WHERE workspace_id = $1 AND id = $2`,
    [ctx.workspaceId, agentId],
  );
  return r.rows[0] ?? null;
}

// ---- 生成（裏で進める） ----

/** Gemini を callGemini 経由で呼ぶ LlmClient（Kill Switch・費用の上限・usage_records）。失敗は GeminiCallError */
function plannerLlm(deps: CreateAskDeps, ctx: WsCtx, askId: Uuid): LlmClient {
  return {
    async generate(req, opts = {}) {
      const { response } = await callGemini(
        {
          db: deps.db,
          llm: deps.llm,
          clock: deps.clock,
          log: deps.log,
          ...(deps.edge?.retry === undefined ? {} : { retry: deps.edge.retry }),
          ...(deps.edge?.spendLimits === undefined ? {} : { spendLimits: { ...SPEND_LIMITS, ...deps.edge.spendLimits } }),
        },
        { workspaceId: ctx.workspaceId, workspaceKind: ctx.kind, taskId: null, agentId: null, askId, purpose: "planner", phase: "planner", ...(opts.signal === undefined ? {} : { signal: opts.signal }) },
        req,
      );
      return response;
    },
  };
}

/** 失敗の理由を決める（中断の理由・費用の上限・Kill Switch・Gemini の失敗・検査に外れた） */
export function failureReasonOf(e: unknown, signal: AbortSignal): AskPlanError["code"] {
  if (e instanceof AskPlanError) return e.code;
  if (signal.reason instanceof GenerationTimeout) return "timeout";
  if (signal.aborted && signal.reason instanceof StopRequested) return "kill_switch";
  if (e instanceof GeminiCallError) {
    if (e.kind === "kill_switch") return "kill_switch";
    if (e.kind === "budget") return "budget_exceeded";
    if (e.kind === "aborted") return signal.reason instanceof GenerationTimeout ? "timeout" : "kill_switch";
    return "planner_error";
  }
  if (e instanceof LlmError) return "planner_error";
  return "planner_error";
}

async function failGeneration(deps: CreateAskDeps, ctx: WsCtx, askId: Uuid, reason: AskPlanError["code"], detail: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const now = deps.clock.now();
    await lockWorkspace(tx, ctx);
    const failed = await markAskGenerationFailed(tx, ctx, askId, reason, now);
    if (failed === null) return;
    await emitAskEvent(tx, ctx, { type: "ask.failed", askId, reason, message: FAILURE_MESSAGES[reason] }, now);
    await appendAuditLog(tx, ctx.workspaceId, { eventType: "ask.failed", actorType: "system", actorId: "asks", payload: { askId, reason, detail: maskSecrets(detail, secrets()).slice(0, 300) } }, now);
  });
}

/**
 * 編成を保存したあと（依頼は running）、実行を始められなかったとき：running → cancelled（Kill Switch。run.ts の cancelRunsOfHaltedTasks と同じ）か failed。
 * 実行の行がまだないので tick も Kill Switch の hook も拾えない。ここで閉じないと依頼が実行なしの running で固まる。外へは投げない
 */
export async function closeFailedStart(deps: CreateAskDeps, ctx: WsCtx, askId: Uuid, error: unknown): Promise<void> {
  const killed = error instanceof AppError && error.code === "KILL_SWITCH_ENGAGED";
  const to = killed ? "cancelled" : "failed";
  try {
    await deps.db.transaction(async (tx) => {
      const now = deps.clock.now();
      await lockWorkspace(tx, ctx);
      // 失敗処理がロックを待つ間に reply など別経路が実行を開始していたら、依頼を閉じない。
      if (await getLatestLiveRun(tx, ctx, askId) !== null) return;
      const moved = await transitionAsk(tx, ctx, askId, ["running"], to, now);
      if (moved === null) return;
      await emitAskEvent(tx, ctx, { type: "ask.status", askId, status: to }, now);
      await appendAuditLog(
        tx,
        ctx.workspaceId,
        killed
          ? { eventType: "ask.cancelled", actorType: "system", actorId: "kill_switch", payload: { askId, reason: "kill_switch" } }
          : { eventType: "ask.failed", actorType: "system", actorId: "asks", payload: { askId, reason: "start_failed", detail: maskSecrets(errorText(error), secrets()).slice(0, 300) } },
        now,
      );
    });
  } catch (closing) {
    deps.log.error("ask.start_close_failed", "実行を始められなかった依頼を閉じられなかった", { workspaceId: ctx.workspaceId, askId, error: closing });
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface GenerateResult {
  outcome: "formed" | "question" | "failed" | "skipped";
  /** formed のとき、最初の実行が落ち着くまで（試験が待つ。呼び出し側は待たなくてよい） */
  runDone?: Promise<void>;
}

/** 設定プランナーで編成を作って動かす（バックグラウンドで呼ぶ。例外は投げず、失敗は ask.failed にする） */
export async function generateAsk(deps: CreateAskDeps, ctx: WsCtx & { userId: Uuid | null }, askId: Uuid): Promise<GenerateResult> {
  const controller = new AbortController();
  deps.registry.register(askId, ctx.workspaceId, controller, "ask_generate");
  const timer = setTimeout(() => controller.abort(new GenerationTimeout()), deps.generationTimeoutMs ?? FORMATION_LIMITS.generationTimeoutMs);
  timer.unref?.();
  try {
    const ask = await getAsk(deps.db, ctx, askId);
    if (ask === null || ask.status !== "generating") return { outcome: "skipped" };
    if (ask.question !== null && ask.question_answer === null) return { outcome: "skipped" };
    const mats = await loadMaterials(deps, ctx, ask);
    const plan = await planFormation(mats.input, {
      llm: plannerLlm(deps, ctx, askId),
      model: modelForPurpose(deps.env.gemini, "planner"),
      signal: controller.signal,
      onAttempt: async () => {
        await bumpPlannerAttempts(deps.db, ctx, askId, 1, deps.clock.now());
      },
    });
    if (plan.kind === "question") {
      const ok = await deps.db.transaction(async (tx) => {
        const now = deps.clock.now();
        await lockWorkspace(tx, ctx);
        const saved = await setAskQuestion(tx, ctx, askId, plan.question, now);
        if (!saved) return false;
        await emitAskEvent(tx, ctx, { type: "ask.question", askId, question: { text: plan.question.text, choices: plan.question.choices, allowFreeText: plan.question.allowFreeText } }, now);
        await appendAuditLog(tx, ctx.workspaceId, { eventType: "ask.question", actorType: "system", actorId: "asks", payload: { askId, choices: plan.question.choices.length } }, now);
        return true;
      });
      return { outcome: ok ? "question" : "skipped" };
    }
    const requesterId = ctx.userId ?? ask.created_by;
    const formed = await deps.db.transaction(
      (tx) => materializeFormation(tx, deps, ctx, { ask, requesterId, planned: plan.formation, policy: mats.policy, now: deps.clock.now() }),
      { retryOnce: true },
    );
    if (formed === null) return { outcome: "skipped" };
    // すぐ動かす（編成の確認は挟まない：D-67）。編成の保存のあとに止まったら、running のまま残さず閉じる
    let started: Awaited<ReturnType<typeof startAskRun>>;
    try {
      started = await startAskRun(deps, ctx, askId, { requesterId: ask.created_by, trigger: "initial" });
    } catch (e) {
      await closeFailedStart(deps, ctx, askId, e);
      return { outcome: "failed" };
    }
    return { outcome: "formed", ...(started === null ? {} : { runDone: started.done }) };
  } catch (e) {
    const reason = failureReasonOf(e, controller.signal);
    if (reason === "planner_error" || reason === "formation_invalid") deps.log.warn("ask.generate_failed", "編成を作れなかった", { workspaceId: ctx.workspaceId, askId, reason, error: e });
    try {
      await failGeneration(deps, ctx, askId, reason, e instanceof Error ? e.message : String(e));
    } catch (closing) {
      deps.log.error("ask.generate_close_failed", "失敗した生成を閉じられなかった", { workspaceId: ctx.workspaceId, askId, error: closing });
    }
    return { outcome: "failed" };
  } finally {
    clearTimeout(timer);
    deps.registry.unregister(askId);
  }
}

// ---- 受け付け（API-072・073。トランザクションの中。冪等：runIdempotent） ----

/** 受け付けてよいか：Kill Switch・費用の上限（同時実行数は待つだけなので止めない）。ロックの中で見る */
async function assertCanAccept(tx: Tx, ctx: WsCtx, now: Date, limits: AskRunDeps["edge"]): Promise<void> {
  const ws = await lockWorkspace(tx, ctx);
  if (ws === null) throw new AppError("NOT_FOUND");
  if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");
  const r = await canStartWork(tx, ws, now, { ...SPEND_LIMITS, ...limits?.spendLimits });
  if (!r.ok && r.reason !== "concurrency" && r.reason !== "kill_switch") throw spendDeniedAppError({ scope: r.reason }, now);
}

export async function acceptAsk(
  tx: Tx,
  deps: CreateAskDeps,
  s: SessionCtx,
  body: CreateAskBody,
  now: Date,
): Promise<InTxResult<AskAcceptedResponse>> {
  await assertCanAccept(tx, s, now, deps.edge);
  let mentionId: Uuid | null = null;
  if (body.mention !== undefined) {
    const key = body.mention.replace(/^[@＠]/, "").trim();
    const agent = key === "" ? null : await findLiveAgentByIdOrName(tx, s, key);
    if (agent === null) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "mention", reason: "指定された担当が見つかりません" }] });
    mentionId = agent.id;
  }
  // パックの作業場から出した依頼：このワークスペースに入っているパックだけ（生成は裏で進むので、依頼の行に残して設定プランナーのヒントにする）
  let packId: string | null = null;
  if (body.packId !== undefined) {
    const installed = (await listPackInstalls(tx, s)).some((i) => i.pack_id === body.packId);
    if (!installed) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "packId", reason: "入っていないパックです" }] });
    packId = body.packId;
  }
  const text = maskUserText(body.text);
  const ask = await insertGeneratingAsk(tx, s, { createdBy: s.userId, text, mentionAgentId: mentionId, packId, now });
  await appendAuditLog(tx, s.workspaceId, { eventType: "ask.created", actorType: "user", actorId: s.userId, payload: { askId: ask.id, mention: mentionId, packId } }, now);
  await emitAskEvent(tx, s, { type: "ask.created", askId: ask.id, text: ask.text, status: "generating" }, now);
  return {
    body: { ask: askSummary(ask) },
    afterCommit: () => {
      void generateAsk(deps, s, ask.id).catch((error: unknown) => deps.log.error("ask.generate_crashed", "依頼の生成が想定外の失敗で止まった", { workspaceId: s.workspaceId, askId: ask.id, error }));
    },
  };
}

/** 質問への答え（API-073）。質問が出ていて答えていない生成中の依頼だけ（ほかは 409 ASK_NOT_WAITING） */
export async function answerAskQuestion(
  tx: Tx,
  deps: CreateAskDeps,
  s: SessionCtx,
  askId: Uuid,
  body: AnswerAskBody,
  now: Date,
): Promise<InTxResult<AskAcceptedResponse>> {
  await assertCanAccept(tx, s, now, deps.edge);
  const ask = await getAsk(tx, s, askId);
  if (ask === null) throw new AppError("NOT_FOUND");
  if (ask.status !== "generating" || ask.question === null || ask.question_answer !== null) {
    throw new AppError(ask.status === "done" || ask.status === "failed" || ask.status === "cancelled" ? "ASK_ALREADY_FINISHED" : "ASK_NOT_WAITING");
  }
  let answer: string;
  if (body.choiceId !== undefined) {
    const choice = ask.question.choices.find((c) => c.id === body.choiceId);
    if (choice === undefined) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "choiceId", reason: "選択肢にありません" }] });
    answer = choice.label;
  } else {
    if (!ask.question.allowFreeText) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "text", reason: "この質問は選択肢から選んでください" }] });
    answer = maskUserText(body.text as string);
  }
  const updated = await setAskQuestionAnswer(tx, s, askId, answer, now);
  if (updated === null) throw new AppError("ASK_NOT_WAITING");
  await appendAuditLog(tx, s.workspaceId, { eventType: "ask.question_answered", actorType: "user", actorId: s.userId, payload: { askId, choiceId: body.choiceId ?? null } }, now);
  return {
    body: { ask: askSummary(updated) },
    afterCommit: () => {
      void generateAsk(deps, s, askId).catch((error: unknown) => deps.log.error("ask.generate_crashed", "依頼の生成が想定外の失敗で止まった", { workspaceId: s.workspaceId, askId, error }));
    },
  };
}
