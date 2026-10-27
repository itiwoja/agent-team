import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createAuthorize } from "./auth.ts";
import { parseActionRequest, ValidationError } from "./protocol.ts";
import type { BrowserBackend } from "./protocol.ts";
import { attachVnc } from "./vnc.ts";

const BODY_LIMIT = 32 * 1024;

interface Reply {
  status: number;
  body: string;
}

function errorReply(status: number, code: string): Reply {
  return { status, body: JSON.stringify({ error: { code } }) };
}

function send(response: ServerResponse, reply: Reply): void {
  response.writeHead(reply.status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(reply.body);
}

class BodyTooLarge extends Error {}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const length = Number(request.headers["content-length"] ?? 0);
    if (length > BODY_LIMIT) {
      request.resume();
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    request.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        failed = true;
        chunks.length = 0;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      if (failed) return;
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        resolve(value);
      } catch {
        reject(new ValidationError());
      }
    });
    request.once("error", () => reject(new ValidationError()));
    request.once("aborted", () => reject(new ValidationError()));
  });
}

export interface AgentServerOptions {
  token: string;
  controlEpoch: number;
  backend: BrowserBackend;
  vncPort?: number;
  maxActions?: number;
  maxResultBytes?: number;
}

export function createAgentServer(options: AgentServerOptions): Server {
  const { backend, controlEpoch, vncPort = 5900, maxActions = 1000, maxResultBytes = 32 * 1024 * 1024 } = options;
  if (!Number.isSafeInteger(controlEpoch) || controlEpoch < 0 || !Number.isSafeInteger(maxActions) || maxActions < 1
    || !Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1) {
    throw new Error("Invalid agent configuration");
  }
  const authorize = createAuthorize(options.token);
  // 世代中は追い出さない。失敗・進行中も予約してから実行し、同時再送も1回にする。
  const actions = new Map<string, { fingerprint: string; result: Promise<Reply> }>();
  let resultBytes = 0;
  let tail: Promise<void> = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const denied = authorize(request);
    if (denied) {
      response.setHeader("connection", "close");
      send(response, errorReply(denied.status, denied.code));
      return;
    }
    // クエリによる資格の受け渡しを含め、この内部口にはクエリがない。
    if (request.url?.includes("?")) {
      send(response, errorReply(400, "VALIDATION_ERROR"));
      return;
    }
    if (request.method === "GET" && request.url === "/healthz") {
      const ready = backend.ready();
      send(response, { status: ready ? 200 : 503, body: JSON.stringify({ ready, sandboxEnabled: backend.sandboxEnabled }) });
      return;
    }
    if (request.method === "GET" && request.url === "/screenshot") {
      if (!backend.ready()) {
        send(response, errorReply(503, "NOT_READY"));
        return;
      }
      const png = await enqueue(async () => {
        if (!backend.ready()) throw new Error("Backend unavailable");
        return backend.screenshot();
      });
      response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(png);
      return;
    }
    if (request.method !== "POST" || request.url !== "/actions") {
      send(response, errorReply(404, "NOT_FOUND"));
      return;
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
      response.setHeader("connection", "close");
      send(response, errorReply(400, "VALIDATION_ERROR"));
      return;
    }
    const input = parseActionRequest(await readBody(request));
    // キャッシュ、準備状態、容量より先にepochを確認する。
    if (input.controlEpoch !== controlEpoch) {
      send(response, errorReply(409, "STALE_CONTROL"));
      return;
    }
    // 検証後の固定順のキーをハッシュ化し、順序/空白の違いは同じ操作とする。
    const fingerprint = createHash("sha256").update(JSON.stringify(input.action)).digest("hex");
    const previous = actions.get(input.actionId);
    if (previous) {
      send(response, previous.fingerprint === fingerprint ? await previous.result : errorReply(409, "ACTION_CONFLICT"));
      return;
    }
    if (actions.size >= maxActions || resultBytes >= maxResultBytes) {
      send(response, errorReply(503, "ACTION_CAPACITY"));
      return;
    }
    if (!backend.ready()) {
      send(response, errorReply(503, "NOT_READY"));
      return;
    }
    const result = enqueue(async (): Promise<Reply> => {
      let reply: Reply;
      try {
        // 受付時には空きがあっても、先行操作の画像で満杯になりうる。
        // 1操作の結果による超過は許すが、後続のbackend実行は止める。
        if (resultBytes >= maxResultBytes) reply = errorReply(503, "ACTION_CAPACITY");
        else if (!backend.ready()) reply = errorReply(503, "NOT_READY");
        else reply = { status: 200, body: JSON.stringify(await backend.execute(input.action)) };
      } catch {
        // 部分実行後の失敗も保存する。例外にはURL・入力・資格が含まれうる。
        reply = errorReply(500, "ACTION_FAILED");
      }
      // 次のキューが動く前に、保存する成功/失敗の本文をUTF-8バイトで計上する。
      // 再送時はこの処理を通らず、GETスクショも保存しないので対象外。
      resultBytes += Buffer.byteLength(reply.body, "utf8");
      return reply;
    });
    actions.set(input.actionId, { fingerprint, result });
    send(response, await result);
  }

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 }, (request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.destroyed || response.headersSent) return;
      response.setHeader("connection", "close");
      send(response, error instanceof BodyTooLarge
        ? errorReply(413, "BODY_TOO_LARGE")
        : error instanceof ValidationError
          ? errorReply(400, "VALIDATION_ERROR")
          : errorReply(500, "INTERNAL_ERROR"));
    });
  });
  attachVnc(server, authorize, vncPort);
  return server;
}
