// コネクタの資格情報（Google カレンダー・design 16 §3.3、ADR-040。GitHub・design 18 §3.3、D-119）の問い合わせ（@open-team/db/credentials）
// - 全部 WsCtx を受けて workspace_id で絞る（15:368）。見つからなければ null
// - refresh token の暗号文（refresh_token_enc）は gateway だけが読む。ot_app は SELECT できない（roles.sql）ので、
//   app が読む関数（getGoogleConnection）は暗号文の列を選ばない
// - 書く関数は Tx を受ける。トランザクションの中で外部（Google・gateway）を呼ばない（G-14）

import type { Queryable, Tx } from "../client.ts";
import type { ConnectorCredentialRow, ConnectorRow, GithubConnection, GoogleConnection, OAuthProvider, Uuid } from "../types.ts";
import type { WsCtx } from "../workspace.ts";

const CONNECTOR_COLUMNS = "id, workspace_id, slug, display_name, kind, url, auth, enabled, last_synced_at, created_at, updated_at";
const CREDENTIAL_COLUMNS =
  "id, workspace_id, connector_id, provider, subject, email, scopes, refresh_token_enc, calendar_id, time_zone, " +
  "installation_id::text AS installation_id, account_login, allow_protected_write, created_at, revoked_at";

/**
 * OAuth（Google・GitHub）のコネクタを作る・更新する（kind = mcp_remote、auth = {type:"oauth",provider}。provider の既定は google）。
 * 同じ slug が mcp_remote・同じ provider の oauth なら url・表示名を直して有効に戻す。別の種類なら例外（sim などを上書きしない）
 */
export async function upsertOAuthConnector(
  tx: Tx,
  ctx: WsCtx,
  c: { slug: string; displayName: string; url: string; now: Date; provider?: OAuthProvider },
): Promise<ConnectorRow> {
  const provider = c.provider ?? "google";
  const auth = { type: "oauth", provider };
  const inserted = await tx.query<ConnectorRow>(
    `INSERT INTO connectors (workspace_id, slug, display_name, kind, url, auth, enabled, created_at, updated_at)
     VALUES ($1, $2, $3, 'mcp_remote', $4, $5, true, $6, $6)
     ON CONFLICT (workspace_id, slug) DO NOTHING
     RETURNING ${CONNECTOR_COLUMNS}`,
    [ctx.workspaceId, c.slug, c.displayName, c.url, auth, c.now],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const existing = (
    await tx.query<ConnectorRow>(
      `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE workspace_id = $1 AND slug = $2 FOR UPDATE`,
      [ctx.workspaceId, c.slug],
    )
  ).rows[0];
  if (!existing) throw new Error(`コネクタを読めなかった：${c.slug}`);
  if (existing.kind !== "mcp_remote" || existing.auth.type !== "oauth" || existing.auth.provider !== provider) {
    throw new Error(`同じ slug の OAuth のコネクタでないコネクタがある：${c.slug}`);
  }
  const updated = await tx.query<ConnectorRow>(
    `UPDATE connectors SET url = $3, display_name = $4, enabled = true, updated_at = $5
      WHERE workspace_id = $1 AND id = $2
     RETURNING ${CONNECTOR_COLUMNS}`,
    [ctx.workspaceId, existing.id, c.url, c.displayName, c.now],
  );
  const row = updated.rows[0];
  if (!row) throw new Error(`コネクタを更新できなかった：${c.slug}`);
  return row;
}

/**
 * Google の資格情報を入れる。同じコネクタの有効な行があれば先に revoked_at を立てる（再接続）。
 * コネクタの行を FOR UPDATE で取ってから書く（同時の接続の取り合いを直列にする）。新しい行の id を返す
 */
export async function insertGoogleCredential(
  tx: Tx,
  ctx: WsCtx,
  c: {
    connectorId: Uuid;
    subject: string;
    email: string;
    scopes: readonly string[];
    refreshTokenEnc: string;
    calendarId: string;
    timeZone: string;
    now: Date;
  },
): Promise<Uuid> {
  const conn = await tx.query<{ id: Uuid }>("SELECT id FROM connectors WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [
    ctx.workspaceId,
    c.connectorId,
  ]);
  if (conn.rowCount === 0) throw new Error("コネクタがない（別のワークスペースのコネクタには資格情報を入れられない）");
  await tx.query(
    `UPDATE connector_credentials SET revoked_at = $3
      WHERE workspace_id = $1 AND connector_id = $2 AND revoked_at IS NULL`,
    [ctx.workspaceId, c.connectorId, c.now],
  );
  const r = await tx.query<{ id: Uuid }>(
    `INSERT INTO connector_credentials (workspace_id, connector_id, provider, subject, email, scopes, refresh_token_enc,
                                        calendar_id, time_zone, created_at)
     VALUES ($1, $2, 'google', $3, $4, $5::text[], $6, $7, $8, $9)
     RETURNING id`,
    [ctx.workspaceId, c.connectorId, c.subject, c.email, [...c.scopes], c.refreshTokenEnc, c.calendarId, c.timeZone, c.now],
  );
  const row = r.rows[0];
  if (!row) throw new Error("資格情報の行を書けなかった");
  return row.id;
}

/**
 * GitHub の資格情報を入れる（18 §3.3）。秘密は置かない：インストールの ID・つないだ人・許可だけ。
 * 同じコネクタの有効な行があれば先に revoked_at を立てる（再接続）。再接続では保護したブランチへの許可を引き継がない（既定の false に戻す）
 */
export async function insertGithubCredential(
  tx: Tx,
  ctx: WsCtx,
  c: { connectorId: Uuid; subject: string; accountLogin: string; installationId: number; now: Date },
): Promise<Uuid> {
  const conn = await tx.query<{ id: Uuid }>("SELECT id FROM connectors WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [
    ctx.workspaceId,
    c.connectorId,
  ]);
  if (conn.rowCount === 0) throw new Error("コネクタがない（別のワークスペースのコネクタには資格情報を入れられない）");
  await tx.query(
    `UPDATE connector_credentials SET revoked_at = $3
      WHERE workspace_id = $1 AND connector_id = $2 AND revoked_at IS NULL`,
    [ctx.workspaceId, c.connectorId, c.now],
  );
  const r = await tx.query<{ id: Uuid }>(
    `INSERT INTO connector_credentials (workspace_id, connector_id, provider, subject, scopes, installation_id, account_login, created_at)
     VALUES ($1, $2, 'github', $3, '{}'::text[], $4, $5, $6)
     RETURNING id`,
    [ctx.workspaceId, c.connectorId, c.subject, c.installationId, c.accountLogin, c.now],
  );
  const row = r.rows[0];
  if (!row) throw new Error("資格情報の行を書けなかった");
  return row.id;
}

/** 画面に出す GitHub の接続（有効なコネクタと有効な資格情報がそろっているとき）。ot_app の権限で読める列だけ */
export async function getGithubConnection(q: Queryable, ctx: WsCtx): Promise<GithubConnection | null> {
  const r = await q.query<{ id: Uuid; connector_id: Uuid; account_login: string; installation_id: string; allow_protected_write: boolean; created_at: Date }>(
    `SELECT cc.id, cc.connector_id, cc.account_login, cc.installation_id::text AS installation_id, cc.allow_protected_write, cc.created_at
       FROM connector_credentials cc
       JOIN connectors c ON c.workspace_id = cc.workspace_id AND c.id = cc.connector_id
      WHERE cc.workspace_id = $1 AND cc.revoked_at IS NULL AND c.enabled AND cc.provider = 'github'
        AND c.kind = 'mcp_remote' AND c.auth->>'type' = 'oauth' AND c.auth->>'provider' = 'github'
      ORDER BY cc.created_at DESC
      LIMIT 1`,
    [ctx.workspaceId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    connectorId: row.connector_id,
    credentialId: row.id,
    accountLogin: row.account_login,
    installationId: row.installation_id,
    allowProtectedWrite: row.allow_protected_write,
    createdAt: row.created_at,
  };
}

/**
 * 保護したブランチへの書き込みの許可を切り替える（18 §2-5）。有効な GitHub の資格情報の行だけ。
 * 変わったら true（同じ値なら false。呼び出し側は変わったときだけ監査ログを書く）
 */
export async function setGithubProtectedWrite(tx: Tx, ctx: WsCtx, credentialId: Uuid, allow: boolean): Promise<boolean> {
  const r = await tx.query(
    `UPDATE connector_credentials SET allow_protected_write = $3
      WHERE workspace_id = $1 AND id = $2 AND provider = 'github' AND revoked_at IS NULL AND allow_protected_write <> $3`,
    [ctx.workspaceId, credentialId, allow],
  );
  return r.rowCount > 0;
}

/** コネクタの有効な資格情報（なければ null）。gateway が復号に使う（暗号文つき） */
export async function getActiveCredential(q: Queryable, ctx: WsCtx, connectorId: Uuid): Promise<ConnectorCredentialRow | null> {
  const r = await q.query<ConnectorCredentialRow>(
    `SELECT ${CREDENTIAL_COLUMNS} FROM connector_credentials
      WHERE workspace_id = $1 AND connector_id = $2 AND revoked_at IS NULL`,
    [ctx.workspaceId, connectorId],
  );
  return r.rows[0] ?? null;
}

/**
 * 画面に出す Google の接続（有効なコネクタと有効な資格情報がそろっているとき）。秘密は読まない（refresh_token_enc は選ばない）。
 * ot_app の権限で読めるように、列は roles.sql で許した分だけ
 */
export async function getGoogleConnection(q: Queryable, ctx: WsCtx): Promise<GoogleConnection | null> {
  const r = await q.query<{ connector_id: Uuid; email: string; calendar_id: string; time_zone: string; created_at: Date }>(
    `SELECT cc.connector_id, cc.email, cc.calendar_id, cc.time_zone, cc.created_at
       FROM connector_credentials cc
       JOIN connectors c ON c.workspace_id = cc.workspace_id AND c.id = cc.connector_id
      WHERE cc.workspace_id = $1 AND cc.revoked_at IS NULL AND c.enabled AND cc.provider = 'google'
        AND c.kind = 'mcp_remote' AND c.auth->>'type' = 'oauth' AND c.auth->>'provider' = 'google'
      ORDER BY cc.created_at DESC
      LIMIT 1`,
    [ctx.workspaceId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    connectorId: row.connector_id,
    email: row.email,
    calendarId: row.calendar_id,
    timeZone: row.time_zone,
    createdAt: row.created_at,
  };
}

/**
 * 切断：有効な資格情報に revoked_at を立て、コネクタを無効にする。何か取り消したら true。
 * 呼び出し側が Google の revoke を先に（または後で）呼ぶ（トランザクションの外）
 */
export async function revokeCredential(tx: Tx, ctx: WsCtx, connectorId: Uuid, now: Date): Promise<boolean> {
  const revoked = await tx.query(
    `UPDATE connector_credentials SET revoked_at = $3
      WHERE workspace_id = $1 AND connector_id = $2 AND revoked_at IS NULL`,
    [ctx.workspaceId, connectorId, now],
  );
  await tx.query(
    `UPDATE connectors SET enabled = false, updated_at = $3 WHERE workspace_id = $1 AND id = $2`,
    [ctx.workspaceId, connectorId, now],
  );
  return revoked.rowCount > 0;
}

/** cleanup が作成した世代がまだ有効なときだけ取り消す（後続の再接続を巻き込まない） */
export async function revokeCredentialIfActive(tx: Tx, ctx: WsCtx, connectorId: Uuid, credentialId: Uuid, now: Date): Promise<boolean> {
  const revoked = await tx.query(
    `UPDATE connector_credentials SET revoked_at = $4
      WHERE workspace_id = $1 AND connector_id = $2 AND id = $3 AND revoked_at IS NULL`,
    [ctx.workspaceId, connectorId, credentialId, now],
  );
  if (revoked.rowCount > 0) {
    await tx.query("UPDATE connectors SET enabled = false, updated_at = $3 WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, connectorId, now]);
  }
  return revoked.rowCount > 0;
}
