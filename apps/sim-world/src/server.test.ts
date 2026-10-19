import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fxWorkspace, useTestDb } from "@open-team/db/testing";
import { createServiceAuth } from "@open-team/platform";
import { BEANS_20, GATEWAY, adminApi, connectMcp, createDemoStore, createExecution, getExecution, newId, setup, simHeaders } from "./test-helpers.ts";

const SERVER_TS = fileURLToPath(new URL("./server.ts", import.meta.url));

describe("実際の HTTP（@hono/node-server。空いているポートで起動し、終わったら止める）", () => {
  const { app } = setup();
  let server: ServerType | undefined;
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        base = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    // fetch の keep-alive の接続を待たずに止める
    (server as import("node:http").Server | undefined)?.closeAllConnections?.();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it("MCP のクライアント SDK で HTTP を通して tools/list・tools/call。F-01 は HTTP 504 で届き、注文は反映済み", async () => {
    const ws = newId();
    const demo = await createDemoStore(app, ws);
    const client = await connectMcp({ base }, "/mcp/shop/supplier", { ...GATEWAY, ...simHeaders({ workspaceId: ws, taskId: newId() }) });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["list_products", "place_order"]);
      const res = await client.callTool({ name: "place_order", arguments: BEANS_20 });
      expect(res.structuredContent).toMatchObject({ order_id: "order-0001", total_jpy: 15_600 });
    } finally {
      await client.close();
    }
    expect((await getExecution(app, ws, demo.id)).state.orders).toHaveLength(1);

    const run = await createExecution(app, { workspaceId: ws, faults: [{ id: "F-01", tool: "supplier.place_order" }] });
    const c2 = await connectMcp({ base }, "/mcp/shop/supplier", {
      ...GATEWAY,
      ...simHeaders({ workspaceId: ws, rehearsalRunId: run.rehearsalRunId, executionId: run.id, intentId: newId() }),
    });
    try {
      const e = await c2.callTool({ name: "place_order", arguments: BEANS_20 }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(StreamableHTTPError);
      expect((e as StreamableHTTPError).code).toBe(504);
    } finally {
      await c2.close();
    }
    expect((await getExecution(app, ws, run.id)).state.orders).toHaveLength(1);
  });

  it("管理 API も HTTP で（fetch）", async () => {
    const r = await adminApi({ request: (input, init) => fetch(new URL(String(input).replace("http://sim.test", base)), init) }).post("/demo-store", {
      workspaceId: newId(),
      world: "shop",
    });
    expect(r.status).toBe(201);
  });
});

/** server.ts を別のプロセスで起動する（標準出力の1行1JSON を集める） */
function startServer(env: Record<string, string>): { child: ChildProcess; lines: () => Array<Record<string, unknown>>; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [SERVER_TS], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d: Buffer) => {
    out += d.toString("utf8");
  });
  child.stderr?.on("data", (d: Buffer) => {
    out += d.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const lines = () =>
    out
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { child, lines, exited };
}

async function waitFor<T>(fn: () => T | undefined, ms: number): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error("待ちきれなかった");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("server.ts（SO §3.1.3：足りなければ起動しない）", () => {
  it("共有トークン INTERNAL_SHARED_TOKEN がない・短ければ exit 1。足りない変数の名前だけを出す", async () => {
    const s = startServer({ INTERNAL_SHARED_TOKEN: "short-secret" });
    expect(await s.exited).toBe(1);
    const refused = s.lines().find((l) => l.event === "sim.startup_refused");
    expect(refused).toMatchObject({ severity: "CRITICAL", missing: ["INTERNAL_SHARED_TOKEN"], service: "sim-world" });
    expect(JSON.stringify(s.lines())).not.toContain("short-secret");
  }, 30_000);

  it("DATABASE_URL がなければメモリの保存で起動し /healthz に答える（SIGTERM で止まる）", async () => {
    const s = startServer({ INTERNAL_SHARED_TOKEN: "t".repeat(40), PORT: "0", COMMIT_SHA: "c0ffee" });
    try {
      const listening = await waitFor(() => s.lines().find((l) => l.event === "sim.listening"), 20_000);
      expect(listening).toMatchObject({ store: "memory" });
      const res = await fetch(`http://127.0.0.1:${String(listening.port)}/healthz`);
      expect(await res.json()).toEqual({ status: "ok", service: "sim-world", commit: "c0ffee" });
    } finally {
      s.child.kill("SIGTERM");
    }
    expect(await s.exited).toBe(0);
  }, 30_000);

  describe("DATABASE_URL があれば Postgres の保存（docker compose の db）", () => {
    const T = useTestDb();

    it("止めて起動し直しても、デモ店舗と注文が残る（インスタンスをまたいで同じ状態）", async () => {
      const { db, url } = T();
      const ws = await fxWorkspace(db);
      const token = "p".repeat(40);
      const auth = createServiceAuth({ sharedToken: token });
      const env = { INTERNAL_SHARED_TOKEN: token, PORT: "0", DATABASE_URL: url };
      const run = async <R>(fn: (base: string) => Promise<R>): Promise<R> => {
        const s = startServer(env);
        try {
          const listening = await waitFor(() => s.lines().find((l) => l.event === "sim.listening"), 20_000);
          expect(listening).toMatchObject({ store: "postgres" });
          return await fn(`http://127.0.0.1:${String(listening.port)}`);
        } finally {
          s.child.kill("SIGTERM");
          expect(await s.exited).toBe(0);
        }
      };
      const appHeaders = { ...(await auth.serviceAuthHeaders("sa-app", "http://sim.local")), "content-type": "application/json" };
      const first = await run(async (base) => {
        const r = await fetch(`${base}/admin/v1/demo-store`, { method: "POST", headers: appHeaders, body: JSON.stringify({ workspaceId: ws.workspaceId, world: "shop" }) });
        expect(r.status).toBe(201);
        const demo = ((await r.json()) as { execution: { id: string } }).execution;
        const client = await connectMcp({ base }, "/mcp/shop/supplier", {
          ...(await auth.serviceAuthHeaders("sa-gateway", base)),
          ...simHeaders({ workspaceId: ws.workspaceId, taskId: newId() }),
        });
        try {
          await client.callTool({ name: "place_order", arguments: BEANS_20 });
        } finally {
          await client.close();
        }
        return demo.id;
      });
      await run(async (base) => {
        const again = await fetch(`${base}/admin/v1/demo-store`, { method: "POST", headers: appHeaders, body: JSON.stringify({ workspaceId: ws.workspaceId, world: "shop" }) });
        expect(again.status).toBe(200);
        expect(((await again.json()) as { execution: { id: string } }).execution.id).toBe(first);
        const got = await fetch(`${base}/admin/v1/executions/${first}?workspaceId=${ws.workspaceId}`, { headers: appHeaders });
        const body = (await got.json()) as { execution: { version: number }; state: { orders: unknown[] }; events: unknown[] };
        expect(body.execution.version).toBe(2);
        expect(body.state.orders).toHaveLength(1);
        expect(body.events).toHaveLength(1);
      });
    }, 60_000);
  });
});
