// 入口・セッション・CSRF・/me・ワークスペース（AS §6.1 の T-01〜T-24、SO §7.3・§7.5。DB は試験ごとに新しいもの）
import { fxWorkspace, useTestDb } from "@open-team/db/testing";
import { issueSession } from "@open-team/db";
import { describe, expect, it } from "vitest";
import { matchEntryToken } from "./entry.ts";
import { HOST, ORIGIN, OWNER_TOKEN, T0, makeTestApp, send, sessionCookieOf, signInOwner, type TestApp } from "./test-helpers.ts";

const T = useTestDb();
const DAY = 24 * 60 * 60 * 1000;

const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe("EP-01 入口", () => {
  it("T-01 オーナーのトークン → 200、next '/'、Cookie は HttpOnly・Secure・SameSite=Lax・Path=/・Max-Age=604800", async () => {
    const t = makeTestApp(T().db);
    const res = await send(t, "POST", "/api/v1/entry", { body: { token: OWNER_TOKEN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "signed_in", workspaceKind: "owner", next: "/" });
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/^ot_session=[A-Za-z0-9_-]{43};/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=604800"]) expect(sc).toContain(attr);
  });

  it("入ったらオーナーのワークスペースができ、監査ログの起点 workspace.created と entry_attempts(owner) が残る。2回目は同じワークスペース", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const b = await signInOwner(t);
    expect(b.workspaceId).toBe(a.workspaceId);
    expect(b.cookie).not.toBe(a.cookie);
    const ws = await db.query<{ n: number }>("SELECT count(*) AS n FROM workspaces WHERE kind = 'owner'");
    expect(ws.rows[0]?.n).toBe(1);
    const logs = await db.query<{ event_type: string }>("SELECT event_type FROM audit_logs WHERE workspace_id = $1 ORDER BY seq", [a.workspaceId]);
    expect(logs.rows.map((r) => r.event_type)).toEqual(["workspace.created"]);
    const attempts = await db.query<{ outcome: string; ip_hash: string }>("SELECT outcome, ip_hash FROM entry_attempts");
    expect(attempts.rows.map((r) => r.outcome)).toEqual(["owner", "owner"]);
    expect(attempts.rows[0]?.ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("T-04・SO-ENT-04 違うトークン → 401 UNAUTHORIZED、Cookie なし、entry_attempts(wrong_token)、ワークスペースは増えない", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const res = await send(t, "POST", "/api/v1/entry", { body: { token: "wrong" } });
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe("UNAUTHORIZED");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await db.query<{ n: number }>("SELECT count(*) AS n FROM workspaces")).rows[0]?.n).toBe(0);
    expect((await db.query<{ outcome: string }>("SELECT outcome FROM entry_attempts")).rows).toEqual([{ outcome: "wrong_token" }]);
  });

  it("トークンの値をログに出さない（違うトークン・正しいトークンとも）", async () => {
    const t = makeTestApp(T().db);
    await send(t, "POST", "/api/v1/entry", { body: { token: "a-wrong-token-value-that-is-long" } });
    await signInOwner(t);
    const dump = JSON.stringify(t.logs);
    expect(dump).not.toContain("a-wrong-token-value-that-is-long");
    expect(dump).not.toContain(OWNER_TOKEN);
  });

  it("T-05・SO-ENT-05 token = '' ／ 513文字 → 400 ／ 512文字の違う値 → 401", async () => {
    const t = makeTestApp(T().db);
    expect((await send(t, "POST", "/api/v1/entry", { body: { token: "" } })).status).toBe(400);
    expect((await send(t, "POST", "/api/v1/entry", { body: { token: "x".repeat(513) } })).status).toBe(400);
    expect((await send(t, "POST", "/api/v1/entry", { body: { token: "x".repeat(512) } })).status).toBe(401);
  });

  it("T-06 { token, shadow: true } → 400（知らないキー。BR-67①）。details に shadow", async () => {
    const t = makeTestApp(T().db);
    const res = await send(t, "POST", "/api/v1/entry", { body: { token: OWNER_TOKEN, shadow: true } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: Array<{ field: string }> } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toContainEqual({ field: "shadow", reason: "unrecognized_key" });
  });

  it("T-07・SO-ENT-06 クエリの ?token= だけで本文が空 → 400（URL から読まない）", async () => {
    const t = makeTestApp(T().db);
    const res = await send(t, "POST", `/api/v1/entry?token=${OWNER_TOKEN}`, { headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("JSON として読めない本文 → 400", async () => {
    const t = makeTestApp(T().db);
    expect((await send(t, "POST", "/api/v1/entry", { body: "{not json" })).status).toBe(400);
  });

  it("T-22 EP-01 は CSRF なしで通る（セッションがまだない）", async () => {
    const t = makeTestApp(T().db);
    expect((await send(t, "POST", "/api/v1/entry", { body: { token: OWNER_TOKEN } })).status).toBe(200);
  });

  it("SO-ENT-07 同じ IP の失敗が直近10分で5件目から 1・2・4秒…（最大10秒）待たせ、応答は 401 のまま（429 にしない）", async () => {
    const t = makeTestApp(T().db);
    for (let i = 0; i < 9; i++) {
      const res = await send(t, "POST", "/api/v1/entry", { body: { token: `wrong-${i}` } });
      expect(res.status).toBe(401);
    }
    expect(t.sleeps).toEqual([1000, 2000, 4000, 8000, 10000]);
  });

  it("SO-ENT-08 最初の失敗からちょうど10分後は、その失敗を数えない", async () => {
    const t = makeTestApp(T().db);
    for (let i = 0; i < 4; i++) await send(t, "POST", "/api/v1/entry", { body: { token: "wrong" } });
    t.clock.advance(10 * 60 * 1000);
    await send(t, "POST", "/api/v1/entry", { body: { token: "wrong" } });
    expect(t.sleeps).toEqual([]);
  });

  it("SO-ENT-10 有効な Cookie を持ったまま入り直す → 前のセッションは失効（同じ Cookie は signed_out）", async () => {
    const t = makeTestApp(T().db);
    const a = await signInOwner(t);
    const res = await send(t, "POST", "/api/v1/entry", { cookie: a.cookie, body: { token: OWNER_TOKEN } });
    expect(res.status).toBe(200);
    const fresh = sessionCookieOf(res);
    expect(fresh).not.toBe(a.cookie);
    expect(await (await send(t, "GET", "/api/v1/session", { cookie: a.cookie })).json()).toEqual({ state: "signed_out", localEntry: true });
    expect(((await (await send(t, "GET", "/api/v1/session", { cookie: fresh })).json()) as { state: string }).state).toBe("signed_in");
  });
});

describe("SO-ENT-12 トークンの照合", () => {
  it("一致しても・しなくても、比較を必ず1回行う", () => {
    for (const token of [OWNER_TOKEN, "wrong"]) {
      const calls: string[] = [];
      const r = matchEntryToken(token, OWNER_TOKEN, (a, b) => {
        calls.push(b);
        return a === b;
      });
      expect(calls).toEqual([OWNER_TOKEN]);
      expect(r).toBe(token === OWNER_TOKEN);
    }
  });

  it("設定されていないトークンも比べる（時間をそろえる）が、一致にはしない", () => {
    let n = 0;
    const r = matchEntryToken("\u0000open-team:unset-entry-token\u0000", undefined, (a, b) => {
      n++;
      return a === b;
    });
    expect(n).toBe(1);
    expect(r).toBe(false);
  });
});

describe("EP-02 セッション・ローリング", () => {
  it("Cookie なし → signed_out、有効 → signed_in と CSRF トークン（M-57）", async () => {
    const t = makeTestApp(T().db);
    expect(await (await send(t, "GET", "/api/v1/session")).json()).toEqual({ state: "signed_out", localEntry: true });
    const a = await signInOwner(t);
    const res = await send(t, "GET", "/api/v1/session", { cookie: a.cookie });
    expect(await res.json()).toEqual({ state: "signed_in", workspaceKind: "owner", csrfToken: a.csrf });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("無効な Cookie（1文字変えた）→ signed_out、応答で Cookie を消す（SO-SES-02）", async () => {
    const t = makeTestApp(T().db);
    const a = await signInOwner(t);
    const flipped = (a.cookie[0] === "A" ? "B" : "A") + a.cookie.slice(1);
    const res = await send(t, "GET", "/api/v1/session", { cookie: flipped });
    expect(await res.json()).toEqual({ state: "signed_out", localEntry: true });
    expect(res.headers.get("set-cookie")).toMatch(/ot_session=;.*Max-Age=0/);
  });

  it("T-19・SO-SES-03 59秒の間は更新しない（Set-Cookie なし）・60秒あけると last_seen_at・expires_at・workspaces.last_seen_at を延ばし Cookie を出し直す", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    t.clock.advance(59_000);
    const quiet = await send(t, "GET", "/api/v1/session", { cookie: a.cookie });
    expect(quiet.headers.get("set-cookie")).toBeNull();
    t.clock.advance(1_000);
    const rolled = await send(t, "GET", "/api/v1/session", { cookie: a.cookie });
    expect(rolled.headers.get("set-cookie")).toContain(`ot_session=${a.cookie}`);
    expect(rolled.headers.get("set-cookie")).toContain("Max-Age=604800");
    const s = await db.query<{ last_seen_at: Date; expires_at: Date }>("SELECT last_seen_at, expires_at FROM sessions WHERE revoked_at IS NULL");
    const at = new Date(T0.getTime() + 60_000);
    expect(s.rows[0]).toEqual({ last_seen_at: at, expires_at: new Date(at.getTime() + 7 * DAY) });
    const w = await db.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM workspaces WHERE id = $1", [a.workspaceId]);
    expect(w.rows[0]?.last_seen_at).toEqual(at);
  });

  it("T-18 最後のアクセスから 7日−1秒は有効、ちょうど7日は無効（401）", async () => {
    const t = makeTestApp(T().db);
    const a = await signInOwner(t);
    t.clock.advance(7 * DAY - 1000);
    expect((await send(t, "GET", "/api/v1/me", { cookie: a.cookie })).status).toBe(200);
    // いまのアクセスで延びたので、そこからちょうど7日
    t.clock.advance(7 * DAY);
    expect((await send(t, "GET", "/api/v1/me", { cookie: a.cookie })).status).toBe(401);
  });

  it("T-23・SO-SES-04 削除予約のワークスペースのセッション → 401", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const ws = await fxWorkspace(db, { kind: "guest", now: T0 });
    const s = await issueSession(db, { workspaceId: ws.workspaceId, userId: ws.userId, ipHash: null, userAgent: null, now: T0 });
    expect((await send(t, "GET", "/api/v1/me", { cookie: s.cookieValue })).status).toBe(200);
    await db.query("UPDATE workspaces SET delete_requested_at = $2 WHERE id = $1", [ws.workspaceId, T0]);
    expect((await send(t, "GET", "/api/v1/me", { cookie: s.cookieValue })).status).toBe(401);
  });
});

describe("EP-03 /me・EP-26 ワークスペース", () => {
  it("/me はセッションがなければ 401", async () => {
    const t = makeTestApp(T().db);
    const res = await send(t, "GET", "/api/v1/me");
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe("UNAUTHORIZED");
  });

  it("/me の形（オーナー：guest は null、ポリシーがなければ既定の per_day_usd 10、今日の費用は usage_records の合計）", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const body = (await (await send(t, "GET", "/api/v1/me", { cookie: a.cookie })).json()) as Record<string, unknown>;
    expect(body).toEqual({
      user: { id: a.userId, login: "owner", name: null },
      csrfToken: a.csrf,
      workspace: {
        id: a.workspaceId,
        kind: "owner",
        role: "owner",
        timezone: "Asia/Tokyo",
        maxConcurrentTasks: 3,
        killSwitch: { engaged: false, engagedAt: null, engagedBy: null, reason: null },
        guest: null,
        budget: { todayCostUsd: "0.000000", perDayUsd: "10.000000", remainingUsd: "10.000000" },
        seedVersion: null,
        google: { available: false, connected: false, email: null },
        github: { available: false, connected: false, login: null, allowProtectedWrite: false, settingsUrl: null },
      },
    });
  });

  it("T-24 ゲスト（作った直後）：guest.daysLeft = 7、ポリシーの per_day_usd 1 → perDayUsd '1.000000'、今日の費用を引いた残り", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const ws = await fxWorkspace(db, { kind: "guest", now: T0 });
    await db.query(
      `INSERT INTO workspace_policies (workspace_id, version, policy, policy_hash, created_at) VALUES ($1, 1, $2, $3, $4)`,
      [ws.workspaceId, { version: 1, budget: { per_task_usd: 0.5, per_day_usd: 1, max_steps: 40, max_minutes: 15 } }, "a".repeat(64), T0],
    );
    const agent = await db.query<{ id: string }>("INSERT INTO agents (workspace_id, slug, name) VALUES ($1, 'a-1', '係') RETURNING id", [ws.workspaceId]);
    await db.query(
      `INSERT INTO usage_records (workspace_id, agent_id, provider, model, phase, input_tokens, output_tokens, estimated_cost_usd, cost_usd, latency_ms, prompt_hash, created_at)
       VALUES ($1, $2, 'google', 'm', 'plan', 1, 1, 0.27, 0.27, 1, 'h', $3), ($1, $2, 'google', 'm', 'plan', 1, 1, 5, 5, 1, 'h', $4)`,
      [ws.workspaceId, agent.rows[0]?.id, T0, new Date(T0.getTime() - DAY)],
    );
    const s = await issueSession(db, { workspaceId: ws.workspaceId, userId: ws.userId, ipHash: null, userAgent: null, now: T0 });
    const me = (await (await send(t, "GET", "/api/v1/me", { cookie: s.cookieValue })).json()) as {
      workspace: { guest: { daysLeft: number; expiresAt: string }; budget: Record<string, string>; seedVersion: string };
    };
    expect(me.workspace.guest).toEqual({ daysLeft: 7, expiresAt: new Date(T0.getTime() + 7 * DAY).toISOString() });
    expect(me.workspace.budget).toEqual({ todayCostUsd: "0.270000", perDayUsd: "1.000000", remainingUsd: "0.730000" });
    expect(me.workspace.seedVersion).toBe("2026-10-12.1");
  });

  it("EP-26 自分のワークスペース → WorkspaceView、別のワークスペースの ID → 404、uuid の形でない → 400、セッションなし → 401", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const ok = await send(t, "GET", `/api/v1/workspaces/${a.workspaceId}`, { cookie: a.cookie });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { id: string }).id).toBe(a.workspaceId);
    const other = await fxWorkspace(db, { kind: "guest" });
    expect((await send(t, "GET", `/api/v1/workspaces/${other.workspaceId}`, { cookie: a.cookie })).status).toBe(404);
    expect((await send(t, "GET", `/api/v1/workspaces/${a.workspaceId.toUpperCase()}`, { cookie: a.cookie })).status).toBe(200);
    expect((await send(t, "GET", "/api/v1/workspaces/not-a-uuid", { cookie: a.cookie })).status).toBe(400);
    expect((await send(t, "GET", `/api/v1/workspaces/${a.workspaceId}`)).status).toBe(401);
  });
});

describe("EP-04 ログアウト・CSRF", () => {
  it("T-20 ログアウト（204・Cookie を消す）のあと同じ Cookie で /me → 401", async () => {
    const t = makeTestApp(T().db);
    const a = await signInOwner(t);
    const res = await send(t, "POST", "/api/v1/logout", { cookie: a.cookie, csrf: a.csrf, headers: { cookie: `ot_session=${a.cookie}; ot_gcal_state=stale` } });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toMatch(/ot_session=;.*Max-Age=0/);
    expect(res.headers.get("set-cookie")).toMatch(/ot_gcal_state=;/);
    expect((await send(t, "GET", "/api/v1/me", { cookie: a.cookie })).status).toBe(401);
  });

  it("T-21・SO-SES-05 X-CSRF-Token なし ／ 違う値 ／ 別のセッションの値 → 403 CSRF_TOKEN_INVALID、正しい値 → 通る", async () => {
    const t = makeTestApp(T().db);
    const a = await signInOwner(t);
    const b = await signInOwner(t);
    const none = await send(t, "POST", "/api/v1/logout", { cookie: a.cookie });
    expect(none.status).toBe(403);
    expect(await errCode(none)).toBe("CSRF_TOKEN_INVALID");
    expect((await send(t, "POST", "/api/v1/logout", { cookie: a.cookie, csrf: "x".repeat(43) })).status).toBe(403);
    expect((await send(t, "POST", "/api/v1/logout", { cookie: a.cookie, csrf: b.csrf })).status).toBe(403);
    expect((await send(t, "POST", "/api/v1/logout", { cookie: a.cookie, csrf: a.csrf })).status).toBe(204);
  });

  it("SO-SES-06 GET は CSRF なしで通る", async () => {
    const t = makeTestApp(T().db);
    const a = await signInOwner(t);
    expect((await send(t, "GET", "/api/v1/me", { cookie: a.cookie })).status).toBe(200);
  });

  it("セッションがないログアウト → 401（CSRF より先）", async () => {
    const t = makeTestApp(T().db);
    expect((await send(t, "POST", "/api/v1/logout", { body: {} })).status).toBe(401);
  });
});

describe("ローカルのトークンなしの入口（POST /entry/local）", () => {
  /** 接続の相手を決めて送る（@hono/node-server の getConnInfo は env.incoming.socket を読む） */
  const sendFrom = (t: TestApp, remoteAddress: string, headers: Record<string, string> = {}) =>
    t.app.request(
      `http://${HOST}/api/v1/entry/local`,
      { method: "POST", headers: { host: HOST, origin: ORIGIN, "content-type": "application/json", ...headers }, body: "{}" },
      { incoming: { socket: { remoteAddress, remotePort: 50000, remoteFamily: remoteAddress.includes(":") ? "IPv6" : "IPv4" } } },
    );

  it("このマシンから → オーナーで入れる（トークンなし）。同じワークスペースに入る", async () => {
    const t = makeTestApp(T().db);
    const owner = await signInOwner(t);
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const res = await sendFrom(t, addr);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ state: "signed_in", workspaceKind: "owner", next: "/" });
      const cookie = sessionCookieOf(res);
      const me = (await (await send(t, "GET", "/api/v1/me", { cookie })).json()) as { workspace: { id: string } };
      expect(me.workspace.id).toBe(owner.workspaceId);
    }
    expect(t.logs.filter((r) => r.event === "entry.owner" && r.via === "local")).toHaveLength(3);
  });

  it("LAN から・Vite 越しに LAN から（X-Forwarded-For）→ 403、接続の情報がない → 403", async () => {
    const t = makeTestApp(T().db);
    expect((await sendFrom(t, "192.168.1.20")).status).toBe(403);
    expect((await sendFrom(t, "127.0.0.1", { "x-forwarded-for": "192.168.1.20" })).status).toBe(403);
    expect((await sendFrom(t, "127.0.0.1", { "x-forwarded-for": "::ffff:127.0.0.1" })).status).toBe(200);
    expect((await send(t, "POST", "/api/v1/entry/local", { body: {} })).status).toBe(403);
  });

  it("/session は localEntry を返す", async () => {
    const t = makeTestApp(T().db);
    expect(await (await send(t, "GET", "/api/v1/session")).json()).toEqual({ state: "signed_out", localEntry: true });
  });
});
