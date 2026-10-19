import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CALLER_HEADER, GCAL_CALLERS } from "./auth.ts";
import { serviceAuthConfigOf } from "./env.ts";
import { CALL_HEADERS, GATEWAY, LOCAL_ENV, LOCAL_TOKEN, connectMcp, fakeGoogle, setup } from "./test-helpers.ts";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

/** 認証の結果：接続（initialize）が通れば 200、拒否なら HTTP の状態コード */
async function statusWith(app: Parameters<typeof connectMcp>[0], headers: Record<string, string>): Promise<number> {
  try {
    const c = await connectMcp(app, headers);
    clients.push(c);
    return 200;
  } catch (e) {
    if (e instanceof StreamableHTTPError) return e.code ?? -1;
    throw e;
  }
}

describe("呼び出し元の確認（16 §3.2：sa-gateway だけ）", () => {
  it("設定：呼べるのは sa-gateway だけ。認証は共有トークン", () => {
    expect(GCAL_CALLERS).toEqual(["sa-gateway"]);
    expect(serviceAuthConfigOf(LOCAL_ENV)).toEqual({ sharedToken: LOCAL_TOKEN });
  });

  it("共有トークン＋ sa-gateway は通る。sa-app・名前なし・トークン違いは 403", async () => {
    const { app } = setup(fakeGoogle(() => new Response(null, { status: 500 })));
    expect(await statusWith(app, GATEWAY)).toBe(200);
    expect(await statusWith(app, { authorization: `Bearer ${LOCAL_TOKEN}`, [CALLER_HEADER]: "sa-app" })).toBe(403);
    expect(await statusWith(app, { authorization: `Bearer ${LOCAL_TOKEN}` })).toBe(403);
    expect(await statusWith(app, { authorization: "Bearer wrong-token-0123456789-0123456789", [CALLER_HEADER]: "sa-gateway" })).toBe(403);
  });

  it("GET・DELETE は 405（認証の後）。/healthz は認証なし", async () => {
    const { app } = setup(fakeGoogle(() => new Response(null, { status: 500 })));
    expect((await app.request("http://gcal.test/mcp/gcal", { method: "GET", headers: GATEWAY })).status).toBe(405);
    expect((await app.request("http://gcal.test/mcp/gcal", { method: "DELETE", headers: GATEWAY })).status).toBe(405);
    expect((await app.request("http://gcal.test/mcp/gcal", { method: "GET" })).status).toBe(403);
    const health = await app.request("http://gcal.test/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", service: "gcal", commit: "0123abc" });
  });

  it("tools/call の CALL_HEADERS は確かめの後に読む（sa-app からは届かない）", async () => {
    const { app } = setup(fakeGoogle(() => new Response(null, { status: 500 })));
    expect(await statusWith(app, { ...CALL_HEADERS, [CALLER_HEADER]: "sa-app", authorization: `Bearer ${LOCAL_TOKEN}` })).toBe(403);
  });
});
