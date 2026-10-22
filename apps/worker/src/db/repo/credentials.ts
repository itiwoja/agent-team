// packages/db/src/repo/credentials.ts の WorkspaceDO 版。
// コネクタの資格情報（Google カレンダー・design 16 §3.3、ADR-040。GitHub・design 18 §3.3、D-119）の問い合わせ。
// - DO の中の行だけを扱う（workspace_id で絞る代わり）。見つからなければ null
// - refresh token の暗号文（refresh_token_enc）は gateway だけが読む。Postgres 版のロール（ot_app は SELECT できない）は
//   DO にはないので、画面に出す関数（getGoogleConnection・getGithubConnection）は暗号文の列を選ばないことで守る
// - 書いて整合が要る関数は db.transaction で包む。トランザクションの中で外部（Google・gateway）を呼ばない（G-14）

import { CODECS } from "../codecs.ts";
import { newId, one, run, type WsDb } from "../sqlite.ts";
import type { ConnectorCredentialRow, ConnectorRow, GithubConnection, GoogleConnection, OAuthProvider, Uuid } from "../types.ts";

const CONNECTOR_COLUMNS = "id, slug, display_name, kind, url, auth, enabled, last_synced_at, created_at, updated_at";
const CREDENTIAL_COLUMNS =
  "id, connector_id, provider, subject, email, scopes, refresh_token_enc, calendar_id, time_zone, " +
  "CAST(installation_id AS TEXT) AS installation_id, account_login, allow_protected_write, created_at, revoked_at";

/**
 * OAuth（Google・GitHub）のコネクタを作る・更新する（kind = mcp_remote、auth = {type:"oauth",provider}。provider の既定は google）。
 * 同じ slug が mcp_remote・同じ provider の oauth なら url・表示名を直して有効に戻す。別の種類なら例外（ほかのコネクタを上書きしない）
 */
export function upsertOAuthConnector(
  db: WsDb,
  c: { slug: string; displayName: string; url: string; now: Date; provider?: OAuthProvider },
): ConnectorRow {
  const provider = c.provider ?? "google";
  const auth = { type: "oauth", provider };
  return db.transaction(() => {
    const inserted = one<ConnectorRow>(
      db,
      CODECS.connectors,
      `INSERT INTO connectors (id, slug, display_name, kind, url, auth, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'mcp_remote', ?, ?, 1, ?, ?)
       ON CONFLICT (slug) DO NOTHING
       RETURNING ${CONNECTOR_COLUMNS}`,
      newId(),
      c.slug,
      c.displayName,
      c.url,
      auth,
      c.now,
      c.now,
    );
    if (inserted) return inserted;
    const existing = one<ConnectorRow>(db, CODECS.connectors, `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE slug = ?`, c.slug);
    if (!existing) throw new Error(`コネクタを読めなかった：${c.slug}`);
    if (existing.kind !== "mcp_remote" || existing.auth.type !== "oauth" || existing.auth.provider !== provider) {
      throw new Error(`同じ slug の OAuth のコネクタでないコネクタがある：${c.slug}`);
    }
    const row = one<ConnectorRow>(
      db,
      CODECS.connectors,
      `UPDATE connectors SET url = ?, display_name = ?, enabled = 1, updated_at = ? WHERE id = ? RETURNING ${CONNECTOR_COLUMNS}`,
      c.url,
      c.displayName,
      c.now,
      existing.id,
    );
    if (!row) throw new Error(`コネクタを更新できなかった：${c.slug}`);
    return row;
  });
}

/** 資格情報を入れる前の共通：コネクタがあること、同じコネクタの有効な行に revoked_at を立てる（再接続） */
function revokeActiveBeforeInsert(db: WsDb, connectorId: Uuid, now: Date): void {
  if (!one(db, {}, "SELECT 1 FROM connectors WHERE id = ?", connectorId)) throw new Error("コネクタがない");
  run(db, "UPDATE connector_credentials SET revoked_at = ? WHERE connector_id = ? AND revoked_at IS NULL", now, connectorId);
}

/**
 * Google の資格情報を入れる。同じコネクタの有効な行があれば先に revoked_at を立てる（再接続）。新しい行の id を返す
 */
export function insertGoogleCredential(
  db: WsDb,
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
): Uuid {
  return db.transaction(() => {
    revokeActiveBeforeInsert(db, c.connectorId, c.now);
    const row = one<{ id: Uuid }>(
      db,
      {},
      `INSERT INTO connector_credentials (id, connector_id, provider, subject, email, scopes, refresh_token_enc, calendar_id, time_zone, created_at)
       VALUES (?, ?, 'google', ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      newId(),
      c.connectorId,
      c.subject,
      c.email,
      [...c.scopes],
      c.refreshTokenEnc,
      c.calendarId,
      c.timeZone,
      c.now,
    );
    if (!row) throw new Error("資格情報の行を書けなかった");
    return row.id;
  });
}

/**
 * GitHub の資格情報を入れる（18 §3.3）。秘密は置かない：インストールの ID・つないだ人・許可だけ。
 * 同じコネクタの有効な行があれば先に revoked_at を立てる（再接続）。再接続では保護したブランチへの許可を引き継がない（既定の false に戻す）
 */
export function insertGithubCredential(
  db: WsDb,
  c: { connectorId: Uuid; subject: string; accountLogin: string; installationId: number; now: Date },
): Uuid {
  return db.transaction(() => {
    revokeActiveBeforeInsert(db, c.connectorId, c.now);
    const row = one<{ id: Uuid }>(
      db,
      {},
      `INSERT INTO connector_credentials (id, connector_id, provider, subject, scopes, installation_id, account_login, created_at)
       VALUES (?, ?, 'github', ?, '[]', ?, ?, ?)
       RETURNING id`,
      newId(),
      c.connectorId,
      c.subject,
      c.installationId,
      c.accountLogin,
      c.now,
    );
    if (!row) throw new Error("資格情報の行を書けなかった");
    return row.id;
  });
}

/** 画面に出す GitHub の接続（有効なコネクタと有効な資格情報がそろっているとき）。秘密の列は選ばない */
export function getGithubConnection(db: WsDb): GithubConnection | null {
  const row = one<{ id: Uuid; connector_id: Uuid; account_login: string; installation_id: string; allow_protected_write: boolean; created_at: Date }>(
    db,
    CODECS.connector_credentials,
    `SELECT cc.id, cc.connector_id, cc.account_login, CAST(cc.installation_id AS TEXT) AS installation_id, cc.allow_protected_write, cc.created_at
       FROM connector_credentials cc
       JOIN connectors c ON c.id = cc.connector_id
      WHERE cc.revoked_at IS NULL AND c.enabled = 1 AND cc.provider = 'github'
        AND c.kind = 'mcp_remote' AND json_extract(c.auth, '$.type') = 'oauth' AND json_extract(c.auth, '$.provider') = 'github'
      ORDER BY cc.created_at DESC
      LIMIT 1`,
  );
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
export function setGithubProtectedWrite(db: WsDb, credentialId: Uuid, allow: boolean): boolean {
  return (
    run(
      db,
      `UPDATE connector_credentials SET allow_protected_write = ?1
        WHERE id = ?2 AND provider = 'github' AND revoked_at IS NULL AND allow_protected_write <> ?1`,
      allow,
      credentialId,
    ) > 0
  );
}

/** コネクタの有効な資格情報（なければ null）。gateway が復号に使う（暗号文つき） */
export function getActiveCredential(db: WsDb, connectorId: Uuid): ConnectorCredentialRow | null {
  return one<ConnectorCredentialRow>(
    db,
    CODECS.connector_credentials,
    `SELECT ${CREDENTIAL_COLUMNS} FROM connector_credentials WHERE connector_id = ? AND revoked_at IS NULL`,
    connectorId,
  );
}

/**
 * 画面に出す Google の接続（有効なコネクタと有効な資格情報がそろっているとき）。秘密は読まない（refresh_token_enc は選ばない）
 */
export function getGoogleConnection(db: WsDb): GoogleConnection | null {
  const row = one<{ connector_id: Uuid; email: string; calendar_id: string; time_zone: string; created_at: Date }>(
    db,
    CODECS.connector_credentials,
    `SELECT cc.connector_id, cc.email, cc.calendar_id, cc.time_zone, cc.created_at
       FROM connector_credentials cc
       JOIN connectors c ON c.id = cc.connector_id
      WHERE cc.revoked_at IS NULL AND c.enabled = 1 AND cc.provider = 'google'
        AND c.kind = 'mcp_remote' AND json_extract(c.auth, '$.type') = 'oauth' AND json_extract(c.auth, '$.provider') = 'google'
      ORDER BY cc.created_at DESC
      LIMIT 1`,
  );
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
export function revokeCredential(db: WsDb, connectorId: Uuid, now: Date): boolean {
  return db.transaction(() => {
    const revoked = run(db, "UPDATE connector_credentials SET revoked_at = ? WHERE connector_id = ? AND revoked_at IS NULL", now, connectorId);
    run(db, "UPDATE connectors SET enabled = 0, updated_at = ? WHERE id = ?", now, connectorId);
    return revoked > 0;
  });
}

/** cleanup が作成した世代がまだ有効なときだけ取り消す（後続の再接続を巻き込まない） */
export function revokeCredentialIfActive(db: WsDb, connectorId: Uuid, credentialId: Uuid, now: Date): boolean {
  return db.transaction(() => {
    const revoked = run(
      db,
      "UPDATE connector_credentials SET revoked_at = ? WHERE connector_id = ? AND id = ? AND revoked_at IS NULL",
      now,
      connectorId,
      credentialId,
    );
    if (revoked > 0) run(db, "UPDATE connectors SET enabled = 0, updated_at = ? WHERE id = ?", now, connectorId);
    return revoked > 0;
  });
}
