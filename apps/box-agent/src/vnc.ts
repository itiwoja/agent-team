import type { IncomingMessage, Server } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, createWebSocketStream } from "ws";
import type { AuthorizationFailure } from "./auth.ts";

const MAX_FRAME = 1024 * 1024;

function rejectUpgrade(socket: Duplex, status: number): void {
  const reason = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Bad Request";
  // 相手がFINを返さなくても、拒否応答を送信し終えたら半開き接続を回収する。
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function attachVnc(
  server: Server,
  authorize: (request: IncomingMessage) => AuthorizationFailure | undefined,
  port: number,
): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid VNC configuration");
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  const upstreams = new Set<ReturnType<typeof connect>>();
  server.on("upgrade", (request, socket, head) => {
    // upgrade完了前にHTTPと同じ認証を必ず適用する。
    socket.on("error", () => socket.destroy());
    const denied = authorize(request);
    if (denied) {
      rejectUpgrade(socket, denied.status);
      return;
    }
    if (request.url?.includes("?")) {
      rejectUpgrade(socket, 400);
      return;
    }
    if (request.method !== "GET" || request.url !== "/vnc") {
      rejectUpgrade(socket, 404);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      // 接続先は固定loopbackだけ。要求からhost/portを取らない。
      const upstream = connect({ host: "127.0.0.1", port });
      upstreams.add(upstream);
      // streamのmessage listenerより先に不正なtextフレームを止める。
      ws.on("message", (_data, binary) => {
        if (!binary) stop();
      });
      const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
      const stop = (): void => {
        upstream.destroy();
        stream.destroy();
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      };
      ws.on("error", stop);
      ws.on("close", stop);
      stream.on("error", stop);
      upstream.on("error", stop);
      upstream.on("close", () => {
        upstreams.delete(upstream);
        stop();
      });
      upstream.setTimeout(30_000, stop);
      upstream.once("connect", () => {
        upstream.setTimeout(0);
        // 双方向のpipeがwrite/drainに追従し、遅い相手への無制限な蓄積を避ける。
        stream.pipe(upstream);
        upstream.pipe(stream);
      });
    });
  });
  // HTTPのcloseイベントはupgrade済みsocketが閉じるまで来ない。
  // 終了要求の時点で中継を止めないと、server.close()が待ち続ける。
  const close = server.close;
  server.close = function (callback) {
    for (const upstream of upstreams) upstream.destroy();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    close.call(this, callback);
    return this;
  };
}
