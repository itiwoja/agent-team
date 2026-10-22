// 依頼の生成の DB 側（FR-061。apps/app/src/asks/create.ts の生成の部分の WorkspaceDO 版）：設定プランナーの材料を集める・質問を載せる・
// 編成を保存する（足りない担当を作り、使い回す担当には仕事を足す）・失敗で閉じる。どれも DO の中で呼ぶ同期の関数。
// - 外部（Gemini）は呼ばない。設定プランナー（planner.ts の planFormation）は Workflow の step から呼び、その前後でここの関数を DO で呼ぶ（G-14）
// - 編成の保存（担当・仕事・スナップショット・依頼の状態・事象）は1つのトランザクション。ロック（lockWorkspace）は要らない（DO の中は1本の流れ）
// - Node 版は Kill Switch を登録簿（kind = ask_generate）の中断で止めていた。WorkspaceDO 版は materializeFormation が保存の前に
//   ワークスペースの行を見て、発動中なら AskPlanError("kill_switch") を投げる（Gemini の呼び出しは呼ぶ側の llm-call が止める）
// - 生成の打ち切り（30秒：A-98）は呼ぶ側（Workflow）が数え、failureReasonOf に timedOut で渡す
// - 受け付け（acceptAsk・answerAskQuestion）は accept.ts、実行を始めるのは run.ts の startAskRunTx

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
  type ConnectorCatalog,
  type Json,
  type WorkspacePolicy,
} from "@open-team/kernel";
import { AppError, maskSecrets } from "@open-team/platform";
import { appendAuditLog } from "../db/audit.ts";
import { findAgentByName, getAgent, getLatestWorkspacePolicy, insertAgentJob, insertAgentWithSnapshot, insertAskMember, listConnectors, listConnectorTools } from "../db/repo/app.ts";
import {
  appendAgentSnapshot,
  getAsk,
  getLatestLiveRun,
  listAgentsForPlanner,
  listMembers,
  markAskFormed,
  markAskGenerationFailed,
  setAskQuestion,
  transitionAsk,
} from "../db/repo/asks.ts";
import { getAgentSnapshotRow } from "../db/repo/edge.ts";
import { listPackInstalls } from "../db/repo/sandbox.ts";
import { all, newId, type WsDb } from "../db/sqlite.ts";
import type { AgentRow, AskMemberRow, AskRow, JsonObject, Uuid } from "../db/types.ts";
import { getWorkspace } from "../db/workspace.ts";
import { catalogOf } from "../catalog.ts";
import { nextScheduledRun } from "../schedule.ts";
import { formationView, triggerView } from "../views/asks/format.ts";
import { emitAskEvent } from "./accept.ts";
import {
  AskPlanError,
  FAILURE_MESSAGES,
  jobHintsOf,
  type PlannedFormation,
  type PlannedMember,
  type PlannerAgent,
  type PlannerConnector,
  type PlannerInput,
} from "./planner.ts";

type MemberRowN = AskMemberRow & { agent_name: string };

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

function grantsOf(def: JsonObject | null): Record<string, string[]> {
  const connectors = (def?.grants as { connectors?: Record<string, { grant?: unknown }> } | undefined)?.connectors ?? {};
  return Object.fromEntries(
    Object.entries(connectors).map(([slug, g]) => [slug, Array.isArray(g.grant) ? g.grant.filter((t): t is string => typeof t === "string") : []]),
  );
}

/**
 * パックの作業場から出した依頼（asks.pack_id）のヒント：パックの名前と、そのパックで入れた担当のうち動ける（active・idle）もの。
 * 入っていない（入れた記録がない）・動ける担当が残っていなければ null（ふつうの依頼と同じに決める）。
 * Node 版はパックの名前を apps/app/src/packs/catalog.ts（@open-team/edge を引く）から取っていた。WorkspaceDO 版はカタログを持たないので、
 * pack_installs の行に名前があればそれを、なければ pack_id を名前に使う（いまの pack_installs には名前の列がないので pack_id になる）
 */
function packHintOf(db: WsDb, packId: string | null, living: ReadonlySet<string>): PlannerInput["pack"] {
  if (packId === null) return null;
  const install = listPackInstalls(db).find((i) => i.pack_id === packId);
  if (install === undefined) return null;
  const agentIds = install.agent_ids.filter((id) => living.has(id));
  const name = (install as { name?: unknown }).name;
  return agentIds.length === 0 ? null : { id: install.pack_id, name: typeof name === "string" && name !== "" ? name : install.pack_id, agentIds };
}

function buildPlannerInput(db: WsDb, ask: AskRow, policy: WorkspacePolicy): PlannerInput {
  const agentRows = listAgentsForPlanner(db);
  const connectorRows = listConnectors(db);
  const toolRows = listConnectorTools(db);
  const skillRows = all<{ agent_id: string; name: string }>(db, {}, "SELECT agent_id, name FROM agent_skills WHERE removed_at IS NULL ORDER BY name");
  const skillsByAgent = new Map<string, string[]>();
  for (const r of skillRows) skillsByAgent.set(r.agent_id, [...(skillsByAgent.get(r.agent_id) ?? []), r.name]);
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
  const pack = packHintOf(db, ask.pack_id, new Set(agentRows.filter((a) => a.agent.status === "active" || a.agent.status === "idle").map((a) => a.agent.id)));
  return {
    text: ask.text,
    mention: mention === null ? null : { agentId: mention.id, name: mention.name },
    pack,
    agents,
    connectors,
    policyLines: policyLinesOf(policy),
    answered: ask.question !== null && ask.question_answer !== null ? { question: ask.question.text, answer: ask.question_answer } : null,
    // 作業場（D-116）は WorkspaceDO 版ではまだ使えない（Node 版は sandbox のプロバイダーがあるか）
    sandbox: false,
  };
}

function requirePolicy(db: WsDb): WorkspacePolicy {
  const row = getLatestWorkspacePolicy(db);
  if (row === null) throw new AskPlanError("planner_error", "ワークスペースのポリシーがない");
  return parseWorkspacePolicy(row.policy);
}

/**
 * 設定プランナーに渡す材料（Node 版の generateAsk の入口と loadMaterials）。
 * 依頼が generating でない・質問に答えていなければ null（生成しない）。ポリシーがなければ AskPlanError（planner_error）
 */
export function loadPlannerMaterials(db: WsDb, askId: Uuid): { ask: AskRow; input: PlannerInput } | null {
  const ask = getAsk(db, askId);
  if (ask === null || ask.status !== "generating") return null;
  if (ask.question !== null && ask.question_answer === null) return null;
  return { ask, input: buildPlannerInput(db, ask, requirePolicy(db)) };
}

// ---- 質問 ----

/** 設定プランナーの質問を載せる（generating のまま。BR-49：すでに質問があれば載せず false）。ask.question の事象と監査ログも同じトランザクション */
export function savePlanQuestion(
  db: WsDb,
  askId: Uuid,
  question: { text: string; choices: Array<{ id: string; label: string }>; allowFreeText: boolean },
  now: Date,
): boolean {
  return db.transaction(() => {
    const saved = setAskQuestion(db, askId, question, now);
    if (!saved) return false;
    emitAskEvent(db, { type: "ask.question", askId, question: { text: question.text, choices: question.choices, allowFreeText: question.allowFreeText } }, now);
    appendAuditLog(db, { eventType: "ask.question", actorType: "system", actorId: "asks", payload: { askId, choices: question.choices.length } }, now);
    return true;
  });
}

// ---- 編成の保存（1つのトランザクション） ----

const shortId = (id: string): string => id.replace(/-/g, "").slice(0, 8).toLowerCase();
const newAgentSlug = (id: string): string => `a-${shortId(id)}`;

/** 担当の定義に仕事を足した定義を、検証・compose して返す。通らなければ AskPlanError */
export function withJob(
  base: AgentDefinitionInput,
  job: { slug: string; kind: "once" | "recurring"; template: PlannedMember["template"]; instructions: string },
  m: { policy: WorkspacePolicy; catalog: ConnectorCatalog },
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
 * 編成を保存して依頼を動かせる状態（running）にする（1つのトランザクション）。
 * 新しい担当：最初の境界＋付与（つながっていて使えるものだけ）＋この依頼の仕事。使い回す担当：この依頼の仕事を足した新しいスナップショット（権限は広げない）。
 * generating でなくなっていれば（時間切れ・取り消しで先に閉じた）null。Kill Switch 発動中は AskPlanError("kill_switch")（Node 版の登録簿の中断の代わり）。
 * ポリシーは Node 版のように呼ぶ側から受け取らず、ここで最新のものを読む（材料を集めてから保存するまでに変わっても、保存の時点のもので検査する）
 */
export function materializeFormation(
  db: WsDb,
  a: { askId: Uuid; requesterId: Uuid; planned: PlannedFormation; now: Date },
): { ask: AskRow; members: MemberRowN[] } | null {
  const { planned, now, askId } = a;
  return db.transaction(() => {
    const ws = getWorkspace(db);
    if (ws === null) return null;
    const fresh = getAsk(db, askId);
    if (fresh === null || fresh.status !== "generating") return null;
    if (ws.kill_switch_engaged) throw new AskPlanError("kill_switch", "Kill Switch が発動中なので編成を保存しない");
    const policy = requirePolicy(db);
    const catalog = catalogOf(listConnectors(db), listConnectorTools(db));
    const m = { policy, catalog };

    // 作る担当の数（エージェントは20体まで：A-81。保存の時点で数え直す）
    const livingAgents = listAgentsForPlanner(db).filter((r) => r.agent.status !== "removed").length;
    const creating = planned.members.filter((p) => p.proposed.agent.kind === "new").length;
    if (livingAgents + creating > FORMATION_LIMITS.maxAgentsPerWorkspace) throw new AskPlanError("agent_limit", "エージェントの上限を超える");

    const jobKind = planned.trigger === null ? "once" : "recurring";
    const created: Array<{ planned: PlannedMember; agent: AgentRow; jobId: Uuid; isNew: boolean }> = [];
    for (const p of planned.members) {
      const slug = `ask-${shortId(askId)}-${p.isAggregator ? "agg" : p.proposed.position}`;
      const job = { slug, kind: jobKind as "once" | "recurring", template: p.template, instructions: p.instructions };
      if (p.proposed.agent.kind === "existing") {
        const agent = getAgent(db, p.proposed.agent.agentId);
        if (agent === null || (agent.status !== "active" && agent.status !== "idle")) throw new AskPlanError("formation_invalid", "使い回す担当が見つからない");
        const def = agent.current_snapshot_id === null ? null : (getAgentSnapshotRow(db, agent.current_snapshot_id)?.definition ?? null);
        if (def === null) throw new AskPlanError("planner_error", `担当「${agent.name}」の定義を読めない`);
        const built = withJob(normalizeAgentDefinition(def as unknown as AgentDefinitionInput), job, m, agent.name);
        const snapshot = appendAgentSnapshot(db, {
          agentId: agent.id,
          definition: built.definition as unknown as JsonObject,
          effectivePolicies: built.effectivePolicies,
          clamped: built.composed.clamped as unknown as Json[],
          ceilingsVersion: CEILINGS_VERSION,
          now,
        });
        const jobRow = insertAgentJob(db, { agentId: agent.id, slug, kind: job.kind, template: job.template, status: "active", now });
        appendAuditLog(db, { eventType: "job.created", actorType: "system", actorId: "asks", payload: { agentId: agent.id, jobId: jobRow.id, slug, template: job.template, origin: "ask", askId, snapshotId: snapshot.id } }, now);
        created.push({ planned: p, agent, jobId: jobRow.id, isNew: false });
      } else {
        // 名前の重なり：計画のあとに作られた担当と重なっていたら、番号を足して避ける
        let name = p.proposed.agent.name;
        for (let n = 2; findAgentByName(db, name) !== null; n += 1) name = `${p.proposed.agent.name}${n}`;
        const role = p.role !== null && (AGENT_ROLES as readonly string[]).includes(p.role) ? p.role : null;
        const initial = initialAgentDefinition({ name, role, workspacePolicy: policy });
        const grants = { ...(initial.grants.connectors ?? {}) } as Record<string, { grant: string[] }>;
        for (const [slug2, tools] of Object.entries(p.grants)) grants[slug2] = { grant: [...tools] };
        const base: AgentDefinitionInput = { ...(initial as unknown as AgentDefinitionInput), grants: { ...(initial.grants.web === undefined ? {} : { web: initial.grants.web }), connectors: grants } };
        const built = withJob(base, job, m, name);
        const res = insertAgentWithSnapshot(db, {
          slug: newAgentSlug(newId()),
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
        const jobRow = insertAgentJob(db, { agentId: res.agent.id, slug, kind: job.kind, template: job.template, status: "active", now });
        appendAuditLog(
          db,
          {
            eventType: "agent.created",
            actorType: "system",
            actorId: "asks",
            payload: {
              agentId: res.agent.id,
              name,
              snapshotId: res.snapshot.id,
              origin: "ask",
              askId,
              policyHashes: Object.fromEntries(Object.entries(built.effectivePolicies).map(([s, e]) => [s, e.hash])),
            },
          },
          now,
        );
        appendAuditLog(db, { eventType: "job.created", actorType: "system", actorId: "asks", payload: { agentId: res.agent.id, jobId: jobRow.id, slug, template: job.template, origin: "ask", askId } }, now);
        created.push({ planned: p, agent: res.agent, jobId: jobRow.id, isNew: true });
      }
    }

    for (const c of created) {
      insertAskMember(db, {
        askId,
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
    const formed = markAskFormed(db, askId, {
      shape: planned.shape,
      formation,
      trigger: trigger === null ? null : { type: "schedule", cron: trigger.cron, timezone: trigger.timezone },
      nextRunAt: trigger === null ? null : nextScheduledRun(trigger, now),
      now,
    });
    if (formed === null) return null;
    const members = listMembers(db, askId);
    appendAuditLog(
      db,
      {
        eventType: "ask.formed",
        actorType: "system",
        actorId: "asks",
        payload: { askId, shape: planned.shape, plannerAttempts: formed.planner_attempts, members: created.map((c) => ({ agentId: c.agent.id, isNew: c.isNew, jobId: c.jobId })), notes: planned.notes },
      },
      now,
    );
    const fv = formationView(formed, members);
    if (fv !== null) emitAskEvent(db, { type: "ask.formed", askId, formation: fv, trigger: triggerView(formed) }, now);
    return { ask: formed, members };
  });
}

// ---- 失敗 ----

/**
 * 失敗の理由を決める（Node 版の failureReasonOf の WorkspaceDO 版）。
 * Node 版は中断の理由（GenerationTimeout・登録簿の StopRequested）と GeminiCallError を見ていた。WorkspaceDO 版は、
 * 時間切れを呼ぶ側の timedOut で、LLM の呼び出しの失敗を src/edge/llm-call.ts の LlmCallError（kind を持つ。名前で見分ける）で受ける
 */
export function failureReasonOf(e: unknown, timedOut: boolean): AskPlanError["code"] {
  if (e instanceof AskPlanError) return e.code;
  if (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "LlmCallError") {
    const kind = (e as { kind?: unknown }).kind;
    if (kind === "kill_switch") return "kill_switch";
    if (kind === "budget") return "budget_exceeded";
    if (kind === "aborted") return timedOut ? "timeout" : "kill_switch";
    return "planner_error";
  }
  if (timedOut) return "timeout";
  return "planner_error";
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 生成に失敗した：generating → failed（ask.failed の事象と監査ログ。detail は秘密をマスクして300文字まで）。すでに閉じていれば何もしない */
export function failGeneration(
  db: WsDb,
  a: { askId: Uuid; reason: AskPlanError["code"]; detail: string; now: Date; secrets: readonly string[] },
): void {
  const { askId, reason, now } = a;
  db.transaction(() => {
    const failed = markAskGenerationFailed(db, askId, reason, now);
    if (failed === null) return;
    emitAskEvent(db, { type: "ask.failed", askId, reason, message: FAILURE_MESSAGES[reason] }, now);
    appendAuditLog(db, { eventType: "ask.failed", actorType: "system", actorId: "asks", payload: { askId, reason, detail: maskSecrets(a.detail, a.secrets).slice(0, 300) } }, now);
  });
}

/**
 * 編成を保存したあと（依頼は running）、実行を始められなかったとき：running → cancelled（Kill Switch）か failed。
 * 実行の行がまだないので alarm も Kill Switch の後始末も拾えない。ここで閉じないと依頼が実行なしの running で固まる。
 * 別の経路（返事など）が先に実行を始めていたら閉じない。外へは投げない（Node 版はログに残した。WorkspaceDO 版は console.error）
 */
export function closeFailedStart(db: WsDb, a: { askId: Uuid; error: unknown; now: Date; secrets: readonly string[] }): void {
  const { askId, error, now } = a;
  const killed = error instanceof AppError && error.code === "KILL_SWITCH_ENGAGED";
  const to = killed ? "cancelled" : "failed";
  try {
    db.transaction(() => {
      if (getLatestLiveRun(db, askId) !== null) return;
      const moved = transitionAsk(db, askId, ["running"], to, now);
      if (moved === null) return;
      emitAskEvent(db, { type: "ask.status", askId, status: to }, now);
      appendAuditLog(
        db,
        killed
          ? { eventType: "ask.cancelled", actorType: "system", actorId: "kill_switch", payload: { askId, reason: "kill_switch" } }
          : { eventType: "ask.failed", actorType: "system", actorId: "asks", payload: { askId, reason: "start_failed", detail: maskSecrets(errorText(error), a.secrets).slice(0, 300) } },
        now,
      );
    });
  } catch (closing) {
    console.error("ask.start_close_failed：実行を始められなかった依頼を閉じられなかった", { askId, error: errorText(closing) });
  }
}
