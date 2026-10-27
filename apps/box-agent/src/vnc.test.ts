import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server as HttpServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import type { Server as TcpServer, Socket } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer } from "./server.ts";
import type { BrowserBackend } from "./protocol.ts";

const servers: (HttpServer | TcpServer)[] = [];
const sockets = new Set<Socket>();
const clients = new Set<WebSocket>();
afterEach(async () => {
  for (const client of clients) client.terminate();
  clients.clear();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function listen(server: HttpServer | TcpServer): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return address.port;
}

async function fixture() {
  const connections: Socket[] = [];
  const received: Buffer[] = [];
  const greeting = Buffer.from("RFB 003.008\n");
  const tcp = createTcpServer((socket) => {
    sockets.add(socket);
    connections.push(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    socket.write(greeting);
    socket.on("data", (data: Buffer) => { received.push(data); socket.write(data); });
  });
  const vncPort = await listen(tcp);
  const token = randomBytes(32).toString("hex");
  const backend: BrowserBackend = {
    ready: () => true, sandboxEnabled: true,
    execute: async () => ({ executed: true }), screenshot: async () => Buffer.alloc(0),
  };
  const http = createAgentServer({ token, controlEpoch: 0, backend, vncPort });
  const port = await listen(http);
  const base = `ws://127.0.0.1:${port}`;
  function client(path = "/vnc", headers: Record<string, string> = { authorization: `Bearer ${token}` }) {
    const ws = new WebSocket(`${base}${path}`, { headers, handshakeTimeout: 3000 });
    clients.add(ws);
    ws.on("error", () => undefined);
    return ws;
  }
  return { client, connections, received, token, greeting, http, tcp, base };
}

async function denied(client: WebSocket): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    client.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
      client.terminate();
    });
    client.once("open", () => reject(new Error("Unexpected upgrade")));
    client.once("error", reject);
  });
}

describe("VNCの認証と中継", () => {
  it("upgrade前に無資格/別資格/古い資格を拒否しTCPへ接続しない", async () => {
    const f = await fixture();
    const credentials: Record<string, string>[] = [{}, { authorization: `Bearer ${randomBytes(32).toString("hex")}` }, { authorization: `Bearer ${randomBytes(32).toString("hex")}` }];
    for (const headers of credentials) {
      expect(await denied(f.client("/vnc", headers))).toBe(401);
    }
    expect(f.connections).toHaveLength(0);
  });

  it("拒否された相手がFINを返さなくても接続を回収しserver.closeが完了する", async () => {
    const f = await fixture();
    // このHTTPサーバーだけはfinallyで回収し、失敗時もafterEachを待ち続けさせない。
    servers.splice(servers.indexOf(f.http), 1);
    const peers = new Set<Socket>();
    f.http.on("connection", (socket) => peers.add(socket));
    let serverClosed = false;
    f.http.once("close", () => { serverClosed = true; });
    const raw = connect({ host: "127.0.0.1", port: Number(new URL(f.base).port), allowHalfOpen: true });
    raw.on("error", () => undefined);
    let response = "";
    raw.on("data", (data: Buffer) => { response += data.toString("utf8"); });
    try {
      const ended = once(raw, "end", { signal: AbortSignal.timeout(2000) });
      raw.write([
        "GET /vnc HTTP/1.1", `Host: ${new URL(f.base).host}`,
        "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`, "", "",
      ].join("\r\n"));
      await ended;
      expect(response).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
      expect(response.endsWith("\r\n\r\n")).toBe(true);
      // サーバーのFINを受けても、こちらはend/destroyせず送信側を開いたままにする。
      expect(raw.writableEnded).toBe(false);
      const closed = once(f.http, "close", { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
      f.http.close();
      const closeCompleted = await closed;
      const connections = await new Promise<number>((resolve, reject) => {
        f.http.getConnections((error, count) => error ? reject(error) : resolve(count));
      });
      expect({ connections, closeCompleted }).toEqual({ connections: 0, closeCompleted: true });
      expect(f.connections).toHaveLength(0);
    } finally {
      // 修正前の半開きpeerも強制回収する。期限を付け、回帰時もテストをhangさせない。
      const cleanup = serverClosed ? Promise.resolve() : once(f.http, "close", { signal: AbortSignal.timeout(2000) });
      raw.destroy();
      for (const peer of peers) peer.destroy();
      if (f.http.listening) f.http.close();
      await cleanup;
    }
  }, 10_000);

  it("query tokenとOriginを拒否し、パスの誤りも中継しない", async () => {
    const f = await fixture();
    expect(await denied(f.client(`/vnc?token=${f.token}`, {}))).toBe(401);
    expect(await denied(f.client(`/vnc?token=${f.token}`))).toBe(400);
    expect(await denied(f.client("/vnc", { authorization: `Bearer ${f.token}`, origin: "https://example.test" }))).toBe(403);
    expect(await denied(f.client("/healthz"))).toBe(404);
    expect(f.connections).toHaveLength(0);
  });

  it("資格付きはloopbackのRFBを双方向バイナリ中継する", async () => {
    const f = await fixture();
    const ws = f.client();
    const greeting = once(ws, "message");
    await once(ws, "open");
    const [data, binary] = await greeting;
    expect(data).toEqual(f.greeting);
    expect(binary).toBe(true);
    const echo = once(ws, "message");
    const input = Buffer.from([0, 1, 128, 255]);
    ws.send(input);
    expect((await echo)[0]).toEqual(input);
    expect(Buffer.concat(f.received)).toEqual(input);
    expect(f.connections).toHaveLength(1);
  });

  it("クライアント切断でTCPも終了する", async () => {
    const f = await fixture();
    const ws = f.client();
    await once(ws, "message");
    const upstream = f.connections[0];
    if (!upstream) throw new Error("Missing upstream");
    const closed = once(upstream, "close");
    ws.close();
    await closed;
    expect(upstream.destroyed).toBe(true);
  });

  it("TCP切断でWebSocketも終了する", async () => {
    const f = await fixture();
    const ws = f.client();
    await once(ws, "message");
    const closed = once(ws, "close");
    f.connections[0]?.destroy();
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("VNCが待受していないときも例外を漏らさず切断する", async () => {
    const f = await fixture();
    servers.splice(servers.indexOf(f.tcp), 1);
    await new Promise<void>((resolve, reject) => f.tcp.close((error) => error ? reject(error) : resolve()));
    const ws = f.client();
    await once(ws, "close");
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("上限ちょうどのバイナリを分割されたTCPから欠落なく返す", async () => {
    const f = await fixture();
    const ws = f.client();
    await once(ws, "message");
    const input = Buffer.alloc(1024 * 1024, 0x81);
    const chunks: Buffer[] = [];
    let size = 0;
    const echoed = new Promise<void>((resolve) => {
      ws.on("message", (data: Buffer) => {
        chunks.push(data);
        size += data.length;
        if (size === input.length) resolve();
      });
    });
    ws.send(input);
    await echoed;
    expect(Buffer.concat(chunks).equals(input)).toBe(true);
    expect(Buffer.concat(f.received).equals(input)).toBe(true);
  });

  it("HTTPサーバー終了で中継接続も終了する", async () => {
    const f = await fixture();
    const ws = f.client();
    await once(ws, "message");
    const closed = once(ws, "close");
    servers.splice(servers.indexOf(f.http), 1);
    await new Promise<void>((resolve, reject) => f.http.close((error) => error ? reject(error) : resolve()));
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("1MiBを越すフレームを中継せず接続を閉じる", async () => {
    const f = await fixture();
    const ws = f.client();
    await once(ws, "message");
    const closed = once(ws, "close");
    ws.send(Buffer.alloc(1024 * 1024 + 1));
    await closed;
    expect(f.received).toHaveLength(0);
  });

  it("textフレームをRFBへ流さず切断する", async () => {
    const f = await fixture();
    const ws = f.client();
    await once(ws, "message");
    const closed = once(ws, "close");
    ws.send("not-binary");
    await closed;
    expect(f.received).toHaveLength(0);
  });
});
