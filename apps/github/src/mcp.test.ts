import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GITHUB_HEADER, GITHUB_TOOL_DESCRIPTIONS, GITHUB_TOOL_INPUT_SCHEMAS, GITHUB_TOOL_NAMES } from "@open-team/github-core";
import { CALL_HEADERS, GATEWAY, GH_TOKEN, INTENT, REPO, connectMcp, fakeGithub, json, setup } from "./test-helpers.ts";
import { overallOf } from "./tools.ts";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function mcp(app: Parameters<typeof connectMcp>[0], headers: Record<string, string> = { ...GATEWAY, ...CALL_HEADERS }) {
  const c = await connectMcp(app, headers);
  clients.push(c);
  return c;
}

async function httpStatusOf(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (e) {
    if (e instanceof StreamableHTTPError) return e.code ?? -1;
    throw e;
  }
  throw new Error("失敗するはずの呼び出しが通った");
}

const sc = (r: Awaited<ReturnType<Client["callTool"]>>) => r.structuredContent as Record<string, any>;
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0]!.text;

const PUSH = { repo: REPO, branch: "makase/fix-readme", message: "README の誤字を直す", files: [{ path: "README.md", content: "# app\n直した\n" }] };

describe("tools/list（18 §3.2。ヘッダーなしで答える）", () => {
  it("7つのツールの名前・説明・入力スキーマ。読むだけのツールには readOnlyHint", async () => {
    const gh = fakeGithub();
    const { app } = setup(gh);
    const c = await mcp(app, GATEWAY);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual([...GITHUB_TOOL_NAMES]);
    for (const t of tools) {
      const name = t.name as keyof typeof GITHUB_TOOL_DESCRIPTIONS;
      expect(t.description).toBe(GITHUB_TOOL_DESCRIPTIONS[name]);
      expect(t.inputSchema).toEqual(GITHUB_TOOL_INPUT_SCHEMAS[name]);
      expect(t.annotations?.readOnlyHint).toBe(name === "push_commit" || name === "create_pull_request" ? undefined : true);
    }
    expect(gh.calls).toHaveLength(0);
  });
});

describe("ヘッダー", () => {
  it("トークンが無い tools/call は 401（GitHub は呼ばない）", async () => {
    const gh = fakeGithub();
    const { app } = setup(gh);
    const c = await mcp(app, GATEWAY);
    expect(await httpStatusOf(c.callTool({ name: "list_repos", arguments: {} }))).toBe(401);
    expect(gh.calls).toHaveLength(0);
  });

  it("push_commit は Intent の ID が要る（無ければ 401）", async () => {
    const gh = fakeGithub();
    const { app } = setup(gh);
    const c = await mcp(app, { ...GATEWAY, [GITHUB_HEADER.token]: GH_TOKEN });
    expect(await httpStatusOf(c.callTool({ name: "push_commit", arguments: PUSH }))).toBe(401);
  });

  it("GitHub へはトークンを Bearer で渡し、ログにトークンを出さない", async () => {
    const gh = fakeGithub();
    const { app, lines } = setup(gh);
    const c = await mcp(app);
    await c.callTool({ name: "list_repos", arguments: {} });
    expect(gh.calls[0]!.headers.get("authorization")).toBe(`Bearer ${GH_TOKEN}`);
    expect(lines.join("\n")).not.toContain(GH_TOKEN);
  });

  it.each([
    ["401", () => json(401, {}), 401],
    ["502", () => json(502, {}), 502],
    ["レート制限の 403", () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }), 429],
  ] as const)("GitHub の %s → HTTP の失敗（%#）", async (_label, res, want) => {
    const { app } = setup(fakeGithub(() => res()));
    const c = await mcp(app);
    expect(await httpStatusOf(c.callTool({ name: "list_repos", arguments: {} }))).toBe(want);
  });
});

describe("読み取り", () => {
  it("list_repos・list_files・read_file・list_issues", async () => {
    const { app } = setup(fakeGithub());
    const c = await mcp(app);
    expect(sc(await c.callTool({ name: "list_repos", arguments: {} })).repos).toEqual([{ repo: REPO, default_branch: "main", private: true, description: "テスト" }]);
    const files = sc(await c.callTool({ name: "list_files", arguments: { repo: REPO, path: "src" } }));
    expect(files.ref).toBe("main");
    expect(files.files).toEqual([{ path: "src/index.js", size: 15 }]);
    const file = sc(await c.callTool({ name: "read_file", arguments: { repo: REPO, path: "README.md" } }));
    expect(file.content).toBe("# app\n");
    const dir = await c.callTool({ name: "read_file", arguments: { repo: REPO, path: "src" } });
    expect(dir.isError).toBe(true);
    const issues = sc(await c.callTool({ name: "list_issues", arguments: { repo: REPO } })).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ number: 1, labels: ["bug"], author: "u" });
  });

  it("read_file はリポジトリの外を指すパスを受けない", async () => {
    const gh = fakeGithub();
    const { app } = setup(gh);
    const c = await mcp(app);
    for (const path of ["../x", "/etc/passwd", ".git/config", "a/../b"]) {
      const r = await c.callTool({ name: "read_file", arguments: { repo: REPO, path } });
      expect(r.isError).toBe(true);
    }
    expect(gh.calls).toHaveLength(0);
  });

  it("CI のまとめ", () => {
    const ok = { state: "success", statuses: [] };
    expect(overallOf([], ok)).toBe("none");
    expect(overallOf([{ status: "completed", conclusion: "success" }], ok)).toBe("success");
    expect(overallOf([{ status: "in_progress", conclusion: null }], ok)).toBe("pending");
    expect(overallOf([{ status: "completed", conclusion: "failure" }, { status: "in_progress", conclusion: null }], ok)).toBe("failure");
    expect(overallOf([], { state: "error", statuses: [{}] })).toBe("failure");
  });
});

describe("push_commit（18 §2-5・§2-6）", () => {
  it("新しいブランチを既定のブランチから作ってコミットを積む（Intent の印つき・main は変わらない）", async () => {
    const gh = fakeGithub();
    const { app } = setup(gh);
    const c = await mcp(app);
    const r = await c.callTool({ name: "push_commit", arguments: PUSH });
    expect(r.isError).toBeFalsy();
    expect(sc(r)).toMatchObject({ repo: REPO, branch: PUSH.branch, created_branch: true, files_written: 1, files_deleted: 0 });
    expect(gh.filesAt(PUSH.branch)?.["README.md"]).toBe("# app\n直した\n");
    expect(gh.filesAt("main")?.["README.md"]).toBe("# app\n");
    const commit = gh.commits.get(gh.branches.get(PUSH.branch)!)!;
    expect(commit.message).toBe(`README の誤字を直す\n\nMakase-Intent: ${INTENT}`);
    expect(commit.parents).toEqual(["base0001"]);
  });

  it("再送（同じ Intent）は2つ目のコミットを作らず、成功として返す", async () => {
    const gh = fakeGithub();
    const { app } = setup(gh);
    const c = await mcp(app);
    const first = sc(await c.callTool({ name: "push_commit", arguments: PUSH }));
    const again = await c.callTool({ name: "push_commit", arguments: PUSH });
    expect(again.isError).toBeFalsy();
    expect(sc(again)).toMatchObject({ commit_sha: first.commit_sha, already_existed: true });
    expect(gh.calls.filter((x) => x.method === "POST" && x.path.endsWith("/git/commits"))).toHaveLength(1);
  });

  it("別の Intent なら、あるブランチに早送りで積み、ファイルを消せる", async () => {
    const gh = fakeGithub();
    const { app } = setup(gh);
    await (await mcp(app)).callTool({ name: "push_commit", arguments: PUSH });
    const c2 = await mcp(app, { ...GATEWAY, ...CALL_HEADERS, [GITHUB_HEADER.idempotencyKey]: "11111111-2222-3333-4444-555555555555" });
    const r = await c2.callTool({ name: "push_commit", arguments: { repo: REPO, branch: PUSH.branch, message: "消す", delete_paths: ["src/index.js"] } });
    expect(sc(r)).toMatchObject({ created_branch: false, files_deleted: 1 });
    expect(gh.filesAt(PUSH.branch)).toEqual({ "README.md": "# app\n直した\n" });
    const patch = gh.calls.find((x) => x.method === "PATCH")!;
    expect(patch.body.force).toBe(false);
  });

  it("main・master・既定のブランチへは、許可が無ければ書かない（GitHub に書き込みを送らない）", async () => {
    const gh = fakeGithub();
    const { app } = setup(gh);
    const c = await mcp(app);
    for (const branch of ["main", "master"]) {
      const r = await c.callTool({ name: "push_commit", arguments: { ...PUSH, branch } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("保護したブランチ");
    }
    expect(gh.calls.filter((x) => x.method !== "GET")).toHaveLength(0);
    expect(gh.filesAt("main")?.["README.md"]).toBe("# app\n");
  });

  it("許可の頭が \"true\" のときだけ main に積める", async () => {
    const gh = fakeGithub();
    const { app } = setup(gh);
    const denied = await mcp(app, { ...GATEWAY, ...CALL_HEADERS, [GITHUB_HEADER.allowProtectedWrite]: "yes" });
    expect((await denied.callTool({ name: "push_commit", arguments: { ...PUSH, branch: "main" } })).isError).toBe(true);
    const allowed = await mcp(app, { ...GATEWAY, ...CALL_HEADERS, [GITHUB_HEADER.allowProtectedWrite]: "true" });
    const r = await allowed.callTool({ name: "push_commit", arguments: { ...PUSH, branch: "main" } });
    expect(r.isError).toBeFalsy();
    expect(gh.filesAt("main")?.["README.md"]).toBe("# app\n直した\n");
  });

  it("ブランチの名前・パスの誤り、空の変更は入力の誤り", async () => {
    const gh = fakeGithub();
    const { app } = setup(gh);
    const c = await mcp(app);
    for (const args of [
      { ...PUSH, branch: "refs/heads/main" },
      { ...PUSH, branch: "a..b" },
      { ...PUSH, files: [{ path: "../x", content: "" }] },
      { ...PUSH, files: [] },
      { ...PUSH, delete_paths: ["README.md"] },
    ]) {
      expect((await c.callTool({ name: "push_commit", arguments: args })).isError).toBe(true);
    }
    expect(gh.calls).toHaveLength(0);
  });

  it("早送りできない（先に進んだ）ときは、やり直すよう返す", async () => {
    const gh = fakeGithub((call) => (call.method === "POST" && call.path.endsWith("/git/refs") ? json(422, { message: "Reference already exists" }) : null));
    const { app } = setup(gh);
    const r = await (await mcp(app)).callTool({ name: "push_commit", arguments: PUSH });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("もう一度");
  });
});

describe("create_pull_request", () => {
  it("PR を出す（base の省略は既定のブランチ）。同じ head・base の開いた PR があればそれを返す", async () => {
    const gh = fakeGithub();
    const { app } = setup(gh);
    const c = await mcp(app);
    await c.callTool({ name: "push_commit", arguments: PUSH });
    const args = { repo: REPO, head: PUSH.branch, title: "README の誤字を直す", body: "直しました", draft: true };
    const first = sc(await c.callTool({ name: "create_pull_request", arguments: args }));
    expect(first).toMatchObject({ number: 1, base: "main", head: PUSH.branch, draft: true });
    const again = sc(await c.callTool({ name: "create_pull_request", arguments: args }));
    expect(again).toMatchObject({ number: 1, already_existed: true });
    expect(gh.pulls).toHaveLength(1);
  });

  it("head と base が同じなら出さない", async () => {
    const { app } = setup(fakeGithub());
    const r = await (await mcp(app)).callTool({ name: "create_pull_request", arguments: { repo: REPO, head: "main", title: "x" } });
    expect(r.isError).toBe(true);
  });

  it("GitHub が受け付けない（422）ときは、その理由を添えて結果で返す", async () => {
    const { app } = setup(fakeGithub());
    const r = await (await mcp(app)).callTool({ name: "create_pull_request", arguments: { repo: REPO, head: "nothing", title: "x" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("422：Validation Failed");
  });
});

describe("呼び出し元の確認（sa-gateway だけ）", () => {
  it("共有トークンが無い・違う呼び出しは 403、GET は 405", async () => {
    const { app } = setup(fakeGithub());
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await app.request("/mcp/github", { method: "POST", headers, body })).status).toBe(403);
    expect((await app.request("/mcp/github", { method: "POST", headers: { ...headers, ...GATEWAY, authorization: "Bearer wrong-token-0123456789abcdef0123" }, body })).status).toBe(403);
    expect((await app.request("/mcp/github", { method: "GET", headers: { ...GATEWAY } })).status).toBe(405);
    expect((await app.request("/healthz")).status).toBe(200);
  });
});
