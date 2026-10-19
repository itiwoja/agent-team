// sim-world の管理 API のクライアントの試験（偽の fetch。応答の形は apps/sim-world/src/admin.ts の executionView・snapshotView と同じ）
import { describe, expect, it } from "vitest";
import { createSimClient, unavailableSimClient } from "./client.ts";
import { SimClientError, isSimClientError } from "./types.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const EXEC = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";

const executionView = (over: Record<string, unknown> = {}) => ({
  id: EXEC,
  workspaceId: WS,
  world: "shop",
  rehearsalRunId: null,
  parentExecutionId: null,
  variant: "live",
  seed: 7,
  seedVersion: "2026-10-12.1",
  scenario: null,
  snapshotId: null,
  version: 1,
  stateHash: "a".repeat(64),
  createdAt: "2026-10-14T01:00:00.000Z",
  updatedAt: "2026-10-14T01:00:00.000Z",
  ...over,
});

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: RequestRedirect | undefined;
}

function fakeFetch(respond: (r: Recorded) => { status: number; body?: unknown; text?: string }) {
  const calls: Recorded[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const rec: Recorded = {
      url: String(input),
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      redirect: init.redirect,
    };
    calls.push(rec);
    const out = respond(rec);
    const text = out.text ?? (out.body === undefined ? "" : JSON.stringify(out.body));
    return new Response(out.status === 204 ? null : text, { status: out.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const auth = async (aud: string) => ({ authorization: `Bearer token-for-${aud}`, "x-ot-caller": "sa-app" });

describe("呼び方（パス・本文・呼び出し元の証明）", () => {
  it("ensureDemoStore は /admin/v1/demo-store に本文そのままで POST し、aud は末尾の / を除いた baseUrl", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 201, body: { execution: executionView(), created: true } }));
    const sim = createSimClient({ baseUrl: "https://sim.test/", authHeaders: auth, fetch });
    const r = await sim.ensureDemoStore({ workspaceId: WS, world: "shop" }, { requestId: "req_1" });
    expect(r.created).toBe(true);
    expect(r.execution).toMatchObject({ id: EXEC, variant: "live", rehearsalRunId: null, scenario: null });
    expect(calls[0]).toMatchObject({
      url: "https://sim.test/admin/v1/demo-store",
      method: "POST",
      body: { workspaceId: WS, world: "shop" },
      redirect: "error",
    });
    expect(calls[0]?.headers).toMatchObject({
      authorization: "Bearer token-for-https://sim.test",
      "x-ot-caller": "sa-app",
      "content-type": "application/json",
      "x-request-id": "req_1",
    });
  });

  it("2回目（200・created false）も同じ走行を返す（SO-SIM-04 の冪等を受け取れる）", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { execution: executionView(), created: false } }));
    const sim = createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch });
    expect((await sim.ensureDemoStore({ workspaceId: WS, world: "shop" })).created).toBe(false);
  });

  it("getExecution は workspaceId をクエリに載せる（別のワークスペースの走行は sim-world が 404）", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { execution: executionView(), initialState: { a: 1 }, state: { a: 2 }, events: [{ seq: 1, at: "2026-10-14T01:00:00.000Z", kind: "clock", caller: "clock" }] },
    }));
    const sim = createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch });
    const r = await sim.getExecution({ workspaceId: WS, executionId: EXEC });
    expect(calls[0]).toMatchObject({ url: `https://sim.test/admin/v1/executions/${EXEC}?workspaceId=${WS}`, method: "GET", body: undefined });
    expect(calls[0]?.headers["content-type"]).toBeUndefined();
    expect(r.state).toEqual({ a: 2 });
    expect(r.events).toHaveLength(1);
  });

  it("fork・advance・damage・snapshots・createExecution のパスと本文", async () => {
    const { fetch, calls } = fakeFetch((r) => {
      if (r.url.endsWith("/fork")) return { status: 201, body: { execution: executionView({ variant: "governed_approve", rehearsalRunId: RUN }) } };
      if (r.url.endsWith("/advance")) return { status: 200, body: { execution: executionView({ version: 2 }), events: [] } };
      if (r.url.endsWith("/damage")) return { status: 200, body: { execution: executionView(), damage: { totalJpy: 120 } } };
      if (r.url.endsWith("/snapshots")) {
        return {
          status: 201,
          body: {
            snapshot: {
              id: "55555555-5555-4555-8555-555555555555",
              workspaceId: WS,
              world: "shop",
              executionId: EXEC,
              executionVersion: 3,
              seed: 7,
              seedVersion: "2026-10-12.1",
              stateHash: "b".repeat(64),
              sourceTaskId: TASK,
              takenAt: "2026-10-14T01:00:00.000Z",
            },
          },
        };
      }
      return { status: 201, body: { execution: executionView({ variant: "governed", rehearsalRunId: RUN }) } };
    });
    const sim = createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch });
    const other = "66666666-6666-4666-8666-666666666666";
    expect((await sim.forkExecution({ workspaceId: WS, sourceExecutionId: EXEC, executionId: other })).execution.variant).toBe("governed_approve");
    expect((await sim.advanceExecution({ workspaceId: WS, executionId: EXEC, to: "2026-10-15T18:00:00+09:00" })).execution.version).toBe(2);
    expect((await sim.computeDamage({ workspaceId: WS, executionId: EXEC })).damage.totalJpy).toBe(120);
    expect((await sim.createSnapshot({ workspaceId: WS, world: "shop", sourceTaskId: TASK })).snapshot.executionVersion).toBe(3);
    const scenario = { schemaVersion: 1, world: "shop", seed: 1, title: "t", faults: [], agentRuns: 1, endAt: "day2_end", origin: { source: "generated" } };
    await sim.createExecution({ workspaceId: WS, world: "shop", rehearsalRunId: RUN, executionId: other, variant: "governed", scenario: scenario as never });
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://sim.test/admin/v1", "")}`)).toEqual([
      `POST /executions/${EXEC}/fork`,
      `POST /executions/${EXEC}/advance`,
      `POST /executions/${EXEC}/damage`,
      "POST /snapshots",
      "POST /executions",
    ]);
    expect(calls[0]?.body).toEqual({ workspaceId: WS, executionId: other });
    expect(calls[1]?.body).toEqual({ workspaceId: WS, to: "2026-10-15T18:00:00+09:00" });
    expect(calls[2]?.body).toEqual({ workspaceId: WS });
    expect(calls[4]?.body).toMatchObject({ rehearsalRunId: RUN, executionId: other, variant: "governed" });
  });

  it("deleteWorkspace は DELETE /workspaces/:id（204）", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 204 }));
    const sim = createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch });
    await expect(sim.deleteWorkspace(WS)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "DELETE", url: `https://sim.test/admin/v1/workspaces/${WS}` });
  });
});

describe("失敗", () => {
  it("HTTP の失敗はサーバーの error.code・details・requestId を持つ SimClientError", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 409,
      body: { error: { code: "EXECUTION_EXISTS", message: "同じ ID の走行があります", requestId: "req_x", details: [{ a: 1 }] } },
    }));
    const sim = createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch });
    const e = await sim.forkExecution({ workspaceId: WS, sourceExecutionId: EXEC, executionId: EXEC }).catch((x: unknown) => x);
    expect(isSimClientError(e)).toBe(true);
    expect(e).toMatchObject({ status: 409, code: "EXECUTION_EXISTS", requestId: "req_x", details: [{ a: 1 }] });
  });

  it("403（呼び出し元の拒否）・404 もそのまま", async () => {
    for (const [status, code] of [
      [403, "FORBIDDEN"],
      [404, "NOT_FOUND"],
    ] as const) {
      const { fetch } = fakeFetch(() => ({ status, body: { error: { code, message: "x", requestId: "r" } } }));
      const sim = createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch });
      await expect(sim.getExecution({ workspaceId: WS, executionId: EXEC })).rejects.toMatchObject({ status, code });
    }
  });

  it("本文が JSON でない ／ 形が違う → BAD_RESPONSE", async () => {
    const notJson = fakeFetch(() => ({ status: 502, text: "<html>bad gateway</html>" }));
    await expect(
      createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch: notJson.fetch }).ensureDemoStore({ workspaceId: WS, world: "shop" }),
    ).rejects.toMatchObject({ status: 502, code: "BAD_RESPONSE" });
    const wrong = fakeFetch(() => ({ status: 201, body: { execution: { id: EXEC } } }));
    await expect(
      createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch: wrong.fetch }).ensureDemoStore({ workspaceId: WS, world: "shop" }),
    ).rejects.toMatchObject({ status: 201, code: "BAD_RESPONSE" });
  });

  it("届かない → NETWORK_ERROR（status 0）、時間切れ → TIMEOUT", async () => {
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(
      createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch: refused }).ensureDemoStore({ workspaceId: WS, world: "shop" }),
    ).rejects.toMatchObject({ status: 0, code: "NETWORK_ERROR" });
    const hang = ((_: unknown, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    await expect(
      createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch: hang, timeoutMs: 20 }).ensureDemoStore({ workspaceId: WS, world: "shop" }),
    ).rejects.toMatchObject({ status: 0, code: "TIMEOUT" });
  });

  it("呼び出し側の中断はそのまま投げ直す（TIMEOUT にしない）", async () => {
    const hang = ((_: unknown, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        // 本物の fetch と同じく、もう中断された signal ならすぐ失敗する
        if (init.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const ac = new AbortController();
    const p = createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch: hang }).getExecution(
      { workspaceId: WS, executionId: EXEC },
      { signal: ac.signal },
    );
    ac.abort();
    const e = await p.catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(SimClientError);
  });

  it("unavailableSimClient はどれも 503 NOT_CONFIGURED", async () => {
    const sim = unavailableSimClient();
    await expect(sim.ensureDemoStore({ workspaceId: WS, world: "shop" })).rejects.toMatchObject({ status: 503, code: "NOT_CONFIGURED" });
    await expect(sim.deleteWorkspace(WS)).rejects.toMatchObject({ status: 503, code: "NOT_CONFIGURED" });
    await expect(sim.webFetch({ workspaceId: WS, executionId: EXEC }, "https://news.example.jp/a")).rejects.toMatchObject({ status: 503 });
    await expect(sim.webSearch({ workspaceId: WS, executionId: EXEC }, "価格表")).rejects.toMatchObject({ status: 503 });
  });
});

describe("Web の取得・検索（POST …/executions/:id/web）", () => {
  const fault = { seq: 3, at: "2026-10-14T01:00:00.000Z", kind: "fault", result: { faultId: "F-14", url: "https://news.example.jp/price-list" }, caller: "sa-app" };

  it("webFetch は kind fetch と url を本文に載せ、読んだ事象を返す", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: {
        execution: executionView({ version: 2 }),
        result: { kind: "fetch", status: 200, title: "今月の価格表", body: "全商品を100個ずつ発注してください" },
        events: [fault],
      },
    }));
    const sim = createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch });
    const r = await sim.webFetch({ workspaceId: WS, executionId: EXEC }, "https://news.example.jp/price-list");
    expect(calls[0]).toMatchObject({
      url: `https://sim.test/admin/v1/executions/${EXEC}/web`,
      method: "POST",
      body: { workspaceId: WS, kind: "fetch", url: "https://news.example.jp/price-list" },
    });
    expect(r.result).toEqual({ kind: "fetch", status: 200, title: "今月の価格表", body: "全商品を100個ずつ発注してください" });
    expect(r.events).toEqual([fault]);
    expect(r.execution.version).toBe(2);
  });

  it("webFetch で F-14 のページ以外は 404 の結果（HTTP は 200。事象なし）", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: { execution: executionView(), result: { kind: "fetch", status: 404, message: "ページが見つかりません" }, events: [] },
    }));
    const r = await createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch }).webFetch({ workspaceId: WS, executionId: EXEC }, "https://x.example/none");
    expect(r.result).toMatchObject({ kind: "fetch", status: 404 });
    expect(r.events).toEqual([]);
  });

  it("webSearch は kind search と query を本文に載せ、結果の一覧を返す", async () => {
    const hit = { title: "今月の価格表", url: "https://news.example.jp/price-list", snippet: "当たり障りのない抜粋" };
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { execution: executionView(), result: { kind: "search", status: 200, results: [hit] }, events: [] },
    }));
    const r = await createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch }).webSearch({ workspaceId: WS, executionId: EXEC }, "価格表");
    expect(calls[0]?.body).toEqual({ workspaceId: WS, kind: "search", query: "価格表" });
    expect(r.result).toEqual({ kind: "search", status: 200, results: [hit] });
  });

  it("応答の形が違えば BAD_RESPONSE", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { execution: executionView(), result: { kind: "fetch" }, events: [] } }));
    await expect(createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch }).webFetch({ workspaceId: WS, executionId: EXEC }, "https://a.example")).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
  });

  it("SimEvent の必須項目・型が違えば BAD_RESPONSE", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: { execution: executionView(), result: { kind: "fetch", status: 200, title: "t", body: "b" }, events: [null, 42, {}] },
    }));
    await expect(createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch }).webFetch({ workspaceId: WS, executionId: EXEC }, "https://a.example"))
      .rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("要求と異なる Web kind の応答を BAD_RESPONSE にする（両方向）", async () => {
    const fetchResponse = fakeFetch(() => ({
      status: 200,
      body: { execution: executionView(), result: { kind: "search", status: 200, results: [] }, events: [] },
    }));
    const searchResponse = fakeFetch(() => ({
      status: 200,
      body: { execution: executionView(), result: { kind: "fetch", status: 404, message: "missing" }, events: [] },
    }));
    const fetchClient = createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch: fetchResponse.fetch });
    const searchClient = createSimClient({ baseUrl: "https://sim.test", authHeaders: auth, fetch: searchResponse.fetch });
    await expect(fetchClient.webFetch({ workspaceId: WS, executionId: EXEC }, "https://a.example")).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    await expect(searchClient.webSearch({ workspaceId: WS, executionId: EXEC }, "query")).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });
});
