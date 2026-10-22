// コネクタの資格情報の試験（packages/db/src/repo/credentials.test.ts の WorkspaceDO 版。design 16 §3.3、ADR-040、18 §3.3）。
// ワークスペースの分離・ot_app の列の権限の試験は落とした（DO そのものがワークスペースで、ロールはない）
import { describe, expect, it } from "vitest";
import { CODECS } from "../../src/db/codecs.ts";
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
} from "../../src/db/repo/credentials.ts";
import { getActiveCredentialId } from "../../src/db/repo/edge.ts";
import { isCheckViolation, isUniqueViolation, newId, one, run, type WsDb } from "../../src/db/sqlite.ts";
import type { Uuid } from "../../src/db/types.ts";
import { fxConnector, inWorkspace } from "./fixtures.ts";

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

function gcalConnector(db: WsDb): Uuid {
  return upsertOAuthConnector(db, { slug: "gcal", displayName: "Google カレンダー", url: GCAL_URL, now: NOW }).id;
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe("作る・取り消す・入れ直す", () => {
  it("OAuth のコネクタを作り、同じ slug は更新して有効に戻す。sim のコネクタの slug には作らない", async () => {
    await inWorkspace((db) => {
      fxConnector(db, { slug: "supplier" });
      const id = gcalConnector(db);
      const row = one<{ kind: string; auth: unknown; enabled: boolean; url: string }>(db, CODECS.connectors, "SELECT kind, auth, enabled, url FROM connectors WHERE id = ?", id);
      expect(row).toEqual({ kind: "mcp_remote", auth: { type: "oauth", provider: "google" }, enabled: true, url: GCAL_URL });

      // 切断したあとに同じ slug で作り直すと、同じ行が有効に戻る（url・表示名は新しい値に）
      run(db, "UPDATE connectors SET enabled = 0 WHERE id = ?", id);
      const again = upsertOAuthConnector(db, { slug: "gcal", displayName: "Google 予定", url: "https://gcal.test/mcp/gcal2", now: LATER });
      expect(again.id).toBe(id);
      expect(again.enabled).toBe(true);
      expect(again.display_name).toBe("Google 予定");
      expect(again.url).toBe("https://gcal.test/mcp/gcal2");
      expect(again.updated_at).toEqual(LATER);

      expect(() => upsertOAuthConnector(db, { slug: "supplier", displayName: "x", url: GCAL_URL, now: NOW })).toThrow(/OAuth のコネクタでない/);
    });
  });

  it("資格情報を入れ、取り消す。入れ直すと前の有効な行は revoked_at が立つ。有効な行は1コネクタに1つだけ", async () => {
    await inWorkspace((db) => {
      const id = gcalConnector(db);

      const first = insertGoogleCredential(db, credential(id, NOW));
      const active = getActiveCredential(db, id);
      expect(active?.id).toBe(first);
      expect(active?.refresh_token_enc).toBe("v1.aXZpdg.Y3Q");
      expect(active?.scopes).toHaveLength(4);
      expect(active?.revoked_at).toBeNull();
      expect(active?.allow_protected_write).toBe(false);

      // 直接の二重の有効な行は一意の索引で止まる
      const e = caught(() =>
        run(
          db,
          `INSERT INTO connector_credentials (id, connector_id, provider, subject, email, scopes, refresh_token_enc, calendar_id, time_zone)
           VALUES (?, ?, 'google', 's', 'e@x.test', '["openid"]', 'v1.a.b', 'c', 'Asia/Tokyo')`,
          newId(),
          id,
        ),
      );
      expect(isUniqueViolation(e, "connector_credentials.connector_id"), String(e)).toBe(true);

      // 再接続：前の行を止めてから新しい行を入れる
      const second = insertGoogleCredential(db, credential(id, LATER, { email: "new@example.test" }));
      expect(second).not.toBe(first);
      expect(getActiveCredential(db, id)?.id).toBe(second);
      expect(revokeCredentialIfActive(db, id, first, LATER)).toBe(false);
      expect(getActiveCredential(db, id)?.id).toBe(second);
      const old = one<{ revoked_at: Date | null }>(db, CODECS.connector_credentials, "SELECT revoked_at FROM connector_credentials WHERE id = ?", first);
      expect(old?.revoked_at).toEqual(LATER);

      // 取り消し：有効な行が止まり、コネクタは無効。2度目は何もしない（false）
      expect(revokeCredential(db, id, LATER)).toBe(true);
      expect(getActiveCredential(db, id)).toBeNull();
      expect(getGoogleConnection(db)).toBeNull();
      expect(one<{ enabled: boolean }>(db, CODECS.connectors, "SELECT enabled FROM connectors WHERE id = ?", id)?.enabled).toBe(false);
      expect(revokeCredential(db, id, LATER)).toBe(false);

      // 取り消したあとに入れ直せる（一意の索引は revoked_at の行を数えない）
      const third = insertGoogleCredential(db, credential(id, LATER));
      expect(getActiveCredential(db, id)?.id).toBe(third);
    });
  });

  it("revokeCredentialIfActive はその世代が有効なときだけ取り消してコネクタを無効にする", async () => {
    await inWorkspace((db) => {
      const id = gcalConnector(db);
      const cred = insertGoogleCredential(db, credential(id, NOW));
      expect(revokeCredentialIfActive(db, id, cred, LATER)).toBe(true);
      expect(getActiveCredential(db, id)).toBeNull();
      expect(one<{ enabled: boolean }>(db, CODECS.connectors, "SELECT enabled FROM connectors WHERE id = ?", id)?.enabled).toBe(false);
    });
  });

  it("ないコネクタには入れられない", async () => {
    await inWorkspace((db) => {
      expect(() => insertGoogleCredential(db, credential(newId(), NOW))).toThrow(/コネクタがない/);
    });
  });

  it("暗号文は v1. で始まる形だけ。形が違う行は CHECK で止まり、前の行の取り消しも戻る", async () => {
    await inWorkspace((db) => {
      const id = gcalConnector(db);
      const first = insertGoogleCredential(db, credential(id, NOW));
      const e = caught(() => insertGoogleCredential(db, credential(id, LATER, { refreshTokenEnc: "plain-token" })));
      expect(isCheckViolation(e, "connector_credentials_refresh_token_enc_check"), String(e)).toBe(true);
      expect(getActiveCredential(db, id)?.id).toBe(first);
    });
  });

  it("getGoogleConnection は秘密を含まない（refresh_token_enc のキーがない）", async () => {
    await inWorkspace((db) => {
      const id = gcalConnector(db);
      insertGoogleCredential(db, credential(id, NOW));
      const conn = getGoogleConnection(db);
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
});

describe("Intent の資格情報 pin", () => {
  it("有効な資格情報の ID だけを返し、再接続後は新しい ID を返す", async () => {
    await inWorkspace((db) => {
      const connectorId = gcalConnector(db);
      expect(getActiveCredentialId(db, connectorId)).toBeNull();
      insertGoogleCredential(db, credential(connectorId, NOW));
      const first = getActiveCredentialId(db, connectorId);
      expect(first).toBeTruthy();
      insertGoogleCredential(db, credential(connectorId, LATER));
      const second = getActiveCredentialId(db, connectorId);
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
    });
  });
});

describe("GitHub（18 §3.3、0019）", () => {
  const GITHUB_URL = "https://github-adapter.test/mcp/github";
  function githubConnector(db: WsDb): Uuid {
    return upsertOAuthConnector(db, { slug: "github", displayName: "GitHub", url: GITHUB_URL, now: NOW, provider: "github" }).id;
  }
  const gh = (connectorId: Uuid, now: Date) => ({ connectorId, subject: "583231", accountLogin: "octocat", installationId: 12345678901, now });

  it("コネクタは provider github。同じ slug の Google のコネクタは上書きしない", async () => {
    await inWorkspace((db) => {
      const id = githubConnector(db);
      expect(one<{ auth: unknown }>(db, CODECS.connectors, "SELECT auth FROM connectors WHERE id = ?", id)?.auth).toEqual({ type: "oauth", provider: "github" });
      expect(() => upsertOAuthConnector(db, { slug: "github", displayName: "x", url: GITHUB_URL, now: NOW })).toThrow(/OAuth のコネクタでない/);
    });
  });

  it("秘密を置かずに入れ、許可は既定で false。切り替え・再接続（許可は戻る）・画面の表示", async () => {
    await inWorkspace((db) => {
      const id = githubConnector(db);
      const credId = insertGithubCredential(db, gh(id, NOW));
      const cred = getActiveCredential(db, id);
      expect(cred).toMatchObject({ provider: "github", installation_id: "12345678901", account_login: "octocat", allow_protected_write: false, refresh_token_enc: null });
      expect(getGoogleConnection(db)).toBeNull();
      expect(getGithubConnection(db)).toEqual({
        connectorId: id,
        credentialId: credId,
        accountLogin: "octocat",
        installationId: "12345678901",
        allowProtectedWrite: false,
        createdAt: NOW,
      });

      expect(setGithubProtectedWrite(db, credId, true)).toBe(true);
      expect(setGithubProtectedWrite(db, credId, true)).toBe(false);
      expect(getGithubConnection(db)?.allowProtectedWrite).toBe(true);

      const credId2 = insertGithubCredential(db, gh(id, LATER));
      expect(credId2).not.toBe(credId);
      expect(getGithubConnection(db)?.allowProtectedWrite).toBe(false);
      // 取り消した行の許可は変えられない
      expect(setGithubProtectedWrite(db, credId, false)).toBe(false);
    });
  });

  it("provider ごとの必須の列（GitHub に暗号文・Google にインストールは入らない）", async () => {
    await inWorkspace((db) => {
      const id = githubConnector(db);
      const bad = [
        ["github", null, "v1.x.y", 1, "octocat"],
        ["github", null, null, null, "octocat"],
        ["google", "a@example.test", "v1.x.y", 1, null],
        ["gitlab", null, null, 1, "octocat"],
      ] as const;
      for (const [provider, email, enc, inst, login] of bad) {
        const e = caught(() =>
          run(
            db,
            `INSERT INTO connector_credentials (id, connector_id, provider, subject, email, scopes, refresh_token_enc, calendar_id, time_zone, installation_id, account_login)
             VALUES (?, ?, ?, 's', ?, '[]', ?, ?, ?, ?, ?)`,
            newId(),
            id,
            provider,
            email,
            enc,
            provider === "google" ? "cal" : null,
            provider === "google" ? "Asia/Tokyo" : null,
            inst,
            login,
          ),
        );
        expect(isCheckViolation(e), `${provider}: ${String(e)}`).toBe(true);
      }
    });
  });
});
