// オーナーのワークスペースの初期投入（G-08。冪等。起動時と POST /internal/setup/owner-workspace から呼ぶ）
// 手順（外部の呼び出しはトランザクションの外：G-14）：
// 1. 利用者・ワークスペース・所属（db の ensureOwnerWorkspace。監査ログの起点 workspace.created）
// 2. ワークスペースのポリシー v1（kernel の既定。オーナーは per_day_usd 10：M-59）と、sim-core の SHOP_CONNECTORS をコネクタに登録
//    （url = SIM_WORLD_URL + path、認証は none：MT §3.14 の5）
// 3. gateway の EP-51 でツールを同期（tools/list。新しいツールは unclassified で入る：MT §3.12.4）
// 4. manifest の分類・引数の役割を確定し、tool_hash を計算し直す（MT §3.14 の7。MCP の注釈は使わない。needs_review のツールは触らない）
// 5. sim-world のデモ店舗（rehearsal_run_id が NULL の走行。あればそれ）
// 6. SHOP_DEMO_FORMATION の2体（受信箱係・仕入れ係。M-36 の付与）を agents・agent_snapshots（compose の結果）・agent_jobs に
// 7. 順番の依頼（asks・ask_members。毎日18時 Asia/Tokyo、seed_key = prepared-purchasing）
// ルールは入れない（G-04：すり抜けはリハーサルの候補のルールで見せる）。2回目は何も変えない（監査ログも増やさない）。
// 決めたこと：あるものは作り直さない（名前・seed_key で見つけたら使う）。SIM_WORLD_URL が変わったときだけコネクタの URL を揃える

import {
  appendAuditLog,
  ensureOwnerWorkspace as ensureOwnerWorkspaceRows,
  lockWorkspace,
  type ConnectorAuth,
  type ConnectorRow,
  type ConnectorToolRow,
  type JsonObject,
  type Tx,
  type Uuid,
  type WsCtx,
} from "@open-team/db";
import {
  findAgentByName,
  findAgentJob,
  findAskBySeedKey,
  getLatestWorkspacePolicy,
  insertAgentJob,
  insertAgentWithSnapshot,
  insertAsk,
  insertAskMember,
  insertWorkspacePolicyIfMissing,
  listAskMembers,
  listConnectors,
  listConnectorTools,
  upsertSimConnector,
} from "@open-team/db/app";
import { classifyConnectorTools, ManifestError } from "./connectors/classify.ts";
import {
  CEILINGS_VERSION,
  DEFAULT_CEILINGS,
  INITIAL_AGENT_BOUNDARY,
  composeAll,
  defaultWorkspacePolicy,
  effectiveArgRoles,
  hashCanonical,
  parseWorkspacePolicy,
  validateAgentDefinition,
  type ConnectorCatalog,
  type Json,
  type ToolInfo,
} from "@open-team/kernel";
import { CANDIDATE_RULE } from "./guest-rehearsal/scenarios.ts";
import { SHOP_CONNECTORS, SHOP_DEMO_FORMATION, type DemoFormation, type SimConnectorManifest } from "@open-team/sim-core";
import type { AppDeps } from "./deps.ts";
import { nextScheduledRun } from "./schedule.ts";

/** 用意した依頼の印（DB §3.4 の seed_key。ゲストのシードと同じ名前） */
export const PREPARED_ASK_SEED_KEY = "prepared-purchasing";
/** 投入した行の classified_by（MT §3.14 の7） */
export const SEED_ACTOR = "system:seed";

export type OwnerSetupStep = "env" | "workspace" | "connectors" | "sync" | "manifest" | "demo_store" | "agents";

/** どの手順で止まったか（呼び出し側のログ・応答に出す。原因は cause） */
export class OwnerSetupError extends Error {
  readonly step: OwnerSetupStep;
  constructor(step: OwnerSetupStep, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OwnerSetupError";
    this.step = step;
  }
}

export interface OwnerSetupResult {
  workspaceId: Uuid;
  ownerUserId: Uuid;
  /** この呼び出しで作った・変えたもの（2回目は全部空・false） */
  created: {
    workspace: boolean;
    policy: boolean;
    connectors: string[];
    connectorsUpdated: string[];
    classifiedTools: string[];
    agents: string[];
    jobs: string[];
    ask: boolean;
  };
  connectors: Array<{ slug: string; id: Uuid; tools: number }>;
  /** needs_review のまま確定しなかったツール（持ち主の確認が要る：MT §3.13.2） */
  needsReview: string[];
  demoStore: { executionId: string; created: boolean };
  agents: Array<{ name: string; agentId: Uuid; jobId: Uuid; snapshotId: Uuid | null }>;
  askId: Uuid;
}

export type OwnerSetupDeps = Pick<AppDeps, "db" | "env" | "log" | "clock" | "gatewayClient" | "simClient" | "ids">;

export interface OwnerSetupOptions {
  now?: Date;
  /** 既定は sim-core の SHOP_CONNECTORS・SHOP_DEMO_FORMATION（試験で差し替える） */
  connectors?: readonly SimConnectorManifest[];
  formation?: Readonly<DemoFormation>;
}

/** ツールの行から判定の時点の情報（validateAgentDefinition の付与・ガードの確認に使う） */
function toolInfoOf(row: ConnectorToolRow, connectorEnabled: boolean): ToolInfo {
  return {
    classification: row.classification,
    status: row.status,
    connectorEnabled,
    argRoles: effectiveArgRoles(row.input_schema, row.arg_roles),
    scope: row.scope,
    toolHash: row.tool_hash,
  };
}

export function catalogOf(connectors: readonly ConnectorRow[], tools: readonly ConnectorToolRow[]): ConnectorCatalog {
  const out: Record<string, { connected: boolean; tools: Record<string, ToolInfo> }> = {};
  for (const c of connectors) {
    out[c.slug] = {
      connected: c.enabled,
      tools: Object.fromEntries(tools.filter((t) => t.connector_id === c.id).map((t) => [t.name, toolInfoOf(t, c.enabled)])),
    };
  }
  return out;
}

/**
 * ゲストのワークスペースの用意した担当の1日（D-107）：SHOP_DEMO_FORMATION の per_day_usd（1）ではなく、ゲストで新しく作る担当と同じ
 * INITIAL_AGENT_BOUNDARY.guest_per_day_usd（4。ワークスペースの1日と天井以下）にする。審査員が自分で頼んだ依頼は用意した担当を
 * 「いつもの担当」として使い回すので、$1 だと自分の依頼のリハーサル（8件で約 $1.7〜2）と自動の再リハーサルが担当の1日の上限で止まる。
 * オーナーは変えない（事前計算の fixture.json はオーナーの世界の定義で作っている）。per_task_usd・付与・ルールは変えない
 */
export function preparedAgentBudgetFor<A extends { budget: { per_task_usd: number; per_day_usd: number } }>(
  kind: "owner" | "guest",
  agent: A,
  workspaceDayUsd: number,
): A {
  if (kind !== "guest") return agent;
  const perDay = Math.min(INITIAL_AGENT_BOUNDARY.guest_per_day_usd, workspaceDayUsd, DEFAULT_CEILINGS.budget.per_day_usd);
  return { ...agent, budget: { ...agent.budget, per_day_usd: perDay } };
}

/**
 * ゲストの仕入れ係（最後の担当）には、用意したリハーサルが試した候補のルール（山田珈琲への豆の発注は確認なし）を入れておく（D-101）。
 * 事前に走らせた結果・再試験は、このルールがある世界で走らせたもの。ルールは合格証がない間は使われない（BR-81）ので、入ったあとも発注は確認に回る
 */
function candidateRuleFor(kind: "owner" | "guest", m: DemoFormation["members"][number], formation: DemoFormation, catalog: ConnectorCatalog, now: Date): DemoFormation["members"][number]["agent"] {
  if (kind !== "guest" || m !== formation.members[formation.members.length - 1]) return m.agent;
  const toolHash = catalog[CANDIDATE_RULE.action.split(".")[1]!]?.tools[CANDIDATE_RULE.action.split(".")[2]!]?.toolHash;
  if (toolHash === undefined) return m.agent;
  const rule = { id: "r-0001", ...structuredClone(CANDIDATE_RULE), tool_hash: toolHash, added_by: SEED_ACTOR, added_at: now.toISOString() };
  return { ...m.agent, rules: [...(m.agent.rules ?? []), rule] } as unknown as DemoFormation["members"][number]["agent"];
}

const newAgentSlug = (id: string) => `a-${id.replace(/-/g, "").slice(0, 8).toLowerCase()}`;

export async function ensureOwnerWorkspace(deps: OwnerSetupDeps, opts: OwnerSetupOptions = {}): Promise<OwnerSetupResult> {
  const now = opts.now ?? deps.clock.now();
  if (!deps.env.simWorldUrl) throw new OwnerSetupError("env", "SIM_WORLD_URL が設定されていない");
  // 1
  const base = await ensureOwnerWorkspaceRows(deps.db, { now }).catch((e: unknown) => {
    throw new OwnerSetupError("workspace", "オーナーのワークスペースを作れなかった", { cause: e });
  });
  return seedWorkspace(deps, base.ctx, "owner", opts, { workspaceCreated: base.created });
}

/**
 * 2〜7（ポリシー・コネクタ・ツールの分類・デモ店舗・担当・用意した依頼）。ワークスペースの行ができたあとの投入で、
 * オーナーの起動時とゲストの作成（guest-seed.ts）が同じ処理を使う。kind でポリシーの日次上限（owner 10・guest 4：M-59・D-106）と用意した担当の1日（guest 4：D-107）が変わる
 */
export async function seedWorkspace(
  deps: OwnerSetupDeps,
  ctx: WsCtx & { userId: Uuid },
  kind: "owner" | "guest",
  opts: OwnerSetupOptions = {},
  o: { workspaceCreated: boolean; /** false なら監査ログを足さない（ゲストは作成の1件だけ：15:350） */ audit?: boolean } = { workspaceCreated: false },
): Promise<OwnerSetupResult> {
  const now = opts.now ?? deps.clock.now();
  const manifest = opts.connectors ?? SHOP_CONNECTORS;
  const formation = opts.formation ?? SHOP_DEMO_FORMATION;
  const simWorldUrl = deps.env.simWorldUrl;
  if (!simWorldUrl) throw new OwnerSetupError("env", "SIM_WORLD_URL が設定されていない");
  const auth: ConnectorAuth = { type: "none" };
  const created: OwnerSetupResult["created"] = {
    workspace: o.workspaceCreated,
    policy: false,
    connectors: [],
    connectorsUpdated: [],
    classifiedTools: [],
    agents: [],
    jobs: [],
    ask: false,
  };
  const ownerUserId = ctx.userId;
  const audit = async (tx: Tx, eventType: string, payload: JsonObject): Promise<void> => {
    if (o.audit === false) return;
    await appendAuditLog(tx, ctx.workspaceId, { eventType, actorType: "system", actorId: SEED_ACTOR, payload: { ...payload, origin: "seed" } }, now);
  };

  // 2
  const connectorRows = await deps.db
    .transaction(async (tx) => {
      await lockWorkspace(tx, ctx);
      const policy = defaultWorkspacePolicy(kind, manifest.map((c) => c.slug));
      const policyHash = hashCanonical(policy);
      const p = await insertWorkspacePolicyIfMissing(tx, ctx, { policy: policy as unknown as JsonObject, policyHash, createdBy: null, now });
      if (p.created) {
        created.policy = true;
        await audit(tx, "policy.snapshot_created", { scope: "workspace", version: p.row.version, policyHash });
      }
      const rows: ConnectorRow[] = [];
      for (const c of manifest) {
        const url = `${simWorldUrl}${c.path}`;
        const u = await upsertSimConnector(tx, ctx, { slug: c.slug, displayName: c.displayName, url, auth }, now);
        if (u.created) {
          created.connectors.push(c.slug);
          await audit(tx, "connector.registered", { connectorId: u.row.id, slug: c.slug, url, kind: "sim" });
        } else if (u.updated) {
          created.connectorsUpdated.push(c.slug);
          await audit(tx, "connector.updated", { connectorId: u.row.id, slug: c.slug, url });
        }
        rows.push(u.row);
      }
      return rows;
    })
    .catch((e: unknown) => {
      throw e instanceof OwnerSetupError ? e : new OwnerSetupError("connectors", "ポリシー・コネクタを入れられなかった", { cause: e });
    });

  // 3（gateway が tools/list を読んで connector_tools に入れる。境界の確認もここで通る：MT §3.14 の5）
  for (const c of connectorRows) {
    try {
      await deps.gatewayClient.syncTools(c.id);
    } catch (e) {
      throw new OwnerSetupError("sync", `ツールを同期できなかった：${c.slug}`, { cause: e });
    }
  }

  // 4（分類の手順は connectors/classify.ts と共通：owner-setup の振る舞いは変えない）
  const classify = await deps.db
    .transaction((tx) =>
      classifyConnectorTools(tx, ctx, {
        manifests: manifest,
        connectors: connectorRows,
        classifiedBy: SEED_ACTOR,
        now,
        audit,
      }),
    )
    .catch((e: unknown) => {
      if (e instanceof ManifestError) throw new OwnerSetupError("manifest", e.message, { cause: e });
      throw e instanceof OwnerSetupError ? e : new OwnerSetupError("manifest", "ツールの分類を確定できなかった", { cause: e });
    });
  const needsReview = classify.needsReview;
  const toolCounts = classify.connectorTools;
  created.classifiedTools.push(...classify.classified);
  if (needsReview.length > 0) {
    deps.log.warn("owner_setup.tools_need_review", "needs_review のツールを確定しなかった（持ち主の確認が要る）", {
      workspaceId: ctx.workspaceId,
      tools: needsReview,
    });
  }

  // 5
  let demoStore: OwnerSetupResult["demoStore"];
  try {
    const d = await deps.simClient.ensureDemoStore({ workspaceId: ctx.workspaceId, world: formation.world });
    demoStore = { executionId: d.execution.id, created: d.created };
  } catch (e) {
    throw new OwnerSetupError("demo_store", "sim-world のデモ店舗を作れなかった", { cause: e });
  }

  // 6・7
  const team = await deps.db
    .transaction(async (tx) => {
      await lockWorkspace(tx, ctx);
      const policyRow = await getLatestWorkspacePolicy(tx, ctx);
      if (!policyRow) throw new OwnerSetupError("agents", "ワークスペースのポリシーがない");
      const workspacePolicy = parseWorkspacePolicy(policyRow.policy);
      const catalog = catalogOf(await listConnectors(tx, ctx), await listConnectorTools(tx, ctx));
      const members: Array<{ m: DemoFormation["members"][number]; agentId: Uuid; agentName: string; jobId: Uuid; snapshotId: Uuid | null; isNew: boolean }> = [];
      for (const m of formation.members) {
        let agent = await findAgentByName(tx, ctx, m.agent.name);
        let isNew = false;
        if (!agent) {
          const definition = preparedAgentBudgetFor(kind, candidateRuleFor(kind, m, formation, catalog, now), workspacePolicy.budget.per_day_usd);
          const v = validateAgentDefinition(definition, { tools: catalog });
          if (!v.ok) throw new OwnerSetupError("agents", `担当「${m.agent.name}」の定義が通らない：${v.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
          const composed = composeAll({ ceilings: DEFAULT_CEILINGS, workspacePolicy, agent: v.definition });
          if (composed.violations.length > 0) {
            throw new OwnerSetupError("agents", `担当「${m.agent.name}」がポリシーより緩い：${composed.violations.map((x) => x.path).join(", ")}`);
          }
          const effectivePolicies = Object.fromEntries(
            Object.entries(composed.jobs).map(([slug, r]) => [slug, { policy: r.effective, hash: r.effectivePolicyHash }]),
          );
          const res = await insertAgentWithSnapshot(tx, ctx, {
            slug: newAgentSlug(deps.ids.newId()),
            name: m.agent.name,
            nameSource: "suggested",
            role: m.agent.role,
            status: "active",
            definition: v.definition as unknown as JsonObject,
            effectivePolicies,
            clamped: composed.clamped as unknown as Json[],
            ceilingsVersion: CEILINGS_VERSION,
            now,
          });
          agent = res.agent;
          isNew = true;
          created.agents.push(m.agent.name);
          await audit(tx, "agent.created", {
            agentId: agent.id,
            name: agent.name,
            snapshotId: res.snapshot.id,
            policyHashes: Object.fromEntries(Object.entries(effectivePolicies).map(([slug, e]) => [slug, e.hash])),
          });
        }
        const jobSpec = m.agent.jobs[0];
        if (!jobSpec) throw new OwnerSetupError("agents", `担当「${m.agent.name}」に仕事がない`);
        let job = await findAgentJob(tx, ctx, agent.id, jobSpec.id);
        if (!job) {
          // 既にある担当の定義（使う人が変えたかもしれない）は書き換えない
          if (!isNew) throw new OwnerSetupError("agents", `既にある担当「${m.agent.name}」に仕事 ${jobSpec.id} がない`);
          job = await insertAgentJob(tx, ctx, { agentId: agent.id, slug: jobSpec.id, kind: jobSpec.kind, template: jobSpec.template, status: "active", now });
          created.jobs.push(`${m.agent.name}/${jobSpec.id}`);
          await audit(tx, "job.created", { agentId: agent.id, jobId: job.id, slug: job.slug, template: job.template });
        }
        members.push({ m, agentId: agent.id, agentName: agent.name, jobId: job.id, snapshotId: agent.current_snapshot_id, isNew });
      }

      let ask = await findAskBySeedKey(tx, ctx, PREPARED_ASK_SEED_KEY);
      if (!ask) {
        const trigger = formation.ask.trigger;
        const formationJson: JsonObject = {
          shape: formation.ask.shape,
          members: members.map((x) => ({
            agentId: x.agentId,
            agentName: x.agentName,
            isNew: x.isNew,
            jobId: x.jobId,
            summary: x.m.summary,
            position: x.m.position,
            dependsOn: [...x.m.dependsOn],
          })),
        };
        ask = await insertAsk(tx, ctx, {
          createdBy: ownerUserId,
          text: formation.ask.text,
          shape: formation.ask.shape,
          status: "running",
          trigger: { type: trigger.type, cron: trigger.cron, timezone: trigger.timezone },
          nextRunAt: nextScheduledRun(trigger, now),
          formation: formationJson,
          seedKey: PREPARED_ASK_SEED_KEY,
          now,
        });
        for (const x of members) {
          await insertAskMember(tx, ctx, {
            askId: ask.id,
            agentId: x.agentId,
            jobId: x.jobId,
            position: x.m.position,
            dependsOn: x.m.dependsOn,
            isAggregator: false,
            isSpokesperson: x.m.isSpokesperson,
            isNew: x.isNew,
            summary: x.m.summary,
            now,
          });
        }
        created.ask = true;
        await audit(tx, "ask.created", { askId: ask.id, shape: formation.ask.shape, seedKey: PREPARED_ASK_SEED_KEY, agentIds: members.map((x) => x.agentId) });
      } else {
        const existing = await listAskMembers(tx, ctx, ask.id);
        if (existing.length !== members.length) deps.log.warn("owner_setup.ask_members_differ", "用意した依頼の担当の数が投入の定義と違う（そのままにする）", { askId: ask.id });
      }
      return { askId: ask.id, agents: members.map((x) => ({ name: x.agentName, agentId: x.agentId, jobId: x.jobId, snapshotId: x.snapshotId })) };
    })
    .catch((e: unknown) => {
      throw e instanceof OwnerSetupError ? e : new OwnerSetupError("agents", "担当・依頼を入れられなかった", { cause: e });
    });

  const result: OwnerSetupResult = {
    workspaceId: ctx.workspaceId,
    ownerUserId,
    created,
    connectors: toolCounts,
    needsReview,
    demoStore,
    agents: team.agents,
    askId: team.askId,
  };
  deps.log.info("owner_setup.done", "オーナーのワークスペースを確かめた", {
    workspaceId: ctx.workspaceId,
    created,
    needsReview,
    demoStoreCreated: demoStore.created,
  });
  return result;
}
