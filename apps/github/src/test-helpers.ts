// 試験用の道具（index からは出さない）。偽の GitHub（メモリの中のリポジトリ1つ）と、MCP のクライアント SDK をアプリにつなぐ

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GITHUB_HEADER } from "@open-team/github-core";
import { CALLER_HEADER, memoryLogger } from "@open-team/platform";
import { createApp, type GithubDeps } from "./app.ts";
import type { GithubEnv } from "./env.ts";

export const LOCAL_TOKEN = "local-shared-token-for-tests-0123456789";
export const GH_TOKEN = "ghs_testinstallationtoken0123456789abcdef";
export const API_BASE = "https://api.github.test";
export const REPO = "octo/app";
export const INTENT = "01234567-89ab-cdef-0123-456789abcdef";

export const LOCAL_ENV: GithubEnv = {
  deploymentMode: "local",
  port: 0,
  sharedToken: LOCAL_TOKEN,
  selfUrl: undefined,
  gatewaySaEmail: undefined,
  githubApiBase: API_BASE,
  commitSha: "0123abc",
};

export const GATEWAY = { authorization: `Bearer ${LOCAL_TOKEN}`, [CALLER_HEADER]: "sa-gateway" } as const;
/** tools/call のヘッダー（gateway が作るもの）。保護したブランチへの書き込みは許していない */
export const CALL_HEADERS: Record<string, string> = {
  [GITHUB_HEADER.token]: GH_TOKEN,
  [GITHUB_HEADER.idempotencyKey]: INTENT,
};

export interface FakeCall {
  method: string;
  path: string;
  url: URL;
  headers: Headers;
  body: any;
}

interface Commit {
  sha: string;
  message: string;
  tree: string;
  parents: string[];
  files: Record<string, string>;
}

/**
 * 偽の GitHub：リポジトリ octo/app（既定のブランチ main）。ブランチ・コミット・ツリー・PR をメモリに持つ。
 * override で特定の呼び出しの応答を差し替える（null を返すと既定の動き）
 */
export function fakeGithub(override: (call: FakeCall) => Response | null = () => null) {
  const calls: FakeCall[] = [];
  let n = 0;
  const sha = () => `sha${String(++n).padStart(4, "0")}`;
  const root: Commit = { sha: "base0001", message: "最初のコミット", tree: "tree0001", parents: [], files: { "README.md": "# app\n", "src/index.js": "console.log(1)\n" } };
  const commits = new Map<string, Commit>([[root.sha, root]]);
  const trees = new Map<string, Record<string, string>>([[root.tree, root.files]]);
  const branches = new Map<string, string>([["main", root.sha]]);
  const pulls: Array<{ number: number; head: string; base: string; html_url: string; draft: boolean; state: string; title: string }> = [];

  const route = (c: FakeCall): Response => {
    const p = c.path;
    const repo = `/repos/${REPO}`;
    if (c.method === "GET" && p === "/installation/repositories") {
      return json(200, { total_count: 1, repositories: [{ full_name: REPO, default_branch: "main", private: true, description: "テスト" }] });
    }
    if (c.method === "GET" && p === repo) return json(200, { full_name: REPO, default_branch: "main", private: true, description: null });
    if (!p.startsWith(`${repo}/`)) return json(404, { message: "Not Found" });
    const rest = p.slice(repo.length + 1);
    let m: RegExpMatchArray | null;
    if (c.method === "GET" && (m = rest.match(/^git\/ref\/heads\/(.+)$/))) {
      const s = branches.get(decodeURIComponent(m[1]!));
      return s ? json(200, { ref: `refs/heads/${m[1]}`, object: { sha: s } }) : json(404, { message: "Not Found" });
    }
    if (c.method === "GET" && (m = rest.match(/^git\/commits\/(.+)$/))) {
      const cm = commits.get(m[1]!);
      return cm ? json(200, { sha: cm.sha, message: cm.message, tree: { sha: cm.tree }, html_url: `https://github.test/${REPO}/commit/${cm.sha}` }) : json(404, {});
    }
    if (c.method === "GET" && (m = rest.match(/^git\/trees\/(.+)$/))) {
      const ref = decodeURIComponent(m[1]!);
      const cm = commits.get(branches.get(ref) ?? ref);
      if (!cm) return json(404, { message: "Not Found" });
      return json(200, { tree: Object.entries(cm.files).map(([path, v]) => ({ path, type: "blob", size: v.length, sha: "x" })), truncated: false });
    }
    if (c.method === "POST" && rest === "git/trees") {
      const base = { ...(trees.get(c.body.base_tree) ?? {}) };
      for (const e of c.body.tree) {
        if (e.sha === null) {
          if (!(e.path in base)) return json(422, { message: "GitRPC::BadObjectState" });
          delete base[e.path];
        } else base[e.path] = e.content;
      }
      const t = `tree${sha()}`;
      trees.set(t, base);
      return json(201, { sha: t });
    }
    if (c.method === "POST" && rest === "git/commits") {
      const s = sha();
      commits.set(s, { sha: s, message: c.body.message, tree: c.body.tree, parents: c.body.parents, files: trees.get(c.body.tree) ?? {} });
      return json(201, { sha: s, message: c.body.message, tree: { sha: c.body.tree }, html_url: `https://github.test/${REPO}/commit/${s}` });
    }
    if (c.method === "POST" && rest === "git/refs") {
      const name = String(c.body.ref).replace(/^refs\/heads\//, "");
      if (branches.has(name)) return json(422, { message: "Reference already exists" });
      branches.set(name, c.body.sha);
      return json(201, {});
    }
    if (c.method === "PATCH" && (m = rest.match(/^git\/refs\/heads\/(.+)$/))) {
      const name = decodeURIComponent(m[1]!);
      const cur = branches.get(name);
      const next = commits.get(c.body.sha);
      if (!cur || !next) return json(422, { message: "Reference does not exist" });
      if (c.body.force !== false || !next.parents.includes(cur)) return json(422, { message: "Update is not a fast forward" });
      branches.set(name, c.body.sha);
      return json(200, {});
    }
    if (c.method === "GET" && (m = rest.match(/^contents\/(.+)$/))) {
      const path = decodeURIComponent(m[1]!);
      const ref = c.url.searchParams.get("ref") ?? "main";
      const cm = commits.get(branches.get(ref) ?? ref);
      const content = cm?.files[path];
      if (content === undefined) {
        if (cm && Object.keys(cm.files).some((f) => f.startsWith(`${path}/`))) return json(200, [{ type: "file" }]);
        return json(404, { message: "Not Found" });
      }
      return json(200, { type: "file", encoding: "base64", content: Buffer.from(content).toString("base64"), size: content.length, sha: "blob1", path });
    }
    if (c.method === "GET" && rest === "pulls") {
      const head = c.url.searchParams.get("head")?.split(":")[1];
      const base = c.url.searchParams.get("base");
      return json(200, pulls.filter((x) => x.head === head && x.base === base && x.state === "open"));
    }
    if (c.method === "POST" && rest === "pulls") {
      if (!branches.has(c.body.head)) return json(422, { message: "Validation Failed" });
      const pr = { number: pulls.length + 1, head: c.body.head, base: c.body.base, html_url: `https://github.test/${REPO}/pull/${pulls.length + 1}`, draft: c.body.draft, state: "open", title: c.body.title };
      pulls.push(pr);
      return json(201, pr);
    }
    if (c.method === "GET" && rest === "issues") {
      return json(200, [
        { number: 1, title: "直して", state: "open", body: "README の誤字", html_url: "https://github.test/i/1", labels: [{ name: "bug" }], user: { login: "u" } },
        { number: 2, title: "PR", state: "open", body: "", html_url: "https://github.test/p/2", pull_request: {} },
      ]);
    }
    return json(404, { message: "Not Found" });
  };

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call: FakeCall = { method: init?.method ?? "GET", path: url.pathname, url, headers: new Headers(init?.headers), body };
    calls.push(call);
    return override(call) ?? route(call);
  }) as typeof fetch;
  return { fetch: fetchFn, calls, branches, commits, pulls, filesAt: (branch: string) => commits.get(branches.get(branch) ?? "")?.files ?? null };
}

export function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function setup(github: { fetch: typeof fetch }, deps: Partial<GithubDeps> = {}, env: GithubEnv = LOCAL_ENV) {
  const { logger, lines } = memoryLogger({ commit: "0123abc" });
  const app = createApp(env, { fetch: github.fetch, log: logger, ...deps });
  return { app, lines };
}

type AppLike = { request: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response> };

/** MCP のクライアント SDK をアプリにつなぐ（initialize まで済ませる） */
export async function connectMcp(app: AppLike, headers: Record<string, string>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://github.test/mcp/github"), {
    requestInit: { headers },
    fetch: (input: string | URL, init?: RequestInit) => Promise.resolve(app.request(input, init)),
  });
  const client = new Client({ name: "test-gateway", version: "0.0.0" });
  await client.connect(transport);
  return client;
}
