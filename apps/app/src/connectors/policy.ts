// ワークスペースのポリシーの版（workspace_policies）に、コネクタを有効・無効にする新しい版を足す（16 §3.6）
// 決めたこと：
// - ポリシーの行は更新できない（forbid_update）。変えるときは version を1つ上げて行を足す（ot_app は INSERT できる）
// - 既存の承認の仕組みは、ポリシーの版を広げるときの承認を持たない（widen の確認はエージェントの定義だけ）。
//   Google の同意画面での許可を承認とみなし、監査ログに残す（呼び出し側が reason と consentedBy を渡す）
// - 外す（切断）は狭める変更なので同意は要らない
// - 入れる・外すが同じ内容なら何もしない（changed: false。版も監査も増やさない）
// - 版の中の policy.version は 1 のまま（WorkspacePolicy の型）。行の version が版番号

import type { JsonObject, Tx, Uuid, WsCtx } from "@open-team/db";
import { getLatestWorkspacePolicy } from "@open-team/db/app";
import { hashCanonical, parseWorkspacePolicy, type WorkspacePolicy } from "@open-team/kernel";

export interface SetConnectorEnabledInput {
  slug: string;
  enabled: boolean;
  /** 変えた人（同意した人・切断した人） */
  userId: Uuid;
  now: Date;
}

export interface PolicyChange {
  changed: boolean;
  version: number;
  policyHash: string;
}

/** 呼び出し側のトランザクションの中で呼ぶ（ワークスペースの行を取ってから版を採番する） */
export async function setConnectorEnabledInPolicy(tx: Tx, ctx: WsCtx, input: SetConnectorEnabledInput): Promise<PolicyChange> {
  const latest = await getLatestWorkspacePolicy(tx, ctx);
  if (!latest) throw new Error("ワークスペースのポリシーがない");
  const current = parseWorkspacePolicy(latest.policy);
  const has = current.connectors.enabled.includes(input.slug);
  if (has === input.enabled) return { changed: false, version: latest.version, policyHash: latest.policy_hash };

  const enabled = input.enabled
    ? [...current.connectors.enabled, input.slug].sort()
    : current.connectors.enabled.filter((c) => c !== input.slug);
  const next: WorkspacePolicy = { ...current, connectors: { enabled: [...new Set(enabled)] } };
  const version = latest.version + 1;
  const policyHash = hashCanonical(next);
  await tx.query(
    `INSERT INTO workspace_policies (workspace_id, version, policy, policy_hash, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ctx.workspaceId, version, next as unknown as JsonObject, policyHash, input.userId, input.now],
  );
  return { changed: true, version, policyHash };
}
