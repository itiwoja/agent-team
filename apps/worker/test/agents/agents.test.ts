// エージェントの作成・削除の経路：POST /agents（台本の LLM）・DELETE /agents/:agentId（routes/agents.ts → WorkspaceDO の RPC）。
// ログインしたセッションは D1 に直接作り、DO の中の行は fixtures で入れて確かめる
import { env } from "cloudflare:workers";
import { defaultWorkspacePolicy, hashCanonical, type JsonObject } from "@open-team/kernel";
import { LlmError, ScriptedLlmClient, type ScriptedStep } from "@open-team/llm";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../../src/auth/routes.ts";
import { ensureUser, issueSession } from "../../src/auth/session.ts";
import { all, count, newId, run } from "../../src/db/sqlite.ts";
import { createApp } from "../../src/index.ts";
import { setLlmForTest } from "../../src/llm.ts";
import { AgentLibraryResponseSchema, CreateAgentResponseSchema, DeleteAgentResponseSchema } from "../../src/views/agents/contract.ts";
import { jsonReply } from "../asks/helpers.ts";
import { fxAgent, fxAsk, fxAskMember, fxConnector, fxTask, fxUsage, inNamedWorkspace, type FxWorkspace } from "../db/fixtures.ts";

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

function send(method: "POST" | "DELETE", path: string, who: Signed, body?: unknown, key?: string): Promise<Response> {
  const headers: Record<string, string> = { cookie: who.cookie, "x-csrf-token": who.csrfToken };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key !== undefined) headers["idempotency-key"] = key;
  return Promise.resolve(
    app.request(`${ORIGIN}/api/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env),
  );
}

async function library(who: Signed) {
  const res = await app.request(`${ORIGIN}/api/v1/agents`, { headers: { cookie: who.cookie } }, env);
  return AgentLibraryResponseSchema.parse(await res.json());
}

async function errorOf(res: Response): Promise<{ code: string; details?: unknown }> {
  return ((await res.json()) as { error: { code: string; details?: unknown } }).error;
}

const draft = (over: Record<string, unknown> = {}) => ({ name: "グルメ探偵", role: "research", summary: "お店を調べて短く報告する", grants: [], ...over });

function useLlm(script: readonly ScriptedStep[]): ScriptedLlmClient {
  const client = new ScriptedLlmClient(script);
  setLlmForTest(client);
  return client;
}

afterEach(() => setLlmForTest(null));

describe("POST /agents", () => {
  it("文から1体作る：201・約束の形。agents・agent_snapshots・監査ログ・SSE の事象・費用が残り、一覧に出る。仕事は持たない", async () => {
    const who = await signIn("agent-create");
    const llm = useLlm([jsonReply(draft())]);
    const res = await send("POST", "/agents", who, { text: "  駅前のラーメン屋を調べて  " });
    expect(res.status).toBe(201);
    const { agent } = CreateAgentResponseSchema.parse(await res.json());
    expect(agent).toMatchObject({ name: "グルメ探偵", role: "research", summary: "お店を調べて短く報告する" });
    expect(llm.requests).toHaveLength(1);
    expect(JSON.stringify(llm.requests[0]?.messages)).toContain("駅前のラーメン屋を調べて");

    await inNamedWorkspace(who.ws, (db) => {
      expect(all<{ name: string; status: string; role: string; current_snapshot_id: string | null }>(db, {}, "SELECT name, status, role, current_snapshot_id FROM agents")).toEqual([
        expect.objectContaining({ name: "グルメ探偵", status: "active", role: "research", current_snapshot_id: expect.any(String) }),
      ]);
      expect(count(db, "SELECT count(*) FROM agent_snapshots WHERE agent_id = ?", agent.agentId)).toBe(1);
      expect(count(db, "SELECT count(*) FROM agent_jobs")).toBe(0);
      expect(count(db, "SELECT count(*) FROM audit_logs WHERE event_type = 'agent.created'")).toBe(1);
      const events = all<{ data: string }>(db, {}, "SELECT data FROM workspace_events WHERE type = 'agent.created'");
      expect(events.map((e) => JSON.parse(e.data))).toEqual([{ agentId: agent.agentId, name: "グルメ探偵" }]);
      expect(count(db, "SELECT count(*) FROM usage_records WHERE agent_id = ? AND phase = 'planner'", agent.agentId)).toBe(1);
    });
    expect((await library(who)).items.map((a) => a.id)).toEqual([agent.agentId]);
  });

  it("つながっていて使えるコネクタとツールだけを付ける（ないコネクタ・ツールは捨てる）", async () => {
    const who = await signIn("agent-grants");
    await inNamedWorkspace(who.ws, (db) => {
      fxConnector(db, { slug: "supplier" });
      fxConnector(db, { slug: "offline", enabled: false });
      fxConnector(db, { slug: "unlisted" });
      // ポリシー v2：supplier・offline・unlisted のうち supplier と offline だけ許可
      const policy = defaultWorkspacePolicy(["supplier", "offline"]);
      run(
        db,
        "INSERT INTO workspace_policies (id, version, policy, policy_hash) VALUES (?, 2, ?, ?)",
        newId(),
        policy as unknown as JsonObject,
        hashCanonical(policy),
      );
    });
    useLlm([
      jsonReply(
        draft({
          grants: [
            { connector: "supplier", tools: ["list_products", "no_such_tool"] },
            { connector: "offline", tools: ["list_products"] },
            { connector: "unlisted", tools: ["list_products"] },
            { connector: "ghost", tools: ["x"] },
          ],
        }),
      ),
    ]);
    const res = await send("POST", "/agents", who, { text: "仕入れ先の商品を調べて" });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    await inNamedWorkspace(who.ws, (db) => {
      const row = all<{ definition: string }>(db, {}, "SELECT s.definition FROM agent_snapshots s")[0];
      const def = JSON.parse(row!.definition) as { grants: { connectors: Record<string, { grant: string[] }> } };
      expect(def.grants.connectors).toEqual({ supplier: { grant: ["list_products"] } });
    });
  });

  it("名前が決まりに合わなければ1回だけ作り直す。直ればその名前", async () => {
    const who = await signIn("agent-name-retry");
    const llm = useLlm([jsonReply(draft({ name: "とてもとても長い名前のエージェントさん" })), jsonReply(draft({ name: "受信箱の門番" }))]);
    const res = await send("POST", "/agents", who, { text: "メールを読んで" });
    expect(res.status).toBe(201);
    expect(CreateAgentResponseSchema.parse(await res.json()).agent.name).toBe("受信箱の門番");
    expect(llm.requests).toHaveLength(2);
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain("決まりに合わない");
  });

  it("2回続けて合わなければ既定の名前。同じ名前が既にあれば番号を足す", async () => {
    const who = await signIn("agent-name-default");
    useLlm([jsonReply(draft({ name: "あ" })), jsonReply(draft({ name: "x!" }))]);
    const first = CreateAgentResponseSchema.parse(await (await send("POST", "/agents", who, { text: "調べて" })).json());
    expect(first.agent.name).toBe("新人エージェント");

    useLlm([jsonReply(draft({ name: "あ" })), jsonReply(draft({ name: "x!" }))]);
    const second = CreateAgentResponseSchema.parse(await (await send("POST", "/agents", who, { text: "調べて" })).json());
    expect(second.agent.name).toBe("新人エージェント2");
  });

  it("JSON として読めない出力が2回続いたら 502（何も作らない）", async () => {
    const who = await signIn("agent-bad-json");
    const llm = useLlm([{ parts: [{ type: "text", text: "ごめんなさい" }] }, { parts: [{ type: "text", text: "{}" }] }]);
    const res = await send("POST", "/agents", who, { text: "調べて" });
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatchObject({ code: "LLM_UPSTREAM_ERROR" });
    expect(llm.requests).toHaveLength(2);
    await inNamedWorkspace(who.ws, (db) => {
      expect(count(db, "SELECT count(*) FROM agents")).toBe(0);
      // 呼んだ2回分の費用は、エージェントを作れなくても持ち主なしで残す（日ごとの上限に数える）
      expect(count(db, "SELECT count(*) FROM usage_records WHERE agent_id IS NULL AND task_id IS NULL AND ask_id IS NULL AND phase = 'planner'")).toBe(2);
    });
  });

  it("保存で断られたら（上限の競合）、LLM の費用は持ち主なしで残り、エージェントは増えない", async () => {
    const who = await signIn("agent-save-denied");
    // prepare のあと save の前に20体になる：LLM の台本の中で埋める
    useLlm([
      async () => {
        await inNamedWorkspace(who.ws, (db) => {
          for (let i = 0; i < 20; i += 1) fxAgent(db, { name: `担当${i}`, jobSlug: "j-one" });
        });
        return jsonReply(draft());
      },
    ]);
    const res = await send("POST", "/agents", who, { text: "調べて" });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "AGENT_LIMIT_REACHED" });
    await inNamedWorkspace(who.ws, (db) => {
      expect(count(db, "SELECT count(*) FROM agents")).toBe(20);
      expect(count(db, "SELECT count(*) FROM usage_records WHERE agent_id IS NULL AND phase = 'planner'")).toBe(1);
    });
  });

  it("LLM の呼び出しが失敗したら 502", async () => {
    const who = await signIn("agent-llm-fail");
    useLlm([
      () => {
        throw new LlmError("混んでいる", null, false);
      },
    ]);
    const res = await send("POST", "/agents", who, { text: "調べて" });
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatchObject({ code: "LLM_UPSTREAM_ERROR" });
    // 送れたか分からない失敗の見積もりも持ち主なしで残る
    await inNamedWorkspace(who.ws, (db) => {
      expect(count(db, "SELECT count(*) FROM usage_records WHERE agent_id IS NULL AND phase = 'planner'")).toBeGreaterThanOrEqual(1);
    });
  });

  it("今日の費用の上限を超えていれば 429（LLM は呼ばない）", async () => {
    const who = await signIn("agent-budget");
    await inNamedWorkspace(who.ws, (db) => {
      const a = fxAgent(db);
      fxUsage(db, { agentId: a.agentId, costMicroUsd: 20_000_000, createdAt: NOW });
    });
    const llm = useLlm([jsonReply(draft())]);
    const res = await send("POST", "/agents", who, { text: "調べて" });
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toMatchObject({ code: "DAILY_BUDGET_EXCEEDED" });
    expect(llm.requests).toHaveLength(0);
  });

  it("20体いれば 422 AGENT_LIMIT_REACHED（LLM は呼ばない）。削除した分は数えない", async () => {
    const who = await signIn("agent-limit");
    const ids = await inNamedWorkspace(who.ws, (db) => Array.from({ length: 20 }, (_, i) => fxAgent(db, { name: `担当${i}`, jobSlug: "j-one" }).agentId));
    const llm = useLlm([jsonReply(draft())]);
    const res = await send("POST", "/agents", who, { text: "調べて" });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "AGENT_LIMIT_REACHED", details: { limit: 20 } });
    expect(llm.requests).toHaveLength(0);

    expect((await send("DELETE", `/agents/${ids[0]}`, who)).status).toBe(200);
    expect((await send("POST", "/agents", who, { text: "調べて" })).status).toBe(201);
  });

  it("Idempotency-Key：同じキーの2回目は記録した応答を返し、LLM も呼ばず、2体目も作らない。違う本文なら 400", async () => {
    const who = await signIn("agent-idem");
    const llm = useLlm([jsonReply(draft())]);
    const key = newId();
    const a = await send("POST", "/agents", who, { text: "調べて" }, key);
    const b = await send("POST", "/agents", who, { text: "調べて" }, key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await b.json()).toEqual(await a.json());
    expect(llm.requests).toHaveLength(1);
    await inNamedWorkspace(who.ws, (db) => expect(count(db, "SELECT count(*) FROM agents")).toBe(1));

    const other = await send("POST", "/agents", who, { text: "別のこと" }, key);
    expect(other.status).toBe(400);
  });

  it("本文が外れていれば 400、セッションがなければ 401", async () => {
    const who = await signIn("agent-guard");
    expect((await send("POST", "/agents", who, { text: "   " })).status).toBe(400);
    expect((await send("POST", "/agents", who, { text: "あ".repeat(2001) })).status).toBe(400);
    expect((await send("POST", "/agents", who, {})).status).toBe(400);
    const anon = await app.request(`${ORIGIN}/api/v1/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) }, env);
    expect(anon.status).toBe(401);
  });
});

describe("DELETE /agents/:agentId", () => {
  it("削除する：200・status = removed・仕事は done・履歴は残る。一覧に出ない。監査ログと事象も残る。2回目は 404", async () => {
    const who = await signIn("agent-delete");
    const a = await inNamedWorkspace(who.ws, (db) => {
      const a = fxAgent(db, { name: "仕入れ係" });
      const ask = fxAsk(db, who.ws, { status: "done" });
      fxAskMember(db, { askId: ask.askId, agent: a });
      fxTask(db, who.ws, a, { status: "succeeded", askId: ask.askId });
      return { ...a, askId: ask.askId };
    });
    const res = await send("DELETE", `/agents/${a.agentId}`, who);
    expect(res.status).toBe(200);
    expect(DeleteAgentResponseSchema.parse(await res.json())).toEqual({ agentId: a.agentId, stoppedAsks: 0 });

    await inNamedWorkspace(who.ws, (db) => {
      expect(all<{ status: string }>(db, {}, "SELECT status FROM agents WHERE id = ?", a.agentId)).toEqual([{ status: "removed" }]);
      expect(all<{ status: string }>(db, {}, "SELECT status FROM agent_jobs WHERE agent_id = ?", a.agentId)).toEqual([{ status: "done" }]);
      expect(count(db, "SELECT count(*) FROM tasks WHERE agent_id = ?", a.agentId)).toBe(1);
      expect(count(db, "SELECT count(*) FROM ask_members WHERE agent_id = ?", a.agentId)).toBe(1);
      expect(count(db, "SELECT count(*) FROM audit_logs WHERE event_type = 'agent.removed'")).toBe(1);
      const events = all<{ data: string }>(db, {}, "SELECT data FROM workspace_events WHERE type = 'agent.removed'");
      expect(events.map((e) => JSON.parse(e.data))).toEqual([{ agentId: a.agentId }]);
    });
    expect((await library(who)).items).toHaveLength(0);
    expect((await send("DELETE", `/agents/${a.agentId}`, who)).status).toBe(404);
  });

  it("いない・uuid でない ID は 404・400", async () => {
    const who = await signIn("agent-delete-404");
    expect((await send("DELETE", `/agents/${newId()}`, who)).status).toBe(404);
    expect((await send("DELETE", "/agents/not-a-uuid", who)).status).toBe(400);
  });

  it("終わっていないタスクがあれば 409 AGENT_BUSY で、何も変わらない。終われば削除できる", async () => {
    const who = await signIn("agent-delete-busy-task");
    const a = await inNamedWorkspace(who.ws, (db) => {
      const a = fxAgent(db);
      const t = fxTask(db, who.ws, a, { status: "awaiting_approval" });
      return { ...a, taskId: t.taskId };
    });
    const res = await send("DELETE", `/agents/${a.agentId}`, who);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: "AGENT_BUSY" });
    await inNamedWorkspace(who.ws, (db) => {
      expect(all<{ status: string }>(db, {}, "SELECT status FROM agents WHERE id = ?", a.agentId)).toEqual([{ status: "active" }]);
      expect(all<{ status: string }>(db, {}, "SELECT status FROM agent_jobs WHERE agent_id = ?", a.agentId)).toEqual([{ status: "active" }]);
      expect(count(db, "SELECT count(*) FROM audit_logs WHERE event_type = 'agent.removed'")).toBe(0);
      expect(count(db, "SELECT count(*) FROM workspace_events WHERE type = 'agent.removed'")).toBe(0);
      run(db, "UPDATE tasks SET status = 'cancelled', finished_at = ? WHERE id = ?", NOW, a.taskId);
    });
    expect((await send("DELETE", `/agents/${a.agentId}`, who)).status).toBe(200);
  });

  it("生成中・実行中・入力待ちの依頼の編成に入っていれば 409 AGENT_BUSY（終わった依頼なら削除できる）", async () => {
    const who = await signIn("agent-delete-busy-ask");
    const ids = await inNamedWorkspace(who.ws, (db) =>
      (["generating", "running", "waiting_input", "failed"] as const).map((status) => {
        const a = fxAgent(db, { name: `担当-${status}` });
        const ask = fxAsk(db, who.ws, { status });
        fxAskMember(db, { askId: ask.askId, agent: a });
        return { status, agentId: a.agentId };
      }),
    );
    for (const { status, agentId } of ids) {
      const res = await send("DELETE", `/agents/${agentId}`, who);
      expect(res.status, status).toBe(status === "failed" ? 200 : 409);
      if (status !== "failed") expect(await errorOf(res)).toMatchObject({ code: "AGENT_BUSY" });
    }
  });

  it("定期の依頼の編成に入っていれば、その依頼の定期を止める（next_run_at が null になる）。stoppedAsks はその数", async () => {
    const who = await signIn("agent-delete-schedule");
    const x = await inNamedWorkspace(who.ws, (db) => {
      const a = fxAgent(db);
      const other = fxAgent(db, { name: "別の係", jobSlug: "other-job" });
      // 1つの担当が複数の依頼に入るので、依頼ごとに仕事を足す（ask_members.job_id は一意）
      const memberOf = (askId: string, agent: ReturnType<typeof fxAgent>, position?: number) => {
        const jobId = newId();
        run(db, "INSERT INTO agent_jobs (id, agent_id, slug, kind, template) VALUES (?, ?, ?, 'recurring', 'assistant')", jobId, agent.agentId, `job-${jobId.slice(0, 8)}`);
        fxAskMember(db, { askId, agent: { ...agent, jobId }, ...(position === undefined ? {} : { position }) });
      };
      const trigger = JSON.stringify({ type: "schedule", cron: "0 18 * * *", timezone: "Asia/Tokyo" });
      const mk = (status: "running" | "done", withSchedule: boolean) => {
        const ask = fxAsk(db, who.ws, { status });
        if (withSchedule) run(db, `UPDATE asks SET "trigger" = ?, next_run_at = ? WHERE id = ?`, trigger, "2026-10-22T09:00:00.000Z", ask.askId);
        return ask.askId;
      };
      const s1 = mk("running", true);
      const s2 = mk("running", true);
      const s3 = mk("running", true); // 別のエージェントだけの定期は止めない
      const plain = mk("done", false);
      memberOf(s1, a, 1);
      memberOf(s1, other, 2);
      memberOf(s2, a);
      memberOf(s3, other);
      memberOf(plain, a);
      return { agentId: a.agentId, s1, s2, s3 };
    });
    const res = await send("DELETE", `/agents/${x.agentId}`, who);
    expect(res.status).toBe(200);
    expect(DeleteAgentResponseSchema.parse(await res.json()).stoppedAsks).toBe(2);
    await inNamedWorkspace(who.ws, (db) => {
      const next = (id: string) => all<{ next_run_at: string | null; status: string }>(db, {}, "SELECT next_run_at, status FROM asks WHERE id = ?", id)[0];
      expect(next(x.s1)).toMatchObject({ next_run_at: null, status: "running" });
      expect(next(x.s2)?.next_run_at).toBeNull();
      expect(next(x.s3)?.next_run_at).not.toBeNull();
    });
  });
});
