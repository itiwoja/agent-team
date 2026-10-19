// ワークスペースの文脈（WsCtx）と、オーナー・ゲストのワークスペースと利用者の作成（DB §4.1・4.3、SO §3.4・3.5）
// 業務の関数は WsCtx を受け取り、SQL を必ず workspace_id で絞る（15:368）。WsCtx はセッション・タスクのトークン・
// Intent の行から DB で引き直したものだけから作る（リクエストの workspace_id を信じない：15:486）

import { randomBytes } from "node:crypto";
import { appendAuditLog } from "./audit.ts";
import { withTransaction, type Db, type Queryable, type Tx } from "./client.ts";
import { countEntryAttempts, recordEntryAttempt } from "./system/entry.ts";
import { countActiveGuestWorkspaces } from "./system/guests.ts";
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
  guestMaxConcurrentTasks: 2,
  ownerLogin: "owner",
} as const;

/** ゲストの作成の上限（BR-65。15:231） */
export const GUEST_LIMITS = {
  /** 同時に存在するゲスト（削除予約を除く） */
  activeMax: 50,
  /** 同じ IP から直近60分に作れる数 */
  createsPerIpPerWindow: 5,
  ipWindowMs: 60 * 60 * 1000,
} as const;

const WORKSPACE_COLUMNS = `id, kind, status, kill_switch_engaged, kill_switch_engaged_at, kill_switch_engaged_by, kill_switch_reason,
  timezone, max_concurrent_tasks, audit_seq, audit_last_hash, last_seen_at, delete_requested_at, seed_version, created_at, updated_at`;

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

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** ゲストの login：'guest-' ＋ base32 小文字8文字（DB I-04） */
export function newGuestLogin(): string {
  const bytes = randomBytes(8);
  let s = "";
  for (const b of bytes) s += BASE32[b & 31];
  return `guest-${s}`;
}

export type GuestCreateResult =
  | { ok: true; ctx: WsCtx & { userId: Uuid }; login: string }
  /** global：同時50件（BR-65）。ip：同じ IP から1時間に5件 */
  | { ok: false; scope: "global" | "ip" };

/**
 * ゲストの利用者・ワークスペース・所属（owner：SO I-05）を作る（DB §4.3 の4、SO §3.5 の1〜6 のうち DB の部分）。
 * 1. アドバイザリロックで作成を全体で直列にする（同時の作成で50件を超えない：T-46）
 * 2. 削除予約でないゲストが50件以上 → entry_attempts('capacity') を残して { ok: false, scope: 'global' }
 * 3. guest_created のときだけ、同じ IP の直近60分（created_at > now − 1h）の guest_created が5件以上 → 'ip_limit'
 *    （[最初からやり直す] の guest_reset は IP の数に入れない：DB §4.3）
 * 4. 作ったら監査ログの起点 workspace.created（{ kind: 'guest', seedVersion }、seq 1）と entry_attempts(outcome) を足す
 * ok: false でもトランザクションはコミットする（入口の試行を残す）。シード・セッションは呼び出し側が同じトランザクションで足す。
 * 監査ログはこの1件だけ（シードの投入では書かない：15:350）
 */
export async function createGuestWorkspace(
  tx: Tx,
  input: { ipHash: string; now: Date; seedVersion: string; outcome: "guest_created" | "guest_reset"; timezone?: string },
): Promise<GuestCreateResult> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('ot.guest_create'))");
  const active = await countActiveGuestWorkspaces(tx);
  if (active >= GUEST_LIMITS.activeMax) {
    await recordEntryAttempt(tx, { ipHash: input.ipHash, outcome: "capacity", workspaceId: null, now: input.now });
    return { ok: false, scope: "global" };
  }
  if (input.outcome === "guest_created") {
    const recent = await countEntryAttempts(tx, {
      ipHash: input.ipHash,
      outcomes: ["guest_created"],
      since: new Date(input.now.getTime() - GUEST_LIMITS.ipWindowMs),
    });
    if (recent >= GUEST_LIMITS.createsPerIpPerWindow) {
      await recordEntryAttempt(tx, { ipHash: input.ipHash, outcome: "ip_limit", workspaceId: null, now: input.now });
      return { ok: false, scope: "ip" };
    }
  }

  let userId: Uuid | null = null;
  let login = "";
  for (let attempt = 0; attempt < 5 && !userId; attempt++) {
    // 衝突したら作り直す（ON CONFLICT で例外にしない。トランザクションを壊さないため）
    login = newGuestLogin();
    const r = await tx.query<{ id: Uuid }>(
      "INSERT INTO users (login, created_at, updated_at) VALUES ($1, $2, $2) ON CONFLICT (login) DO NOTHING RETURNING id",
      [login, input.now],
    );
    userId = r.rows[0]?.id ?? null;
  }
  if (!userId) throw new Error("ゲストの login が5回続けて重なった");

  const ws = await tx.query<{ id: Uuid }>(
    `INSERT INTO workspaces (kind, max_concurrent_tasks, timezone, seed_version, last_seen_at, created_at, updated_at)
     VALUES ('guest', $1, $2, $3, $4, $4, $4) RETURNING id`,
    [WORKSPACE_DEFAULTS.guestMaxConcurrentTasks, input.timezone ?? WORKSPACE_DEFAULTS.timezone, input.seedVersion, input.now],
  );
  const workspaceId = ws.rows[0]?.id;
  if (!workspaceId) throw new Error("ゲストのワークスペースを作れなかった");
  await tx.query("INSERT INTO memberships (workspace_id, user_id, role, created_at, updated_at) VALUES ($1, $2, 'owner', $3, $3)", [
    workspaceId,
    userId,
    input.now,
  ]);
  await appendAuditLog(
    tx,
    workspaceId,
    { eventType: "workspace.created", actorType: "system", actorId: "app", payload: { kind: "guest", seedVersion: input.seedVersion } },
    input.now,
  );
  await recordEntryAttempt(tx, { ipHash: input.ipHash, outcome: input.outcome, workspaceId, now: input.now });
  return { ok: true, ctx: { workspaceId, kind: "guest", userId }, login };
}

/**
 * ゲストのワークスペースを削除予約にし、セッションをすべて失効させる（[最初からやり直す]・ゲストのログアウト・sim-world の
 * 初期化の失敗：DB §4.3、SO §3.6・3.7）。オーナーは予約できない（false）。走っているタスクの停止（Kill Switch）は app が同じ
 * トランザクションで行う。実際の削除は掃除（system.cleanupGuestWorkspaces）
 */
export async function requestWorkspaceDeletion(tx: Tx, ctx: WsCtx, now: Date): Promise<boolean> {
  const r = await tx.query(
    `UPDATE workspaces SET delete_requested_at = COALESCE(delete_requested_at, $2), updated_at = $2
      WHERE id = $1 AND kind = 'guest'`,
    [ctx.workspaceId, now],
  );
  if (r.rowCount === 0) return false;
  await tx.query("UPDATE sessions SET revoked_at = $2 WHERE workspace_id = $1 AND revoked_at IS NULL", [ctx.workspaceId, now]);
  return true;
}
