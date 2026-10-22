// ワークスペースの文脈（WsCtx）と、オーナーのワークスペースと利用者の作成（DB §4.1・4.3、SO §3.4）。ワークスペースはオーナーの1つだけ
// 業務の関数は WsCtx を受け取り、SQL を必ず workspace_id で絞る（15:368）。WsCtx はセッション・タスクのトークン・
// Intent の行から DB で引き直したものだけから作る（リクエストの workspace_id を信じない：15:486）

import { appendAuditLog } from "./audit.ts";
import { withTransaction, type Db, type Queryable, type Tx } from "./client.ts";
import type { Uuid, WorkspaceKind, WorkspaceRow } from "./types.ts";

/** すべての業務の問い合わせの文脈（DB §10）。userId は人の操作のときだけ（gateway・system の処理は null） */
export interface WsCtx {
  readonly workspaceId: Uuid;
  readonly kind: WorkspaceKind;
  readonly userId: Uuid | null;
}

/** DB から読んだワークスペースの行から文脈を作る */
export function wsCtxOf(ws: Pick<WorkspaceRow, "id" | "kind">, userId: Uuid | null = null): WsCtx {
  return { workspaceId: ws.id, kind: ws.kind, userId };
}

export const WORKSPACE_DEFAULTS = {
  /** 日次予算の区切り。オーナーも Asia/Tokyo（M-59、SO I-08） */
  timezone: "Asia/Tokyo",
  ownerMaxConcurrentTasks: 3,
  ownerLogin: "owner",
} as const;

const WORKSPACE_COLUMNS = `id, kind, status, kill_switch_engaged, kill_switch_engaged_at, kill_switch_engaged_by, kill_switch_reason,
  timezone, max_concurrent_tasks, audit_seq, audit_last_hash, last_seen_at, created_at, updated_at`;

/** 自分のワークスペースの行（なければ null） */
export async function getWorkspace(q: Queryable, ctx: WsCtx): Promise<WorkspaceRow | null> {
  const r = await q.query<WorkspaceRow>(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = $1`, [ctx.workspaceId]);
  return r.rows[0] ?? null;
}

/**
 * ワークスペースの行を FOR NO KEY UPDATE で取る（ロックの順はワークスペース → タスク → 承認 → Intent：M-21・SO §3.14）。
 * Kill Switch を読むのはこのあと（発動と直列になる）
 */
export async function lockWorkspace(tx: Tx, ctx: WsCtx): Promise<WorkspaceRow | null> {
  const r = await tx.query<WorkspaceRow>(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = $1 FOR NO KEY UPDATE`, [ctx.workspaceId]);
  return r.rows[0] ?? null;
}

/**
 * オーナーの利用者とワークスペースを（なければ）作る（D-05、G-08 の DB の部分）。冪等。
 * 作ったときは監査ログの起点 workspace.created（seq 1）を足す。ポリシー・コネクタ・エージェントの投入は app の担当
 */
export async function ensureOwnerWorkspace(
  q: Db | Tx,
  input: { now: Date; login?: string; name?: string | null },
): Promise<{ ctx: WsCtx & { userId: Uuid }; created: boolean }> {
  return withTransaction(q, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('ot.owner_init'))");
    const existing = await tx.query<{ id: Uuid; user_id: Uuid }>(
      `SELECT w.id, m.user_id FROM workspaces w
         JOIN memberships m ON m.workspace_id = w.id AND m.role = 'owner'
        WHERE w.kind = 'owner' ORDER BY m.created_at, m.id LIMIT 1`,
    );
    const found = existing.rows[0];
    if (found) return { ctx: { workspaceId: found.id, kind: "owner", userId: found.user_id }, created: false };

    const login = input.login ?? WORKSPACE_DEFAULTS.ownerLogin;
    const user = await tx.query<{ id: Uuid }>(
      `INSERT INTO users (login, name, created_at, updated_at) VALUES ($1, $2, $3, $3)
       ON CONFLICT (login) DO UPDATE SET updated_at = users.updated_at
       RETURNING id`,
      [login, input.name ?? null, input.now],
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error("オーナーの利用者を作れなかった");
    const ws = await tx.query<{ id: Uuid }>(
      `INSERT INTO workspaces (kind, max_concurrent_tasks, timezone, last_seen_at, created_at, updated_at)
       VALUES ('owner', $1, $2, $3, $3, $3) RETURNING id`,
      [WORKSPACE_DEFAULTS.ownerMaxConcurrentTasks, WORKSPACE_DEFAULTS.timezone, input.now],
    );
    const workspaceId = ws.rows[0]?.id;
    if (!workspaceId) throw new Error("オーナーのワークスペースを作れなかった");
    await tx.query("INSERT INTO memberships (workspace_id, user_id, role, created_at, updated_at) VALUES ($1, $2, 'owner', $3, $3)", [
      workspaceId,
      userId,
      input.now,
    ]);
    await appendAuditLog(tx, workspaceId, { eventType: "workspace.created", actorType: "system", actorId: "app", payload: { kind: "owner" } }, input.now);
    return { ctx: { workspaceId, kind: "owner", userId }, created: true };
  });
}
