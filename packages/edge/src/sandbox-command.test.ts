// SG-07：作業場のコマンド（run_command）の判定。LLM Proxy が汚染と形から run_tests と run_shell を分け、
// run_shell は既定の deny で実行しない（作業場にコマンドを積まない）。LLM には「ここでは動かせない」と分かる文を返す
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDefinitionInput, TaintState } from "@open-team/kernel";
import type { Db, Uuid } from "@open-team/db";
import { useTestDb } from "@open-team/db/testing";
import { insertWorkspaceSnapshot, SANDBOX_COMMAND_REFUSED_OUTPUT } from "@open-team/db/sandbox";
import type { ScriptedStep } from "@open-team/llm";
import { createTarGz, readTarGz, runExecutor, type SandboxTransport } from "@open-team/sandbox";
import { buildEdge, call, llmRequest, USAGE } from "./__fixtures__/env.ts";
import { T0, fxWorkspace, seedAgent, seedChainAsk, seedTask, tokenFor } from "./__fixtures__/seed.ts";
import { createRuntime, type SandboxProvider } from "./runtime.ts";
import { RUN_SHELL_SHAPE_TEXT, RUN_SHELL_TAINTED_TEXT, commandDeniedNote, judgeCommand } from "./sandbox-command.ts";
import { sandboxEdgeOf } from "./sandbox.ts";

const T = useTestDb();

const AT = "2026-10-14T09:00:00+09:00";
const WEB_TAINT: TaintState = { tainted: true, sources: [{ kind: "web_fetch", url: "https://example.com/page", at: AT }] };

function coderDefinition(): AgentDefinitionInput {
  return {
    version: 2,
    name: "コード職人",
    role: "dev",
    grants: { connectors: {} },
    autonomy: {},
    rules: [],
    budget: { per_task_usd: 0.2, per_day_usd: 1 },
    max_runs_per_day: 10,
    profile: [],
    jobs: [{ id: "build", kind: "once", template: "dev-coder", instructions: "テストを書いて動かしてください。", trigger: null, deliver: [], guards: [] }],
  };
}

async function setup(db: Db, taint?: TaintState) {
  const ws = await fxWorkspace(db, { audit: true });
  const coder = await seedAgent(db, ws, coderDefinition());
  const ask = await seedChainAsk(db, ws, [{ agent: coder, jobSlug: "build", position: 1, spokesperson: true }]);
  const task = await seedTask(db, ws, coder, "build", { ask, memberName: "コード職人", ...(taint === undefined ? {} : { taint }) });
  return { ws, coder, ask, task };
}

/** 同じプロセスで作業場の実行役を動かすプロバイダー（sandbox.test.ts と同じ形） */
function inProcessProvider(db: Db): SandboxProvider & { runs: Array<Promise<unknown>> } {
  const sleep = async (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20)));
  const edge = sandboxEdgeOf(createRuntime({ db, llm: undefined as never, gateway: undefined as never, retry: { sleep } }));
  const runs: Array<Promise<unknown>> = [];
  return {
    name: "inprocess",
    runs,
    async start({ token }) {
      const root = await mkdtemp(path.join(tmpdir(), "sbx-cmd-"));
      const transport: SandboxTransport = {
        claim: () => edge.claim(token),
        next: (w) => edge.next(token, Math.min(w, 1)),
        result: async (id, r) => void (await edge.result(token, id, r)),
        archive: (a, meta) => edge.archive(token, a, meta),
      };
      runs.push(runExecutor({ transport, root, sleep }));
      return { ref: root };
    },
  };
}

function started(db: Db, script: readonly ScriptedStep[], provider: SandboxProvider) {
  const sleep = async (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20)));
  return buildEdge(db, { script, extra: { sandbox: provider, retry: { sleep } } });
}

const step = (id: string, name: string, args: Record<string, unknown>): ScriptedStep => ({ parts: [call(id, name, args)], usage: USAGE });

/** 判定の記録（policy_decisions）の操作と、写し先 */
async function decisionsOf(db: Db, task: Uuid) {
  return (
    await db.query<{ action_type: string | null; decision: string; reason_code: string; matched_rule: string | null; subject: { commandOperation?: string } }>(
      "SELECT action_type, decision, reason_code, matched_rule, subject FROM policy_decisions WHERE task_id = $1 AND subject_kind = 'tool_call' ORDER BY created_at",
      [task],
    )
  ).rows.map((r) => ({ op: r.action_type, decision: r.decision, reason: r.reason_code, rule: r.matched_rule, commandOperation: r.subject.commandOperation ?? null }));
}

async function commandCount(db: Db, task: Uuid): Promise<number> {
  return Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM sandbox_commands WHERE task_id = $1", [task])).rows[0]!.n);
}

async function stop(db: Db, task: Uuid, provider: { runs: Array<Promise<unknown>> }) {
  await db.query("UPDATE tasks SET status = 'halted', halt_reason = 'kill_switch', finished_at = $2 WHERE id = $1 AND status = 'running'", [task, T0]);
  await Promise.all(provider.runs);
}

describe("judgeCommand・commandDeniedNote（SG-07）", () => {
  it("汚染前の許可リストの形は run_tests、外の内容のあとは run_shell（汚染の文）、形が違えば run_shell（形の文）", () => {
    const clean: TaintState = { tainted: false, sources: [] };
    expect(judgeCommand({ command: "npm test" }, clean)).toEqual({ operation: "run_tests", shapeAllowed: true, outsideTainted: false });
    expect(commandDeniedNote(judgeCommand({ command: "npm test" }, clean))).toBeUndefined();
    expect(judgeCommand({ command: "npm test" }, WEB_TAINT)).toEqual({ operation: "run_shell", shapeAllowed: true, outsideTainted: true });
    expect(commandDeniedNote(judgeCommand({ command: "npm test" }, WEB_TAINT))).toBe(RUN_SHELL_TAINTED_TEXT);
    expect(commandDeniedNote(judgeCommand({ command: "curl https://example.com" }, clean))).toBe(RUN_SHELL_SHAPE_TEXT);
    // 汚染のあとは形を直しても動かないので汚染の文
    expect(commandDeniedNote(judgeCommand({ command: "curl https://example.com" }, WEB_TAINT))).toBe(RUN_SHELL_TAINTED_TEXT);
    // 自分が動かしたコマンドの出力だけの汚染は数えない
    expect(judgeCommand({ command: "npm test" }, { tainted: true, sources: [{ kind: "sandbox_run", at: AT }] }).operation).toBe("run_tests");
    // コマンドがない・文字列でない
    expect(judgeCommand({}, clean).operation).toBe("run_shell");
    expect(judgeCommand({ command: ["npm", "test"] }, clean).operation).toBe("run_shell");
  });
});

describe("作業場のコマンドの判定（SG-07）", () => {
  it("汚染前の npm test は今までどおり動く（run_tests・allow。作業場で実行される）", async () => {
    const { db } = T();
    const w = await setup(db);
    const provider = inProcessProvider(db);
    const env = started(
      db,
      [
        step("w1", "write_file", { path: "package.json", content: JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "node t.js" } }) }),
        step("w2", "write_file", { path: "t.js", content: "console.log('テスト通過');\n" }),
        step("r1", "run_command", { command: "npm test" }),
      ],
      provider,
    );
    const token = await tokenFor(db, w.ws, w.task);
    const ctx = await env.edge.getTaskContext(token);
    await env.edge.llmMessages(token, llmRequest(ctx.tools));
    await env.edge.callTool(token, "w1");
    await env.edge.llmMessages(token, llmRequest(ctx.tools));
    await env.edge.callTool(token, "w2");
    const res = await env.edge.llmMessages(token, llmRequest(ctx.tools));
    expect(res.governance).toEqual([{ toolCallId: "r1", decision: "allow", reasonCode: "autonomy_auto", matchedRule: "autonomy.run_tests" }]);
    const ran = (await env.edge.callTool(token, "r1")) as { kind: string; text: string };
    expect(ran.kind).toBe("text");
    expect(ran.text).toContain("テスト通過");
    expect((await decisionsOf(db, w.task)).at(-1)).toEqual({ op: "run_tests", decision: "allow", reason: "autonomy_auto", rule: "autonomy.run_tests", commandOperation: "run_tests" });
    await stop(db, w.task, provider);
  });

  it("自分が動かしたコマンドの出力（sandbox_run）で汚染されたあとも、決まった形のコマンドは続けて動かせる", async () => {
    const { db } = T();
    const w = await setup(db);
    const provider = inProcessProvider(db);
    const env = started(
      db,
      [
        step("w1", "write_file", { path: "score.js", content: "console.log(`合計=${80 + 95}`);\n" }),
        step("r1", "run_command", { command: "node score.js" }),
        step("r2", "run_command", { command: "node score.js" }),
      ],
      provider,
    );
    const token = await tokenFor(db, w.ws, w.task);
    const ctx = await env.edge.getTaskContext(token);
    await env.edge.llmMessages(token, llmRequest(ctx.tools));
    await env.edge.callTool(token, "w1");
    await env.edge.llmMessages(token, llmRequest(ctx.tools));
    expect(((await env.edge.callTool(token, "r1")) as { text: string }).text).toContain("合計=175");
    const t = (await db.query<{ tainted: boolean; taint_sources: Array<{ kind: string }> }>("SELECT tainted, taint_sources FROM tasks WHERE id = $1", [w.task])).rows[0]!;
    expect(t).toMatchObject({ tainted: true, taint_sources: [{ kind: "sandbox_run" }] });
    const res = await env.edge.llmMessages(token, llmRequest(ctx.tools));
    expect(res.governance[0]).toMatchObject({ decision: "allow", matchedRule: "autonomy.run_tests" });
    expect(((await env.edge.callTool(token, "r2")) as { text: string }).text).toContain("合計=175");
    await stop(db, w.task, provider);
  });

  it("汚染後（Web を読んだあと）の npm test は動かない（run_shell・deny。作業場にコマンドを積まない）。LLM には汚染の文を返す", async () => {
    const { db } = T();
    const w = await setup(db, WEB_TAINT);
    const provider = inProcessProvider(db);
    const env = started(db, [step("r1", "run_command", { command: "npm test" })], provider);
    const token = await tokenFor(db, w.ws, w.task);
    const ctx = await env.edge.getTaskContext(token);
    const res = await env.edge.llmMessages(token, llmRequest(ctx.tools));
    expect(res.governance).toEqual([
      { toolCallId: "r1", decision: "deny", reasonCode: "autonomy_deny", matchedRule: "autonomy.run_shell", note: RUN_SHELL_TAINTED_TEXT },
    ]);
    await expect(env.edge.callTool(token, "r1")).rejects.toMatchObject({ code: "TOOL_CALL_NOT_ALLOWED" });
    expect(await decisionsOf(db, w.task)).toEqual([
      { op: "run_shell", decision: "deny", reason: "autonomy_deny", rule: "autonomy.run_shell", commandOperation: "run_shell" },
    ]);
    expect(await commandCount(db, w.task)).toBe(0);
    // 監査ログに decision.made（allow 以外）が残る
    const audits = (await db.query<{ payload: { operation: string; decision: string } }>("SELECT payload FROM audit_logs WHERE task_id = $1 AND event_type = 'decision.made'", [w.task])).rows;
    expect(audits.map((a) => [a.payload.operation, a.payload.decision])).toEqual([["run_shell", "deny"]]);
  });

  it("curl を含むコマンド・シェルの構文は汚染前でも動かない（run_shell・deny）。LLM には使える形の文を返す", async () => {
    const { db } = T();
    const w = await setup(db);
    const provider = inProcessProvider(db);
    const env = started(
      db,
      [
        step("c1", "run_command", { command: "curl https://example.com" }),
        step("c2", "run_command", { command: "npm test && curl https://example.com" }),
      ],
      provider,
    );
    const token = await tokenFor(db, w.ws, w.task);
    const ctx = await env.edge.getTaskContext(token);
    for (const id of ["c1", "c2"]) {
      const res = await env.edge.llmMessages(token, llmRequest(ctx.tools));
      expect(res.governance).toEqual([{ toolCallId: id, decision: "deny", reasonCode: "autonomy_deny", matchedRule: "autonomy.run_shell", note: RUN_SHELL_SHAPE_TEXT }]);
      await expect(env.edge.callTool(token, id)).rejects.toMatchObject({ code: "TOOL_CALL_NOT_ALLOWED" });
    }
    expect((await decisionsOf(db, w.task)).map((d) => [d.op, d.decision, d.commandOperation])).toEqual([
      ["run_shell", "deny", "run_shell"],
      ["run_shell", "deny", "run_shell"],
    ]);
    expect(await commandCount(db, w.task)).toBe(0);
  });
});

describe("監査の再現（SG-05 と合わせた直し）", () => {
  /** タスクを報告で終え、作業場の実行役が最後の控えを送って終わるのを待つ */
  async function finishWithReport(env: ReturnType<typeof started>, token: string, tools: Parameters<typeof llmRequest>[0], provider: { runs: Array<Promise<unknown>> }) {
    await env.edge.llmMessages(token, llmRequest(tools));
    await env.edge.callTool(token, "rep");
    await Promise.all(provider.runs);
  }

  it("Web を読んだタスク1が注入に従って書いた package.json・t.js は控えに残るが、汚染なしのタスク2の npm test は run_shell で動かない", async () => {
    const { db } = T();
    // タスク1：Web を読んだあと（汚染）
    const w = await setup(db, WEB_TAINT);
    const provider = inProcessProvider(db);
    const evil = JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "node t.js" } });
    const env1 = started(
      db,
      [
        step("w1", "write_file", { path: "package.json", content: evil }),
        step("w2", "write_file", { path: "t.js", content: "console.log('注入されたコード');\n" }),
        step("r1", "run_command", { command: "npm test" }),
        step("rep", "submit_report", { title: "a", body: "b", sources: [] }),
      ],
      provider,
    );
    const token1 = await tokenFor(db, w.ws, w.task);
    const ctx1 = await env1.edge.getTaskContext(token1);
    await env1.edge.llmMessages(token1, llmRequest(ctx1.tools));
    await env1.edge.callTool(token1, "w1"); // edit_code は auto
    await env1.edge.llmMessages(token1, llmRequest(ctx1.tools));
    await env1.edge.callTool(token1, "w2");
    const r1 = await env1.edge.llmMessages(token1, llmRequest(ctx1.tools));
    expect(r1.governance[0]).toMatchObject({ decision: "deny", matchedRule: "autonomy.run_shell", note: RUN_SHELL_TAINTED_TEXT });
    await finishWithReport(env1, token1, ctx1.tools, provider);

    // 書いたファイルは控えに残り、控えはタスク1の汚染（Web）を持つ
    const snap = (await db.query<{ tainted: boolean; taint_sources: Array<{ kind: string }> }>(
      "SELECT tainted, taint_sources FROM agent_workspace_snapshots WHERE agent_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
      [w.coder.agentId],
    )).rows[0]!;
    expect(snap.tainted).toBe(true);
    expect(snap.taint_sources.map((s) => s.kind)).toContain("web_fetch");

    // タスク2：同じ担当・汚染なしで始まり、最初の呼び出しが npm test（作業場はまだ控えを受け取っていない）
    const task2 = await seedTask(db, w.ws, w.coder, "build", { ask: w.ask, memberName: "コード職人" });
    expect((await db.query<{ tainted: boolean }>("SELECT tainted FROM tasks WHERE id = $1", [task2])).rows[0]!.tainted).toBe(false);
    const env2 = started(db, [step("r2", "run_command", { command: "npm test" })], provider);
    const token2 = await tokenFor(db, w.ws, task2);
    const ctx2 = await env2.edge.getTaskContext(token2);
    const r2 = await env2.edge.llmMessages(token2, llmRequest(ctx2.tools));
    expect(r2.governance).toEqual([
      { toolCallId: "r2", decision: "deny", reasonCode: "autonomy_deny", matchedRule: "autonomy.run_shell", note: RUN_SHELL_TAINTED_TEXT },
    ]);
    await expect(env2.edge.callTool(token2, "r2")).rejects.toMatchObject({ code: "TOOL_CALL_NOT_ALLOWED" });
    expect(await decisionsOf(db, task2)).toEqual([
      { op: "run_shell", decision: "deny", reason: "autonomy_deny", rule: "autonomy.run_shell", commandOperation: "run_shell" },
    ]);
    expect(await commandCount(db, task2)).toBe(0);
  });

  it("汚染なしのタスク1が作業場で動かしただけ（sandbox_run）の控えなら、タスク2の最初の node score.js は動く（作る → 動かす → 直すを保つ）", async () => {
    const { db } = T();
    const w = await setup(db);
    const provider = inProcessProvider(db);
    const env1 = started(
      db,
      [
        step("w1", "write_file", { path: "score.js", content: "console.log(`合計=${80 + 95}`);\n" }),
        step("r1", "run_command", { command: "node score.js" }),
        // 動かしたあとに書く：この控えはタスク1の汚染（sandbox_run）を持つ
        step("w2", "write_file", { path: "README.md", content: "node score.js で合計を出す\n" }),
        step("rep", "submit_report", { title: "a", body: "b", sources: [] }),
      ],
      provider,
    );
    const token1 = await tokenFor(db, w.ws, w.task);
    const ctx1 = await env1.edge.getTaskContext(token1);
    for (const id of ["w1", "r1", "w2"]) {
      await env1.edge.llmMessages(token1, llmRequest(ctx1.tools));
      await env1.edge.callTool(token1, id);
    }
    await finishWithReport(env1, token1, ctx1.tools, provider);
    const snap = (await db.query<{ taint_sources: Array<{ kind: string }> }>(
      "SELECT taint_sources FROM agent_workspace_snapshots WHERE agent_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
      [w.coder.agentId],
    )).rows[0]!;
    expect(snap.taint_sources.map((x) => x.kind)).toEqual(["sandbox_run"]);

    const task2 = await seedTask(db, w.ws, w.coder, "build", { ask: w.ask, memberName: "コード職人" });
    const env2 = started(db, [step("r2", "run_command", { command: "node score.js" })], provider);
    const token2 = await tokenFor(db, w.ws, task2);
    const ctx2 = await env2.edge.getTaskContext(token2);
    const r2 = await env2.edge.llmMessages(token2, llmRequest(ctx2.tools));
    expect(r2.governance[0]).toMatchObject({ decision: "allow", matchedRule: "autonomy.run_tests" });
    expect(((await env2.edge.callTool(token2, "r2")) as { text: string }).text).toContain("合計=175");
    // 控えを受け取ったタスク2は workspace_snapshot（upstream は sandbox_run）で汚染されている
    const t2 = (await db.query<{ taint_sources: Array<{ kind: string; upstream?: Array<{ kind: string }> }> }>("SELECT taint_sources FROM tasks WHERE id = $1", [task2])).rows[0]!;
    expect(t2.taint_sources.find((s) => s.kind === "workspace_snapshot")?.upstream?.map((u) => u.kind)).toEqual(["sandbox_run"]);
    await stop(db, task2, provider);
  });

  it("run_shell の deny は denied_attempts_max（3）に数えない：ls → cat → pip install のあとの npm test は halt にならず動く", async () => {
    const { db } = T();
    const w = await setup(db);
    const provider = inProcessProvider(db);
    const env = started(
      db,
      [
        step("d1", "run_command", { command: "ls" }),
        step("d2", "run_command", { command: "cat package.json" }),
        step("d3", "run_command", { command: "pip install requests" }),
        step("w1", "write_file", { path: "package.json", content: JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "node t.js" } }) }),
        step("w2", "write_file", { path: "t.js", content: "console.log('テスト通過');\n" }),
        step("r1", "run_command", { command: "npm test" }),
      ],
      provider,
    );
    const token = await tokenFor(db, w.ws, w.task);
    const ctx = await env.edge.getTaskContext(token);
    for (const id of ["d1", "d2", "d3"]) {
      const res = await env.edge.llmMessages(token, llmRequest(ctx.tools));
      expect(res.governance[0]).toMatchObject({ toolCallId: id, decision: "deny", matchedRule: "autonomy.run_shell" });
    }
    expect((await db.query<{ denied_count: number }>("SELECT denied_count FROM tasks WHERE id = $1", [w.task])).rows[0]!.denied_count).toBe(0);
    for (const id of ["w1", "w2"]) {
      await env.edge.llmMessages(token, llmRequest(ctx.tools));
      await env.edge.callTool(token, id);
    }
    const res = await env.edge.llmMessages(token, llmRequest(ctx.tools));
    expect(res.governance[0]).toMatchObject({ toolCallId: "r1", decision: "allow", matchedRule: "autonomy.run_tests" });
    expect(((await env.edge.callTool(token, "r1")) as { text: string }).text).toContain("テスト通過");
    await stop(db, w.task, provider);
  });
});

describe("判定と作業場の受け取りの間の汚染（SG-07 の最終監査の直し）", () => {
  it("run_tests と判定したあと、作業場が受け取る前に同じ担当の別のタスクが汚染された控えを残すと、コマンドは実行されず固定の拒否の文が返る", async () => {
    const { db } = T();
    const w = await setup(db);
    const provider = inProcessProvider(db);
    const env = started(db, [step("r1", "run_command", { command: "node t.js" })], provider);
    const token = await tokenFor(db, w.ws, w.task);
    const ctx = await env.edge.getTaskContext(token);
    // 判定：まだ控えはない → run_tests・allow
    const res = await env.edge.llmMessages(token, llmRequest(ctx.tools));
    expect(res.governance[0]).toMatchObject({ decision: "allow", matchedRule: "autonomy.run_tests" });

    // 判定のあと・受け取りの前：同じ担当の別のタスク（Web を読んだ）が、注入で書かされた t.js の控えを残す
    const other = await seedTask(db, w.ws, w.coder, "build", { ask: w.ask, memberName: "コード職人", taint: WEB_TAINT });
    const js = "require('fs').writeFileSync('pwned.txt', 'x');\n";
    await insertWorkspaceSnapshot(db, w.ws.ctx, {
      agentId: w.coder.agentId,
      taskId: other,
      source: "task",
      archive: createTarGz([{ path: "t.js", content: Buffer.from(js, "utf8") }]),
      files: 1,
      bytes: js.length,
      taint: WEB_TAINT,
      now: new Date(),
    });

    const out = (await env.edge.callTool(token, "r1")) as { kind: string; text: string };
    expect(out.kind).toBe("text");
    expect(out.text).toContain("SANDBOX_COMMAND_REFUSED");
    expect(out.text).toContain(RUN_SHELL_TAINTED_TEXT);
    // コマンドは実行役に渡らず断られた（expired・印）。タスクは控えの汚染（workspace_snapshot）を持つが、sandbox_run は付かない
    const cmds = (await db.query<{ status: string; output: string | null; ok: boolean | null }>("SELECT status, output, ok FROM sandbox_commands WHERE task_id = $1", [w.task])).rows;
    expect(cmds).toEqual([{ status: "expired", output: SANDBOX_COMMAND_REFUSED_OUTPUT, ok: null }]);
    const t = (await db.query<{ taint_sources: Array<{ kind: string }> }>("SELECT taint_sources FROM tasks WHERE id = $1", [w.task])).rows[0]!;
    expect(t.taint_sources.map((x) => x.kind)).toEqual(["workspace_snapshot"]);
    await stop(db, w.task, provider);
    // t.js は動いていない：この作業場の最後の控えにも pwned.txt はない
    const last = (await db.query<{ archive: Buffer }>("SELECT archive FROM agent_workspace_snapshots WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1", [w.task])).rows[0];
    if (last !== undefined) expect(readTarGz(last.archive).map((f) => f.path)).not.toContain("pwned.txt");
  });
});
