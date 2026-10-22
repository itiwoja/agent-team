// コネクタの資格情報の試験（design 16 §3.3、ADR-040）：作る・取り消す・入れ直す、ワークスペースの分離、ot_app の列の権限、ワークスペースの削除での CASCADE
import { describe, expect, it } from "vitest";
import { isCheckViolation, isUniqueViolation, PG_ERROR, pgErrorInfo, type Db } from "../client.ts";
import { fxConnector, fxWorkspace, openRoleDb, useTestDb, type FxWorkspace } from "../testing.ts";
import type { Uuid } from "../types.ts";
import type { WsCtx } from "../workspace.ts";
import { getActiveCredentialId } from "./edge.ts";
import {
  getActiveCredential,
  getGithubConnection,
  getGoogleConnection,
  insertGithubCredential,
  insertGoogleCredential,
  revokeCredential,
  revokeCredentialIfActive,
  setGithubProtectedWrite,
  upsertOAuthConnector,
} from "./credentials.ts";

const T = useTestDb();
const NOW = new Date("2026-10-12T09:00:00.000Z");
const LATER = new Date("2026-10-12T10:00:00.000Z");
const GCAL_URL = "https://gcal.test/mcp/gcal";

/** Google の資格情報の入力（暗号文は形だけ "v1." で始まる文字列） */
function credential(connectorId: Uuid, now: Date, over: { email?: string; refreshTokenEnc?: string } = {}) {
  return {
    connectorId,
    subject: "sub-123",
    email: over.email ?? "owner@example.test",
    scopes: ["https://www.googleapis.com/auth/calendar.app.created", "https://www.googleapis.com/auth/calendar.freebusy", "openid", "email"],
    refreshTokenEnc: over.refreshTokenEnc ?? "v1.aXZpdg.Y3Q",
    calendarId: "makase@group.calendar.google.test",
    timeZone: "Asia/Tokyo",
    now,
  };
}

async function gcalConnector(db: Db, ws: FxWorkspace): Promise<Uuid> {
  const row = await db.transaction((tx) => upsertOAuthConnector(tx, ws.ctx, { slug: "gcal", displayName: "Google カレンダー", url: GCAL_URL, now: NOW }));
  return row.id;
}

async function expectDenied(p: Promise<unknown>): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(pgErrorInfo(e)?.code, String((e as Error | null)?.message)).toBe(PG_ERROR.insufficientPrivilege);
}

describe("作る・取り消す・入れ直す", () => {
  it("OAuth のコネクタを作り、同じ slug は更新して有効に戻す。sim のコネクタの slug には作らない", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    await fxConnector(db, ws, { slug: "supplier" });
    const id = await gcalConnector(db, ws);
    const row = (await db.query<{ kind: string; auth: unknown; enabled: boolean; url: string }>(
      "SELECT kind, auth, enabled, url FROM connectors WHERE id = $1",
      [id],
    )).rows[0];
    expect(row).toEqual({ kind: "mcp_remote", auth: { type: "oauth", provider: "google" }, enabled: true, url: GCAL_URL });

    // 切断したあとに同じ slug で作り直すと、同じ行が有効に戻る（url・表示名は新しい値に）
    await db.query("UPDATE connectors SET enabled = false WHERE id = $1", [id]);
    const again = await db.transaction((tx) =>
      upsertOAuthConnector(tx, ws.ctx, { slug: "gcal", displayName: "Google 予定", url: "https://gcal.test/mcp/gcal2", now: LATER }),
    );
    expect(again.id).toBe(id);
    expect(again.enabled).toBe(true);
    expect(again.display_name).toBe("Google 予定");
    expect(again.url).toBe("https://gcal.test/mcp/gcal2");

    await expect(db.transaction((tx) => upsertOAuthConnector(tx, ws.ctx, { slug: "supplier", displayName: "x", url: GCAL_URL, now: NOW }))).rejects.toThrow(
      /OAuth のコネクタでない/,
    );
  });

  it("資格情報を入れ、取り消す。入れ直すと前の有効な行は revoked_at が立つ。有効な行は1コネクタに1つだけ", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const id = await gcalConnector(db, ws);

    const first = await db.transaction((tx) => insertGoogleCredential(tx, ws.ctx, credential(id, NOW)));
    const active = await getActiveCredential(db, ws.ctx, id);
    expect(active?.id).toBe(first);
    expect(active?.refresh_token_enc).toBe("v1.aXZpdg.Y3Q");
    expect(active?.scopes).toHaveLength(4);
    expect(active?.revoked_at).toBeNull();

    // 直接の二重の有効な行は一意の索引で止まる
    await expectUnique(db.query(
      `INSERT INTO connector_credentials (workspace_id, connector_id, provider, subject, email, scopes, refresh_token_enc, calendar_id, time_zone)
       VALUES ($1, $2, 'google', 's', 'e@x.test', '{openid}', 'v1.a.b', 'c', 'Asia/Tokyo')`,
      [ws.workspaceId, id],
    ));

    // 再接続：前の行を止めてから新しい行を入れる
    const second = await db.transaction((tx) => insertGoogleCredential(tx, ws.ctx, credential(id, LATER, { email: "new@example.test" })));
    expect(second).not.toBe(first);
    expect((await getActiveCredential(db, ws.ctx, id))?.id).toBe(second);
    expect(await db.transaction((tx) => revokeCredentialIfActive(tx, ws.ctx, id, first, LATER))).toBe(false);
    expect((await getActiveCredential(db, ws.ctx, id))?.id).toBe(second);
    const old = (await db.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM connector_credentials WHERE id = $1", [first])).rows[0];
    expect(old?.revoked_at?.toISOString()).toBe(LATER.toISOString());

    // 取り消し：有効な行が止まり、コネクタは無効。2度目は何もしない（false）
    expect(await db.transaction((tx) => revokeCredential(tx, ws.ctx, id, LATER))).toBe(true);
    expect(await getActiveCredential(db, ws.ctx, id)).toBeNull();
    expect(await getGoogleConnection(db, ws.ctx)).toBeNull();
    expect((await db.query<{ enabled: boolean }>("SELECT enabled FROM connectors WHERE id = $1", [id])).rows[0]?.enabled).toBe(false);
    expect(await db.transaction((tx) => revokeCredential(tx, ws.ctx, id, LATER))).toBe(false);

    // 取り消したあとに入れ直せる（一意の索引は revoked_at の行を数えない）
    const third = await db.transaction((tx) => insertGoogleCredential(tx, ws.ctx, credential(id, LATER)));
    expect((await getActiveCredential(db, ws.ctx, id))?.id).toBe(third);
  });

  it("暗号文は v1. で始まる形だけ。形が違う行は CHECK で止まる", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const id = await gcalConnector(db, ws);
    const e = await db
      .transaction((tx) => insertGoogleCredential(tx, ws.ctx, credential(id, NOW, { refreshTokenEnc: "plain-token" })))
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(isCheckViolation(e, "connector_credentials_refresh_token_enc_check")).toBe(true);
  });

  it("getGoogleConnection は秘密を含まない（refresh_token_enc のキーがない）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const id = await gcalConnector(db, ws);
    await db.transaction((tx) => insertGoogleCredential(tx, ws.ctx, credential(id, NOW)));
    const conn = await getGoogleConnection(db, ws.ctx);
    expect(conn).toEqual({
      connectorId: id,
      email: "owner@example.test",
      calendarId: "makase@group.calendar.google.test",
      timeZone: "Asia/Tokyo",
      createdAt: NOW,
    });
    expect(Object.keys(conn ?? {})).not.toContain("refresh_token_enc");
  });
});

describe("ワークスペースの分離", () => {
  it("B のワークスペースからは A の資格情報が見えず、動かせず、A のコネクタに書けない", async () => {
    const { db } = T();
    const a = await fxWorkspace(db);
    const b = await fxWorkspace(db, { second: true });
    const idA = await gcalConnector(db, a);
    await db.transaction((tx) => insertGoogleCredential(tx, a.ctx, credential(idA, NOW)));
    const bCtx: WsCtx = b.ctx;

    expect(await getActiveCredential(db, bCtx, idA)).toBeNull();
    expect(await getGoogleConnection(db, bCtx)).toBeNull();
    expect(await db.transaction((tx) => revokeCredential(tx, bCtx, idA, LATER))).toBe(false);
    expect(await getActiveCredential(db, a.ctx, idA)).not.toBeNull();
    await expect(db.transaction((tx) => insertGoogleCredential(tx, bCtx, credential(idA, LATER)))).rejects.toThrow(/コネクタがない/);
    // 同じ slug でも B の中では別のコネクタになる
    const idB = await gcalConnector(db, b);
    expect(idB).not.toBe(idA);
  });
});

describe("ot_app の権限（refresh_token_enc は読めない）", () => {
  it("app は書いて取り消せ、暗号文以外の列は読める。暗号文の列と他の列の更新は止まる", async () => {
    const { db, url } = T();
    const ws = await fxWorkspace(db);
    const id = await gcalConnector(db, ws);
    const app = await openRoleDb(url, "ot_app");
    try {
      await app.transaction((tx) => insertGoogleCredential(tx, ws.ctx, credential(id, NOW)));
      expect((await getGoogleConnection(app, ws.ctx))?.email).toBe("owner@example.test");
      await expectDenied(app.query("SELECT refresh_token_enc FROM connector_credentials WHERE workspace_id = $1", [ws.workspaceId]));
      await expectDenied(app.query("SELECT * FROM connector_credentials WHERE workspace_id = $1", [ws.workspaceId]));
      await expectDenied(app.query("UPDATE connector_credentials SET email = 'x@example.test' WHERE workspace_id = $1", [ws.workspaceId]));
      const rows = await app.query<{ email: string; calendar_id: string; revoked_at: Date | null }>(
        "SELECT email, calendar_id, revoked_at FROM connector_credentials WHERE workspace_id = $1",
        [ws.workspaceId],
      );
      expect(rows.rows).toHaveLength(1);
      expect((await app.query<{ id: Uuid }>(
        "SELECT id FROM connector_credentials WHERE workspace_id = $1 AND connector_id = $2 AND revoked_at IS NULL", [ws.workspaceId, id],
      )).rows).toHaveLength(1);
      expect(await app.transaction((tx) => revokeCredential(tx, ws.ctx, id, LATER))).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("Intent の資格情報 pin", () => {
  it("workspace 内の有効な資格情報の ID だけを返し、再接続後は新しい ID を返す", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const connectorId = await gcalConnector(db, ws);
    await db.transaction((tx) => insertGoogleCredential(tx, ws.ctx, credential(connectorId, NOW)));
    const first = await getActiveCredentialId(db, ws.ctx, connectorId);
    expect(first).toBeTruthy();
    await db.transaction((tx) => insertGoogleCredential(tx, ws.ctx, credential(connectorId, LATER)));
    const second = await getActiveCredentialId(db, ws.ctx, connectorId);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(await getActiveCredentialId(db, { ...ws.ctx, workspaceId: "00000000-0000-4000-8000-000000000000" as Uuid }, connectorId)).toBeNull();
  });
});

async function expectUnique(p: Promise<unknown>): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(isUniqueViolation(e, "connector_credentials_active_uq"), String((e as Error | null)?.message)).toBe(true);
}

describe("GitHub（18 §3.3、0019）", () => {
  const GITHUB_URL = "https://github-adapter.test/mcp/github";
  async function githubConnector(db: Db, ws: FxWorkspace): Promise<Uuid> {
    const row = await db.transaction((tx) => upsertOAuthConnector(tx, ws.ctx, { slug: "github", displayName: "GitHub", url: GITHUB_URL, now: NOW, provider: "github" }));
    return row.id;
  }
  const gh = (connectorId: Uuid, now: Date) => ({ connectorId, subject: "583231", accountLogin: "octocat", installationId: 12345678901, now });

  it("コネクタは provider github。同じ slug の Google のコネクタは上書きしない", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const id = await githubConnector(db, ws);
    const row = (await db.query<{ auth: unknown }>("SELECT auth FROM connectors WHERE id = $1", [id])).rows[0];
    expect(row?.auth).toEqual({ type: "oauth", provider: "github" });
    await expect(
      db.transaction((tx) => upsertOAuthConnector(tx, ws.ctx, { slug: "github", displayName: "x", url: GITHUB_URL, now: NOW })),
    ).rejects.toThrow(/OAuth のコネクタでない/);
  });

  it("秘密を置かずに入れ、許可は既定で false。切り替え・再接続（許可は戻る）・画面の表示", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const id = await githubConnector(db, ws);
    const credId = await db.transaction((tx) => insertGithubCredential(tx, ws.ctx, gh(id, NOW)));
    const cred = await getActiveCredential(db, ws.ctx, id);
    expect(cred).toMatchObject({ provider: "github", installation_id: "12345678901", account_login: "octocat", allow_protected_write: false, refresh_token_enc: null });
    expect(await getGoogleConnection(db, ws.ctx)).toBeNull();
    expect(await getGithubConnection(db, ws.ctx)).toEqual({
      connectorId: id,
      credentialId: credId,
      accountLogin: "octocat",
      installationId: "12345678901",
      allowProtectedWrite: false,
      createdAt: NOW,
    });

    expect(await db.transaction((tx) => setGithubProtectedWrite(tx, ws.ctx, credId, true))).toBe(true);
    expect(await db.transaction((tx) => setGithubProtectedWrite(tx, ws.ctx, credId, true))).toBe(false);
    expect((await getGithubConnection(db, ws.ctx))?.allowProtectedWrite).toBe(true);

    const credId2 = await db.transaction((tx) => insertGithubCredential(tx, ws.ctx, gh(id, LATER)));
    expect(credId2).not.toBe(credId);
    expect((await getGithubConnection(db, ws.ctx))?.allowProtectedWrite).toBe(false);
    // 取り消した行の許可は変えられない
    expect(await db.transaction((tx) => setGithubProtectedWrite(tx, ws.ctx, credId, false))).toBe(false);
  });

  it("provider ごとの必須の列（GitHub に暗号文・Google にインストールは入らない）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const id = await githubConnector(db, ws);
    const bad = [
      ["github", null, "v1.x.y", 1, "octocat"],
      ["github", null, null, null, "octocat"],
      ["google", "a@example.test", "v1.x.y", 1, null],
      ["gitlab", null, null, 1, "octocat"],
    ] as const;
    for (const [provider, email, enc, inst, login] of bad) {
      const e = await db
        .query(
          `INSERT INTO connector_credentials (workspace_id, connector_id, provider, subject, email, scopes, refresh_token_enc, calendar_id, time_zone, installation_id, account_login)
           VALUES ($1, $2, $3, 's', $4, '{}', $5, $6, $7, $8, $9)`,
          [ws.workspaceId, id, provider, email, enc, provider === "google" ? "cal" : null, provider === "google" ? "Asia/Tokyo" : null, inst, login],
        )
        .then(() => null, (x: unknown) => x);
      expect(isCheckViolation(e), `${provider}`).toBe(true);
    }
  });

  it("ot_app は許可だけを切り替えられ、ほかの列（インストールの ID など）は書き換えられない", async () => {
    const { db, url } = T();
    const ws = await fxWorkspace(db);
    const id = await githubConnector(db, ws);
    const app = await openRoleDb(url, "ot_app");
    try {
      const credId = await app.transaction((tx) => insertGithubCredential(tx, ws.ctx, gh(id, NOW)));
      expect(await app.transaction((tx) => setGithubProtectedWrite(tx, ws.ctx, credId, true))).toBe(true);
      expect((await getGithubConnection(app, ws.ctx))?.allowProtectedWrite).toBe(true);
      await expectDenied(app.query("UPDATE connector_credentials SET installation_id = 1 WHERE workspace_id = $1", [ws.workspaceId]));
      await expectDenied(app.query("UPDATE connector_credentials SET account_login = 'x' WHERE workspace_id = $1", [ws.workspaceId]));
    } finally {
      await app.close();
    }
  });

  it("別のワークスペースからは見えず、許可も切り替えられない", async () => {
    const { db } = T();
    const a = await fxWorkspace(db);
    const b = await fxWorkspace(db, { second: true });
    const id = await githubConnector(db, a);
    const credId = await db.transaction((tx) => insertGithubCredential(tx, a.ctx, gh(id, NOW)));
    expect(await getGithubConnection(db, b.ctx)).toBeNull();
    expect(await db.transaction((tx) => setGithubProtectedWrite(tx, b.ctx, credId, true))).toBe(false);
    expect((await getGithubConnection(db, a.ctx))?.allowProtectedWrite).toBe(false);
  });
});
