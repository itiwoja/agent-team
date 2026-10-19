// 試験の対象の仕事に付与された Web の許可ドメイン（grants.web.allow_domains の実効値）と、付与されたコネクタの slug（mcp.grants のうち、ツールが1つ以上あるもの）。
// 生成・解釈の文脈（F-14 の出し方・F-15〜F-17 とカレンダーの道具の出し方）に使う。
// 担当が複数（依頼）のときは、どれかの担当の仕事に付与があれば、その和集合を使う。

import type { Queryable, WsCtx } from "@open-team/db";
import { getAgentJobRow, getAgentSnapshotRow } from "@open-team/db/edge";
import type { CaseSubject } from "@open-team/db/rehearsal";
import { resolveStages } from "./stages.ts";

export const WEB_POLICIES = Symbol("rehearsal web policies");
export type WebAllowDomains = string[] & { [WEB_POLICIES]?: Array<{ allow: readonly string[]; deny: readonly string[] }> };

/** 試験の対象の仕事の付与（Web の許可ドメインと、付与されたコネクタの slug。どちらも昇順・重複なし） */
export interface RehearsalGrants {
  webAllowDomains: WebAllowDomains;
  connectorSlugs: string[];
}

export async function rehearsalGrantsOf(db: Queryable, ctx: WsCtx, subject: CaseSubject): Promise<RehearsalGrants> {
  const stages = await resolveStages(db, ctx, subject);
  const domains = new Set<string>();
  const slugs = new Set<string>();
  const policies: Array<{ allow: readonly string[]; deny: readonly string[] }> = [];
  for (const st of stages) {
    const [job, snapshot] = await Promise.all([getAgentJobRow(db, ctx, st.jobId), getAgentSnapshotRow(db, ctx, st.agentSnapshotId)]);
    if (job === null) continue;
    const entry = snapshot?.effective_policies?.[job.slug];
    const allow = entry?.policy.web.allow_domains ?? [];
    const deny = entry?.policy.web.deny_domains ?? [];
    for (const d of allow) domains.add(d);
    if (allow.length > 0) policies.push({ allow, deny });
    for (const [slug, names] of Object.entries(entry?.policy.mcp.grants ?? {})) {
      if (names.length > 0) slugs.add(slug);
    }
  }
  const webAllowDomains = [...domains].sort() as WebAllowDomains;
  Object.defineProperty(webAllowDomains, WEB_POLICIES, { value: policies });
  return { webAllowDomains, connectorSlugs: [...slugs].sort() };
}

/** Web の許可ドメインだけ（rehearsalGrantsOf の webAllowDomains） */
export async function webAllowDomainsOf(db: Queryable, ctx: WsCtx, subject: CaseSubject): Promise<WebAllowDomains> {
  return (await rehearsalGrantsOf(db, ctx, subject)).webAllowDomains;
}
