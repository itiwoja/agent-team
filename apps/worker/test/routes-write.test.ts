// 画面の API（/api/v1/*）の書き込みの経路：POST /asks・/asks/:id/answer（routes/ → WorkspaceDO の RPC）。
// ログインしたセッションは D1 に直接作り（ensureUser・issueSession）、DO の中の行は fixtures で入れて読む
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/auth/routes.ts";
import { ensureUser, issueSession } from "../src/auth/session.ts";
import { all, count, newId, run } from "../src/db/sqlite.ts";
import { createApp } from "../src/index.ts";
import { AskAcceptedResponseSchema, ListAsksResponseSchema } from "../src/views/asks/contract.ts";
import { fxAgent, fxAsk, fxUsage, inNamedWorkspace, type FxWorkspace } from "./db/fixtures.ts";

const NOW = new Date("2026-10-22T09:00:00.000Z");
const ORIGIN = "https://makase.test";

const app = createApp({
  fetch: () => {
    throw new Error("外へは呼ばない");
  },
  now: () => NOW,
});

interface Signed {
  cookie: string;
  csrfToken: string;
  ws: FxWorkspace;
}

async function signIn(label: string): Promise<Signed> {
  const u = await ensureUser(env.DB, { sub: `sub-${label}-${newId()}`, email: `${label}@example.com`, name: null }, NOW);
  await env.WORKSPACE.get(env.WORKSPACE.idFromName(u.workspaceId)).init(u.workspaceId, u.userId);
  const s = await issueSession(env.DB, { userId: u.userId, workspaceId: u.workspaceId, now: NOW });
  return { cookie: `${SESSION_COOKIE}=${s.cookieValue}`, csrfToken: s.csrfToken, ws: { workspaceId: u.workspaceId, userId: u.userId } };
}

function post(path: string, who: Signed | undefined, body: unknown, o: { csrf?: boolean; key?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who !== undefined) {
    headers.cookie = who.cookie;
    if (o.csrf !== false) headers["x-csrf-token"] = who.csrfToken;
  }
  if (o.key !== undefined) headers["idempotency-key"] = o.key;
  return Promise.resolve(app.request(`${ORIGIN}/api/v1${path}`, { method: "POST", headers, body: JSON.stringify(body) }, env));
}

function get(path: string, who: Signed): Promise<Response> {
  return Promise.resolve(app.request(`${ORIGIN}/api/v1${path}`, { headers: { cookie: who.cookie } }, env));
}

async function errorOf(res: Response): Promise<{ code: string; details?: unknown }> {
  return ((await res.json()) as { error: { code: string; details?: unknown } }).error;
}

describe("POST /asks", () => {
  it("依頼を generating で作り、一覧に出る。監査ログと事象 ask.created も残る", async () => {
    const who = await signIn("ask-create");
    const res = await post("/asks", who, { text: "来週の会議の資料をまとめて" });
    expect(res.status).toBe(201);
    const body = AskAcceptedResponseSchema.parse(await res.json());
    expect(body.ask).toMatchObject({ text: "来週の会議の資料をまとめて", status: "generating", shape: null });

    const list = ListAsksResponseSchema.parse(await (await get("/asks", who)).json());
    expect(list.asks.map((a) => a.id)).toEqual([body.ask.id]);

    await inNamedWorkspace(who.ws, (db) => {
      expect(count(db, "SELECT count(*) FROM audit_logs WHERE event_type = 'ask.created'")).toBe(1);
      const events = all<{ type: string; data: string }>(db, {}, "SELECT type, data FROM workspace_events WHERE type = 'ask.created'");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.data)).toMatchObject({ askId: body.ask.id, status: "generating" });
    });
  });

  it("担当の指定は名前（@ 付きも）で引く。知らない担当・入っていないパックは 400", async () => {
    const who = await signIn("ask-mention");
    await inNamedWorkspace(who.ws, (db) => void fxAgent(db, { name: "仕入れ係" }));
    expect((await post("/asks", who, { text: "発注して", mention: "@仕入れ係" })).status).toBe(201);

    const unknown = await post("/asks", who, { text: "発注して", mention: "経理係" });
    expect(unknown.status).toBe(400);
    expect(await errorOf(unknown)).toMatchObject({ code: "VALIDATION_ERROR", details: [{ field: "mention" }] });

    const pack = await post("/asks", who, { text: "発注して", packId: "retail" });
    expect(pack.status).toBe(400);
    expect(await errorOf(pack)).toMatchObject({ code: "VALIDATION_ERROR", details: [{ field: "packId" }] });
  });

  it("セッションがなければ 401、CSRF がなければ 403、本文が外れていれば 400、JSON でなければ 415", async () => {
    const who = await signIn("ask-guard");
    expect((await post("/asks", undefined, { text: "x" })).status).toBe(401);
    expect((await post("/asks", who, { text: "x" }, { csrf: false })).status).toBe(403);
    expect((await post("/asks", who, { text: "" })).status).toBe(400);
    expect((await post("/asks", who, { text: "x", extra: 1 })).status).toBe(400);
    const res = await app.request(
      `${ORIGIN}/api/v1/asks`,
      { method: "POST", headers: { cookie: who.cookie, "x-csrf-token": who.csrfToken, "content-type": "text/plain" }, body: "x" },
      env,
    );
    expect(res.status).toBe(415);
  });

  it("同じ Idempotency-Key は同じ応答を返し、依頼は1つだけ。違う本文に使うと 400", async () => {
    const who = await signIn("ask-idem");
    const key = newId();
    const a = await post("/asks", who, { text: "在庫を見て" }, { key });
    const b = await post("/asks", who, { text: "在庫を見て" }, { key });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await b.json()).toEqual(await a.json());
    const list = ListAsksResponseSchema.parse(await (await get("/asks", who)).json());
    expect(list.asks).toHaveLength(1);

    const other = await post("/asks", who, { text: "別の依頼" }, { key });
    expect(other.status).toBe(400);
    expect(await errorOf(other)).toMatchObject({ details: [{ field: "Idempotency-Key", reason: "reused_for_different_request" }] });

    expect((await post("/asks", who, { text: "在庫を見て" }, { key: "not-a-uuid" })).status).toBe(400);
  });

  it("今日の費用が上限に届いていれば 429 と Retry-After", async () => {
    const who = await signIn("ask-budget");
    await inNamedWorkspace(who.ws, (db, ws) => {
      const { askId } = fxAsk(db, ws, { status: "done" });
      fxUsage(db, { askId, phase: "planner", costMicroUsd: 15_000_000, createdAt: NOW });
    });
    const res = await post("/asks", who, { text: "在庫を見て" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
    expect(await errorOf(res)).toMatchObject({ code: "DAILY_BUDGET_EXCEEDED", details: { scope: "global" } });
  });
});

describe("POST /asks/:id/answer", () => {
  it("生成中の質問に選択肢で答える。答えたあと・質問がない依頼は 409、知らない選択肢は 400", async () => {
    const who = await signIn("ask-answer");
    const askId = await inNamedWorkspace(who.ws, (db, ws) => {
      const { askId } = fxAsk(db, ws, { status: "generating" });
      const q = { text: "どの店の在庫ですか", choices: [{ id: "c1", label: "本店" }, { id: "c2", label: "駅前店" }], allowFreeText: false };
      run(db, "UPDATE asks SET question = ? WHERE id = ?", q, askId);
      return askId;
    });
    expect((await post(`/asks/${askId}/answer`, who, { choiceId: "zz" })).status).toBe(400);
    expect((await post(`/asks/${askId}/answer`, who, { text: "本店" })).status).toBe(400);

    const ok = await post(`/asks/${askId}/answer`, who, { choiceId: "c2" });
    expect(ok.status).toBe(200);
    expect(AskAcceptedResponseSchema.parse(await ok.json()).ask.question).toBeNull();
    await inNamedWorkspace(who.ws, (db) => {
      expect(all<{ question_answer: string }>(db, {}, "SELECT question_answer FROM asks WHERE id = ?", askId)[0]?.question_answer).toBe("駅前店");
    });

    const again = await post(`/asks/${askId}/answer`, who, { choiceId: "c1" });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("ASK_NOT_WAITING");
    expect((await post(`/asks/${newId()}/answer`, who, { choiceId: "c1" })).status).toBe(404);
  });
});
