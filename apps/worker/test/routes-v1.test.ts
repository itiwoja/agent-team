// 画面の API（/api/v1/*）の読む経路：GET /agents・/asks・/asks/:id・/asks/:id/messages（routes/ → WorkspaceDO の RPC → views/）。
// ログインしたセッションは D1 に直接作り（ensureUser・issueSession）、そのワークスペースの DO（名前で引く）に fixtures で行を入れる
import { env } from "cloudflare:workers";
import { errorHandler } from "@open-team/platform";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, sessionMiddleware, type AppEnv } from "../src/auth/routes.ts";
import { ensureUser, issueSession } from "../src/auth/session.ts";
import { newId, run } from "../src/db/sqlite.ts";
import { createApp } from "../src/index.ts";
import { apiRouter } from "../src/routes/router.ts";
import { AgentLibraryResponseSchema } from "../src/views/agents/contract.ts";
import { AskDetailResponseSchema, ListAskMessagesResponseSchema, ListAsksResponseSchema } from "../src/views/asks/contract.ts";
import {
  fxAgent,
  fxApproval,
  fxAsk,
  fxAskMember,
  fxAskRun,
  fxConnector,
  fxHash,
  fxIntent,
  fxTask,
  fxUsage,
  inNamedWorkspace,
  type FxWorkspace,
} from "./db/fixtures.ts";

const NOW = new Date("2026-10-22T09:00:00.000Z");
const ORIGIN = "https://makase.test";
const MISSING = "00000000-0000-4000-8000-0000000000ff";

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

/** Google のログインの後と同じ状態（利用者・所属・ワークスペースの DO・セッション）を作る */
async function signIn(label: string): Promise<Signed> {
  const u = await ensureUser(env.DB, { sub: `sub-${label}-${newId()}`, email: `${label}@example.com`, name: null }, NOW);
  await env.WORKSPACE.get(env.WORKSPACE.idFromName(u.workspaceId)).init(u.workspaceId, u.userId);
  const s = await issueSession(env.DB, { userId: u.userId, workspaceId: u.workspaceId, now: NOW });
  return { cookie: `${SESSION_COOKIE}=${s.cookieValue}`, csrfToken: s.csrfToken, ws: { workspaceId: u.workspaceId, userId: u.userId } };
}

function get(path: string, who?: Signed): Promise<Response> {
  return Promise.resolve(app.request(`${ORIGIN}/api/v1${path}`, who === undefined ? {} : { headers: { cookie: who.cookie } }, env));
}

async function errorOf(res: Response): Promise<{ code: string; message: string; requestId: string; details?: unknown }> {
  return ((await res.json()) as { error: { code: string; message: string; requestId: string; details?: unknown } }).error;
}

/**
 * 順番の依頼（受信箱係 1 → 仕入れ係 2。窓口は仕入れ係）。受信箱係は済み（報告あり）、仕入れ係は送る前の確認で止まっている。
 * 回答は保存済み（確認待ち1件）、連絡板に1通、担当からの質問が1つ、編成を作った Gemini の呼び出しが1回
 */
async function seedChainAsk(who: Signed) {
  return inNamedWorkspace(who.ws, (db, ws) => {
    const inbox = fxAgent(db, { name: "受信箱係", jobSlug: "inbox" });
    const buyer = fxAgent(db, { name: "仕入れ係", jobSlug: "buy" });
    const { askId } = fxAsk(db, ws, { status: "running", shape: "chain", text: "仕入れ先のメールを読んで、在庫を見て、必要なら発注して" });
    const m1 = fxAskMember(db, { askId, agent: inbox, position: 1 }).memberId;
    const m2 = fxAskMember(db, { askId, agent: buyer, position: 2, isSpokesperson: true }).memberId;
    run(db, "UPDATE ask_members SET depends_on = ? WHERE id = ?", [1], m2);
    const { askRunId } = fxAskRun(db, askId);
    const t1 = fxTask(db, ws, inbox, { status: "succeeded", askId, askRunId, now: NOW }).taskId;
    const t2 = fxTask(db, ws, buyer, { status: "awaiting_approval", askId, askRunId, now: NOW }).taskId;
    run(db, "UPDATE tasks SET ask_member_id = ?, report = ?, report_title = ?, report_kind = 'normal' WHERE id = ?", m1, "仕入れ先から値上げの連絡", "受信箱の要約", t1);
    run(db, "UPDATE tasks SET ask_member_id = ?, input_task_ids = ? WHERE id = ?", m2, [t1], t2);

    const c = fxConnector(db);
    const { intentId } = fxIntent(db, { taskId: t2, jobId: buyer.jobId, connectorId: c.connectorId, now: NOW });
    const { approvalId } = fxApproval(db, ws, { taskId: t2, intentId, now: NOW });
    run(
      db,
      `INSERT INTO policy_decisions (id, task_id, subject_kind, subject, counters, flags, decision, reason_code, inputs_hash, kernel_version, created_at)
       VALUES (?, ?, 'tool_call', ?, '{}', '{}', 'allow', 'allowed', ?, 'test', ?)`,
      newId(),
      t2,
      { action: "mcp.gcal.list_events" },
      fxHash("inputs"),
      NOW,
    );
    const answer = {
      conclusion: "発注の確認待ちです\n値上げ前に20kg発注します",
      spokesperson: { agentId: buyer.agentId, agentName: "仕入れ係" },
      memberLines: [
        { agentName: "受信箱係", text: "メールを読みました", failed: false },
        { agentName: "仕入れ係", text: "発注を用意しました", failed: false },
      ],
      needsYou: { pendingApprovals: 1, stoppedMembers: [], declinedWrites: 0 },
      intermediate: [{ agentName: "受信箱係", body: "仕入れ先から値上げの連絡" }],
      taintNote: null,
      nextActions: ["来週も確認して"],
      updatedAt: "2026-10-22T09:05:00.000Z",
    };
    run(db, "UPDATE ask_runs SET answer = ?, answered_at = ? WHERE id = ?", answer, new Date("2026-10-22T09:04:00.000Z"), askRunId);
    const messageId = newId();
    run(
      db,
      `INSERT INTO ask_messages (id, ask_id, ask_run_id, from_member, to_member, kind, body, tainted, from_task_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'share', ?, 0, ?, ?)`,
      messageId,
      askId,
      askRunId,
      m1,
      m2,
      "値上げは来月からです",
      t1,
      NOW,
    );
    run(
      db,
      `INSERT INTO agent_questions (id, ask_id, ask_run_id, task_id, agent_id, agent_name, question, choices, created_at)
       VALUES (?, ?, ?, ?, ?, '仕入れ係', 'どちらの仕入れ先にしますか', ?, ?)`,
      newId(),
      askId,
      askRunId,
      t2,
      buyer.agentId,
      [{ id: "c1", label: "山田珈琲" }],
      NOW,
    );
    fxUsage(db, { askId, phase: "planner", model: "gemini-test-planner", costMicroUsd: 3_000, latencyMs: 14_000 });
    return { askId, askRunId, inboxId: inbox.agentId, buyerId: buyer.agentId, t1, t2, intentId, approvalId, messageId };
  });
}

describe("GET /api/v1/asks・/asks/:id・/asks/:id/messages", () => {
  it("一覧・依頼のページ・連絡板が apps/app と同じ形の JSON で返る", async () => {
    const who = await signIn("owner");
    const x = await seedChainAsk(who);

    const list = await get("/asks", who);
    expect(list.status).toBe(200);
    const asks = ListAsksResponseSchema.parse(await list.json()).asks;
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      id: x.askId,
      status: "running",
      shape: "chain",
      trigger: null,
      question: null,
      failure: null,
      answerPreview: "発注の確認待ちです",
      needsConnection: null,
    });
    expect(asks[0]!.shapeLine).not.toBeNull();
    expect(ListAsksResponseSchema.parse(await (await get("/asks?status=done", who)).json()).asks).toEqual([]);
    expect(ListAsksResponseSchema.parse(await (await get("/asks?limit=1&status=running", who)).json()).asks).toHaveLength(1);

    // 依頼の ID は大文字でも小文字にそろえて引く
    const res = await get(`/asks/${x.askId.toUpperCase()}`, who);
    expect(res.status).toBe(200);
    const d = AskDetailResponseSchema.parse(await res.json());
    expect(d.ask.id).toBe(x.askId);
    expect(d.formation?.members.map((m) => [m.agentName, m.position, m.isSpokesperson])).toEqual([
      ["受信箱係", 1, false],
      ["仕入れ係", 2, true],
    ]);
    expect(d.run).toMatchObject({ runId: x.askRunId, runNo: 1, status: "running", triggerType: "initial", finishedAt: null });
    expect(d.answer).toMatchObject({
      conclusion: "発注の確認待ちです\n値上げ前に20kg発注します",
      spokesperson: { agentId: x.buyerId, agentName: "仕入れ係" },
      needsYou: { pendingApprovals: 1, line: "あなたの確認待ち：1件", stoppedMembers: [], declinedWrites: 0, declinedLine: null },
      nextActions: ["来週も確認して"],
      unchanged: false,
      answeredAt: "2026-10-22T09:04:00.000Z",
      updatedAt: "2026-10-22T09:05:00.000Z",
    });
    expect(d.answerPending).toBeNull();
    expect(d.turns).toEqual([
      expect.objectContaining({ runId: x.askRunId, runNo: 1, kind: "ask", text: "仕入れ先のメールを読んで、在庫を見て、必要なら発注して", status: "running" }),
    ]);
    expect(d.stages.map((s) => [s.agentName, s.state, s.stateText, s.taskId, s.reuseLine])).toEqual([
      ["受信箱係", "done", "済み", x.t1, "新しく作りました"],
      ["仕入れ係", "awaiting_approval", "確認待ち", x.t2, "新しく作りました"],
    ]);
    expect(d.stages[0]!.report).toEqual({ title: "受信箱の要約", body: "仕入れ先から値上げの連絡" });
    expect(d.stages[0]!.finishedAt).toBe(NOW.toISOString());
    expect(d.stages[1]!.activity).toEqual([{ label: "予定の確認", outcome: "done", at: NOW.toISOString() }]);
    expect(d.handoffs).toEqual([{ fromPosition: 1, toPosition: 2, fromAgentName: "受信箱係", toAgentName: "仕入れ係", label: "受信箱の要約", taintMark: null }]);
    expect(d.pendingIntents).toEqual([
      expect.objectContaining({ intentId: x.intentId, approvalId: x.approvalId, taskId: x.t2, agentName: "仕入れ係", action: "mcp.supplier.place_order", taintLine: null }),
    ]);
    expect(d.agentQuestions).toEqual([
      expect.objectContaining({ agentName: "仕入れ係", text: "どちらの仕入れ先にしますか", choices: [{ id: "c1", label: "山田珈琲" }], allowFreeText: true }),
    ]);
    expect(d.pendingReplies).toEqual([]);
    expect(d.resume).toBeNull();
    expect(d.messageCount).toBe(1);
    // 費用はマイクロドルの整数から、前と同じ小数6桁の USD の文字列
    expect(d.planner).toEqual({ model: "gemini-test-planner", calls: 1, latencyMs: 14_000, costUsd: "0.003000" });

    const msgs = await get(`/asks/${x.askId}/messages`, who);
    expect(msgs.status).toBe(200);
    expect(ListAskMessagesResponseSchema.parse(await msgs.json()).messages).toEqual([
      {
        id: x.messageId,
        fromAgentName: "受信箱係",
        toAgentName: "仕入れ係",
        kind: "share",
        body: "値上げは来月からです",
        inReplyTo: null,
        tainted: false,
        createdAt: NOW.toISOString(),
      },
    ]);
  });

  it("生成に失敗した依頼は理由の固定文、まだ動いていない依頼は run・answer が null で段は「待っています」", async () => {
    const who = await signIn("owner-2");
    const ids = await inNamedWorkspace(who.ws, (db, ws) => {
      const failed = fxAsk(db, ws, { status: "failed", shape: null, text: "来週の予定をカレンダーに入れて" }).askId;
      const a = fxAgent(db, { name: "一人係" });
      const single = fxAsk(db, ws, { status: "running", shape: "single", text: "ひとりで" }).askId;
      fxAskMember(db, { askId: single, agent: a, position: 1, isSpokesperson: true });
      return { failed, single };
    });
    const f = AskDetailResponseSchema.parse(await (await get(`/asks/${ids.failed}`, who)).json());
    expect(f.ask).toMatchObject({ status: "failed", failure: { reason: "planner_error", message: "Gemini の呼び出しに失敗しました。もう一度送ってください" }, needsConnection: "gcal" });
    expect(f.formation).toBeNull();
    expect(f.planner).toBeNull();
    const s = AskDetailResponseSchema.parse(await (await get(`/asks/${ids.single}`, who)).json());
    expect(s).toMatchObject({ run: null, answer: null, answerPending: null, turns: [], messageCount: 0 });
    expect(s.stages.map((x) => [x.agentName, x.state, x.stateText])).toEqual([["一人係", "waiting", "待っています"]]);
    expect(await (await get(`/asks/${ids.single}/messages`, who)).json()).toEqual({ messages: [] });
  });

  it("セッションがなければ 401、ID・クエリの形が違えば 400、ない依頼・別のワークスペースの依頼は 404（エラーは共通の形）", async () => {
    const owner = await signIn("owner-3");
    const x = await seedChainAsk(owner);
    const other = await signIn("other");

    for (const path of ["/agents", "/asks", `/asks/${x.askId}`, `/asks/${x.askId}/messages`]) {
      const res = await get(path);
      expect(res.status).toBe(401);
      const e = await errorOf(res);
      expect(e).toMatchObject({ code: "UNAUTHORIZED", message: "認証されていません" });
      expect(e.requestId).toMatch(/^req_[0-9A-Z]{26}$/);
      expect(res.headers.get("x-request-id")).toBe(e.requestId);
    }

    const badId = await get("/asks/not-a-uuid", owner);
    expect(badId.status).toBe(400);
    expect(await errorOf(badId)).toMatchObject({ code: "VALIDATION_ERROR", details: [{ field: "askId", reason: "uuid の形ではありません" }] });
    expect((await get("/asks/not-a-uuid/messages", owner)).status).toBe(400);
    for (const q of ["limit=0", "limit=51", "status=unknown", "foo=1"]) {
      const res = await get(`/asks?${q}`, owner);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION_ERROR");
    }

    const missing = await get(`/asks/${MISSING}`, owner);
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("NOT_FOUND");
    expect((await get(`/asks/${MISSING}/messages`, owner)).status).toBe(404);

    // 別のワークスペースからは見えない（DO をセッションのワークスペースの ID で引く）
    expect((await get(`/asks/${x.askId}`, other)).status).toBe(404);
    expect((await get(`/asks/${x.askId}/messages`, other)).status).toBe(404);
    expect(ListAsksResponseSchema.parse(await (await get("/asks", other)).json()).asks).toEqual([]);
    expect(AgentLibraryResponseSchema.parse(await (await get("/agents", other)).json())).toMatchObject({ items: [], count: 0 });
  });

  it("知らない /api/v1/* はセッションがなくても 404 の JSON", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("NOT_FOUND");
    const post = await app.request(`${ORIGIN}/api/v1/nope`, { method: "POST" }, env);
    expect(post.status).toBe(404);
  });
});

describe("GET /api/v1/agents", () => {
  it("依頼の担当が、関わった依頼・仕事・いまの様子つきで並ぶ", async () => {
    const who = await signIn("owner-4");
    const x = await seedChainAsk(who);
    await inNamedWorkspace(who.ws, (db) => {
      run(db, "INSERT INTO agent_skills (id, agent_id, name, description, body) VALUES (?, ?, '在庫の見方', '在庫を見る', '手順')", newId(), x.buyerId);
      run(
        db,
        "INSERT INTO skill_proposals (id, agent_id, status, name, description, body, reason) VALUES (?, ?, 'proposed', '発注の定型', '発注の手順', '## 手順', '3回続けて同じ手順')",
        newId(),
        x.buyerId,
      );
    });
    const res = await get("/agents", who);
    expect(res.status).toBe(200);
    const body = AgentLibraryResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ limit: 20, count: 2 });
    const buyer = body.items.find((a) => a.name === "仕入れ係")!;
    const inbox = body.items.find((a) => a.name === "受信箱係")!;
    expect(buyer).toMatchObject({ status: "active", activity: "awaiting_approval", activityText: "確認待ち", disabledReason: null, taskCount: 1, askCount: 1, bornAskId: x.askId });
    expect(inbox).toMatchObject({ activity: "idle", activityText: "待機中", taskCount: 1, lastActiveAt: NOW.toISOString() });
    expect(buyer.asks.map((k) => [k.askId, k.isSpokesperson, k.position, k.isNew])).toEqual([[x.askId, true, 2, true]]);
    expect(inbox.asks.map((k) => [k.askId, k.isSpokesperson, k.position])).toEqual([[x.askId, false, 1]]);
    expect(buyer.jobs).toEqual([expect.objectContaining({ kind: "recurring", kindLabel: "定期", template: "assistant", templateLabel: "手伝う" })]);
    expect(buyer.skills).toEqual([expect.objectContaining({ name: "在庫の見方", origin: "pack", lastUsedAt: null })]);
    expect(buyer.skillProposals).toEqual([expect.objectContaining({ name: "発注の定型", reason: "3回続けて同じ手順" })]);
    expect(buyer.growth).toEqual({ reuseCount: 0, allowedRuleCount: 0, skillCount: 1 });
    expect(buyer.growthLine).toBe("スキル 1件");
    expect(inbox.skills).toEqual([]);
  });
});

describe("apiRouter の守り", () => {
  it("状態を変えるメソッドは X-CSRF-Token がセッションのものと同じときだけ通す（403 CSRF_TOKEN_INVALID）", async () => {
    const who = await signIn("owner-5");
    const t = new Hono<AppEnv>();
    t.use("/api/*", sessionMiddleware({ fetch, now: () => NOW }));
    apiRouter(t).post("/echo", (c) => c.json({ ok: true }));
    t.onError(errorHandler());
    const post = (headers: Record<string, string>) => t.request(`${ORIGIN}/api/v1/echo`, { method: "POST", headers }, env);
    expect((await post({})).status).toBe(401);
    const noToken = await post({ cookie: who.cookie });
    expect(noToken.status).toBe(403);
    expect((await errorOf(noToken)).code).toBe("CSRF_TOKEN_INVALID");
    expect((await post({ cookie: who.cookie, "x-csrf-token": "wrong" })).status).toBe(403);
    const ok = await post({ cookie: who.cookie, "x-csrf-token": who.csrfToken });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });
});
