// 仕事の材料（プロンプトに載せる要約・付与したツール）と走行の指紋（policyHash・toolHashes）を作る。
// launch.ts（起動）から切り出した：certify.ts（合格証の発行）が launch.ts → suite.ts → certify.ts の循環を作らずに使うため
// （launch.ts は互換のため再エクスポートする）

import type { EffectivePolicies, Hex64, SessionCtx, StageFingerprint, ToolHashEntry, Uuid } from "@open-team/db";
import { getAgentJobRow, getAgentRow, getAgentSnapshotRow, listConnectorToolsBySlugs } from "@open-team/db/edge";
import type { CaseSubject } from "@open-team/db/rehearsal";
import type { Queryable } from "@open-team/db";
import { grantedToolHashes } from "@open-team/edge";
import { AppError } from "@open-team/platform";
import type { JobBrief, RehearsalToolInfo } from "./common.ts";
import { resolveStages } from "./run.ts";

/**
 * 仕事の材料（プロンプトに載せる要約・付与したツール）と走行の行に残す指紋。
 * policyHash・toolHashes は仕事の走行（1段）のとき。stageFingerprints は段ごと（仕事は1件、依頼は担当の数）で、全段の指紋がそろったときだけ。
 */
export async function buildJobMaterials(
  deps: { db: Queryable },
  s: SessionCtx,
  subject: CaseSubject,
): Promise<{
  brief: JobBrief;
  effectivePolicies: EffectivePolicies | null;
  policyHash: string | null;
  toolHashes: ToolHashEntry[] | null;
  stageFingerprints: StageFingerprint[] | null;
}> {
  const ctx = s;
  const stages = await resolveStages(deps.db, ctx, subject);
  const lines: string[] = [];
  const grants = new Map<string, Set<string>>();
  let single: { policies: EffectivePolicies; slug: string } | null = null;
  const entries: StageEntry[] = [];
  let complete = true;
  for (const st of stages) {
    const [agent, job, snapshot] = await Promise.all([
      getAgentRow(deps.db, ctx, st.agentId),
      getAgentJobRow(deps.db, ctx, st.jobId),
      getAgentSnapshotRow(deps.db, ctx, st.agentSnapshotId),
    ]);
    if (agent === null || job === null) throw new AppError("NOT_FOUND");
    lines.push(`${agent.name}${agent.role ? `（${agent.role}）` : ""}：仕事 ${job.slug}（${job.kind}・${job.template}）`);
    const entry = snapshot?.effective_policies?.[job.slug];
    if (entry === undefined) {
      complete = false;
      continue;
    }
    entries.push({ jobId: st.jobId, policy: entry.policy, hash: entry.hash });
    if (stages.length === 1 && snapshot?.effective_policies) single = { policies: snapshot.effective_policies, slug: job.slug };
    for (const [slug, names] of Object.entries(entry.policy.mcp.grants)) {
      const set = grants.get(slug) ?? new Set<string>();
      for (const n of names) set.add(n);
      grants.set(slug, set);
    }
  }
  const hits = await listConnectorToolsBySlugs(deps.db, ctx, [...grants.keys()].sort());
  const tools: RehearsalToolInfo[] = hits
    .filter((h) => grants.get(h.connector.slug)?.has(h.tool.name))
    .map((h) => ({
      name: `${h.connector.slug}.${h.tool.name}`,
      description: h.tool.description,
      classification: h.tool.classification === "read" || h.tool.classification === "write" ? h.tool.classification : "unclassified",
      inputSchema: h.tool.input_schema,
    }));
  const brief: JobBrief = { summary: lines.join("\n"), tools };
  const stageFingerprints = complete && entries.length > 0 ? await fingerprintsOf(deps.db, ctx, entries) : null;
  if (single === null) return { brief, effectivePolicies: null, policyHash: null, toolHashes: null, stageFingerprints };
  const policy = single.policies[single.slug]!;
  const toolHashes = await grantedToolHashes(deps.db, ctx, policy.policy);
  return { brief, effectivePolicies: single.policies, policyHash: policy.hash, toolHashes, stageFingerprints };
}

/** 段の実効ポリシーと指紋（指紋の計算の入力） */
type StageEntry = { jobId: Uuid; policy: EffectivePolicies[string]["policy"]; hash: Hex64 };

/** 段ごとの指紋（ツールの指紋が引けない段があれば全体を null にする：合格証の材料にしない） */
async function fingerprintsOf(
  db: Queryable,
  ctx: SessionCtx,
  entries: readonly StageEntry[],
): Promise<StageFingerprint[] | null> {
  const out: StageFingerprint[] = [];
  for (const e of entries) {
    const toolHashes = await grantedToolHashes(db, ctx, e.policy);
    if (toolHashes === null) return null;
    out.push({ jobId: e.jobId, policyHash: e.hash, toolHashes });
  }
  return out;
}
