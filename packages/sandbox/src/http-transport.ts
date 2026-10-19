// 本番の作業場から sandbox-edge（app の /sandbox/v1）への口。トークンは Bearer で送る（作業場だけのもの）

import type { ClaimResponse, CommandResult, NextResponse, SandboxTransport } from "./protocol.ts";

export class SandboxHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SandboxHttpError";
    this.status = status;
  }
}

export function httpTransport(o: { baseUrl: string; token: string; fetch?: typeof fetch }): SandboxTransport {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, "");
  const call = async (method: string, p: string, body?: unknown, raw?: Buffer, timeoutMs = 60_000): Promise<unknown> => {
    const headers: Record<string, string> = { authorization: `Bearer ${o.token}` };
    if (raw !== undefined) headers["content-type"] = "application/gzip";
    else if (body !== undefined) headers["content-type"] = "application/json";
    const res = await f(`${base}/sandbox/v1${p}`, {
      method,
      headers,
      ...(raw !== undefined ? { body: new Uint8Array(raw) } : body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new SandboxHttpError(res.status, `sandbox-edge ${method} ${p} → ${res.status}`);
    const text = await res.text();
    return text === "" ? null : JSON.parse(text);
  };
  return {
    claim: async () => (await call("POST", "/claim", {})) as ClaimResponse,
    next: async (waitSec) => (await call("POST", "/next", { waitSec }, undefined, (waitSec + 30) * 1000)) as NextResponse,
    result: async (commandId, r: CommandResult) => {
      await call("POST", `/commands/${encodeURIComponent(commandId)}/result`, r);
    },
    archive: async (archive, meta) => {
      await call("PUT", `/archive?files=${meta.files}&bytes=${meta.bytes}`, undefined, archive);
    },
  };
}
