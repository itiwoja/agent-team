// パックを入れる（POST /packs/{packId}/install。D-116）。1つのトランザクションで：
// 担当を作る（最初の境界から：BR-74 と同じ。依頼から作る担当と同じ initialAgentDefinition ＋ パックの仕事）→ スキルを付ける →
// 作業場に置くファイルを最初の控え（tar.gz）にする → 入れた記録（pack_installs）と監査ログ。
// 権限は広げない：Web の付与はオーナーの最初の境界のまま、コネクタの付与はなし（要るものは依頼のときに設定プランナーが決める）

import { appendAuditLog, lockWorkspace, type PackInstallRow, type SessionCtx, type Uuid } from "@open-team/db";
import { findAgentByName, getLatestWorkspacePolicy, insertAgentJob, insertAgentWithSnapshot, listConnectors, listConnectorTools } from "@open-team/db/app";
import { insertAgentSkill, insertPackInstall, insertWorkspaceSnapshot, listPackInstalls } from "@open-team/db/sandbox";
import { CEILINGS_VERSION, EMPTY_TAINT, FORMATION_LIMITS, initialAgentDefinition, parseWorkspacePolicy, type AgentDefinitionInput, type Json, type JsonObject } from "@open-team/kernel";
import { AppError } from "@open-team/platform";
import { createTarGz } from "@open-team/sandbox";
import type { AppDeps } from "../deps.ts";
import { withJob } from "../asks/create.ts";
import { AskPlanError } from "../asks/planner.ts";
import { catalogOf } from "../owner-setup.ts";
import { findPack, PACK_CATEGORIES, packNeedsSandbox, PACKS, type PackDefinition } from "./catalog.ts";
import type { PackView, ListPacksResponse, InstallPackResponse } from "./contract.ts";

const shortId = (id: string): string => id.replace(/-/g, "").slice(0, 8).toLowerCase();

/**
 * 入れた記録（pack_installs）から、パックの担当の並び（pack.agents）と同じ順の担当の id を引く。
 * 入れていない・版が違う（担当の並びが変わったかもしれない）・agent_ids が足りないところは null
 */
export function packAgentIdsOf(p: PackDefinition, install: Pick<PackInstallRow, "pack_version" | "agent_ids"> | undefined): Array<Uuid | null> {
  if (install === undefined || install.pack_version !== p.version) return p.agents.map(() => null);
  return p.agents.map((_, i) => install.agent_ids[i] ?? null);
}

/** 棚に出す形（パックの中身と、入れたかどうか）。agentIds は pack.agents と同じ順（packAgentIdsOf。省略・足りないところは null） */
export function packView(p: PackDefinition, o: { installedAt: Date | null; sandboxAvailable: boolean; agentIds?: ReadonlyArray<Uuid | null> }): PackView {
  const skillOf = new Map(p.skills.map((s) => [s.name, s]));
  return {
    id: p.id,
    version: p.version,
    name: p.name,
    tagline: p.tagline,
    description: p.description,
    audience: p.audience,
    category: p.category,
    agents: p.agents.map((a, i) => ({
      agentId: o.agentIds?.[i] ?? null,
      name: a.name,
      summary: a.summary,
      template: a.template,
      skills: a.skills.filter((n) => skillOf.has(n)),
      files: (a.files ?? []).map((f) => f.path),
    })),
    skills: p.skills.map((s) => ({ name: s.name, description: s.description })),
    examples: [...p.examples],
    needsSandbox: packNeedsSandbox(p),
    sandboxAvailable: o.sandboxAvailable,
    installedAt: o.installedAt?.toISOString() ?? null,
  };
}

/** 作業場を使えるワークスペースか（作業場のプロバイダーがあり、オーナーのワークスペース：edge の sandboxAllowed と同じ考え） */
export function sandboxAvailableFor(deps: Pick<AppDeps, "sandbox">, s: Pick<SessionCtx, "kind">): boolean {
  return deps.sandbox !== null && s.kind === "owner";
}

export async function listPacks(deps: Pick<AppDeps, "db" | "sandbox">, s: SessionCtx): Promise<ListPacksResponse> {
  const installs = await listPackInstalls(deps.db, s);
  const byPack = new Map(installs.map((i) => [i.pack_id, i]));
  const sandboxAvailable = sandboxAvailableFor(deps, s);
  return {
    categories: [...PACK_CATEGORIES],
    packs: PACKS.map((p) => {
      const install = byPack.get(p.id);
      return packView(p, { installedAt: install?.created_at ?? null, sandboxAvailable, agentIds: packAgentIdsOf(p, install) });
    }),
  };
}

export async function installPack(deps: Pick<AppDeps, "db" | "clock" | "ids" | "sandbox">, s: SessionCtx, packId: string): Promise<InstallPackResponse> {
  const pack = findPack(packId);
  if (pack === undefined) throw new AppError("NOT_FOUND");
  const [connectorRows, toolRows, policyRow] = await Promise.all([listConnectors(deps.db, s), listConnectorTools(deps.db, s), getLatestWorkspacePolicy(deps.db, s)]);
  if (policyRow === null) throw new AppError("INTERNAL_ERROR", "ワークスペースのポリシーがない");
  const policy = parseWorkspacePolicy(policyRow.policy);
  const m = { policy, catalog: catalogOf(connectorRows, toolRows) };

  const created = await deps.db.transaction(async (tx) => {
    const now = deps.clock.now();
    const ws = await lockWorkspace(tx, s);
    if (ws === null) throw new AppError("NOT_FOUND");
    if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");
    if ((await listPackInstalls(tx, s)).some((i) => i.pack_id === pack.id)) throw new AppError("PACK_ALREADY_INSTALLED");
    const living = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM agents WHERE workspace_id = $1 AND status IN ('active','idle')", [s.workspaceId]);
    if ((living.rows[0]?.n ?? 0) + pack.agents.length > FORMATION_LIMITS.maxAgentsPerWorkspace) {
      throw new AppError("AGENT_LIMIT_REACHED", undefined, { details: { limit: FORMATION_LIMITS.maxAgentsPerWorkspace } });
    }

    const agents: Array<{ id: Uuid; name: string }> = [];
    for (const a of pack.agents) {
      let name = a.name;
      for (let n = 2; (await findAgentByName(tx, s, name)) !== null; n += 1) name = `${a.name}${n}`;
      const initial = initialAgentDefinition({ name, role: a.role, workspacePolicy: policy, workspaceKind: s.kind });
      const base: AgentDefinitionInput = {
        ...(initial as unknown as AgentDefinitionInput),
        grants: { ...(initial.grants.web === undefined ? {} : { web: initial.grants.web }), connectors: {} },
      };
      const slug = `pack-${a.key}`;
      let built: ReturnType<typeof withJob>;
      try {
        built = withJob(base, { slug, kind: "once", template: a.template, instructions: a.instructions }, m, name);
      } catch (e: unknown) {
        if (e instanceof AskPlanError) throw new AppError("AGENT_SCHEMA_INVALID", e.message, { cause: e });
        throw e;
      }
      const res = await insertAgentWithSnapshot(tx, s, {
        slug: `a-${shortId(deps.ids.newId())}`,
        name,
        nameSource: "suggested",
        role: a.role,
        status: "active",
        definition: built.definition as unknown as JsonObject,
        effectivePolicies: built.effectivePolicies,
        clamped: built.composed.clamped as unknown as Json[],
        ceilingsVersion: CEILINGS_VERSION,
        now,
      });
      const job = await insertAgentJob(tx, s, { agentId: res.agent.id, slug, kind: "once", template: a.template, status: "active", now });
      for (const skillName of a.skills) {
        const skill = pack.skills.find((x) => x.name === skillName);
        if (skill !== undefined) await insertAgentSkill(tx, s, { agentId: res.agent.id, name: skill.name, description: skill.description, body: skill.body, packId: pack.id, now });
      }
      if (a.files !== undefined && a.files.length > 0) {
        const files = a.files.map((f) => ({ path: f.path, content: Buffer.from(f.content, "utf8"), ...(f.executable ? { executable: true } : {}) }));
        await insertWorkspaceSnapshot(tx, s, {
          agentId: res.agent.id,
          taskId: null,
          source: "pack",
          archive: createTarGz(files),
          files: files.length,
          bytes: files.reduce((n, f) => n + f.content.length, 0),
          // パックが置いた控えは汚染なし（運営のパックの定数：SG-05）
          taint: EMPTY_TAINT,
          now,
        });
      }
      await appendAuditLog(
        tx,
        s.workspaceId,
        {
          eventType: "agent.created",
          actorType: "user",
          actorId: s.userId,
          payload: {
            agentId: res.agent.id,
            name,
            snapshotId: res.snapshot.id,
            origin: "pack",
            packId: pack.id,
            jobId: job.id,
            template: a.template,
            skills: a.skills,
            policyHashes: Object.fromEntries(Object.entries(built.effectivePolicies).map(([slug2, e]) => [slug2, e.hash])),
          },
        },
        now,
      );
      agents.push({ id: res.agent.id, name });
    }
    const install = await insertPackInstall(tx, s, { packId: pack.id, version: pack.version, userId: s.userId, agentIds: agents.map((x) => x.id), now });
    if (install === null) throw new AppError("PACK_ALREADY_INSTALLED");
    await appendAuditLog(tx, s.workspaceId, { eventType: "pack.installed", actorType: "user", actorId: s.userId, payload: { packId: pack.id, version: pack.version, agentIds: agents.map((x) => x.id) } }, now);
    return { agents, install };
  });
  return {
    pack: packView(pack, { installedAt: created.install.created_at, sandboxAvailable: sandboxAvailableFor(deps, s), agentIds: packAgentIdsOf(pack, created.install) }),
    agents: created.agents.map((a) => ({ agentId: a.id, name: a.name })),
  };
}
