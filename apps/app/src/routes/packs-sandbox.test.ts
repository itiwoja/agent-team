// パックと作業場（D-116）の API の試験：
// - GET /packs・POST /packs/{id}/install：担当・スキル・作業場の最初のファイルができる。2度目は 409。作業場の有無が棚に出る
// - 依頼から「作る」担当（dev-coder）が生まれ、作業場（HTTP の /sandbox/v1 を通る実行役）で書いて動かし、回答と作ったファイルのダウンロードまで
import { issueSession } from "@open-team/db";
import { insertWorkspacePolicyIfMissing } from "@open-team/db/app";
import { useTestDb } from "@open-team/db/testing";
import { createRuntime, isTrustedSkill, sandboxEdgeOf, type SandboxProvider } from "@open-team/edge";
import { defaultWorkspacePolicy, hashCanonical, type JsonObject } from "@open-team/kernel";
import { DEFAULT_AGENT_MODEL, LlmError, ScriptedLlmClient, type ScriptedResponder } from "@open-team/llm";
import { httpTransport, readTarGz, runExecutor } from "@open-team/sandbox";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AskDetailResponseSchema, type AskSummary } from "../asks/contract.ts";
import { TRUSTED_SKILLS } from "../packs/catalog.ts";
import { InstallPackResponseSchema, ListPacksResponseSchema } from "../packs/contract.ts";
import { T0, startRehearsalWorld, type RehearsalWorld } from "../rehearsal/__fixtures__/world.ts";
import { jsonReply } from "../rehearsal/test-helpers.ts";
import { HOST, makeTestApp, send, type TestApp } from "../test-helpers.ts";

const T = useTestDb();
let world: RehearsalWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

const fast = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20)));

/** 作業場の実行役を同じプロセスで動かし、/sandbox/v1 には HTTP の口（app.request）で来させるプロバイダー */
function httpLoopProvider(appRef: { t: TestApp | null }): SandboxProvider & { runs: Array<Promise<unknown>> } {
  const runs: Array<Promise<unknown>> = [];
  return {
    name: "inprocess",
    runs,
    async start({ token }) {
      const root = await mkdtemp(path.join(tmpdir(), "sbx-app-"));
      const transport = httpTransport({
        baseUrl: `http://${HOST}`,
        token,
        fetch: ((url: string, init: RequestInit) => appRef.t!.app.request(url, init)) as typeof fetch,
      });
      // next の待ちは短く（試験を速くする）
      const quick = { ...transport, next: (w: number) => transport.next(Math.min(w, 1)) };
      runs.push(runExecutor({ transport: quick, root, sleep: fast }));
      return { ref: root };
    },
  };
}

interface Setup {
  w: RehearsalWorld;
  t: TestApp;
  cookie: string;
  csrf: string;
  planner: unknown[];
  /** 設定プランナーに渡した利用者のプロンプト（呼ばれた順） */
  plannerPrompts: string[];
  provider: ReturnType<typeof httpLoopProvider> | null;
}

async function setup(o: { planner?: unknown[]; responder?: ScriptedResponder; sandbox?: boolean } = {}): Promise<Setup> {
  const { db, url } = T();
  const w = (world = await startRehearsalWorld(db, url));
  const policy = defaultWorkspacePolicy("owner");
  await db.transaction((tx) => insertWorkspacePolicyIfMissing(tx, w.ws.ctx, { policy: policy as unknown as JsonObject, policyHash: hashCanonical(policy), createdBy: null, now: T0 }));
  const planner = o.planner ?? [];
  let plannerCalls = 0;
  const plannerPrompts: string[] = [];
  const responder: ScriptedResponder = (req, index) => {
    if (req.responseJsonSchema !== undefined) {
      plannerPrompts.push(req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
      const next = planner[plannerCalls++];
      if (next === undefined) throw new LlmError("設定プランナーの台本が尽きた", null, false);
      return jsonReply(next);
    }
    if (o.responder === undefined) throw new LlmError("担当の台本がない", null, false);
    return o.responder(req, index);
  };
  const appRef: { t: TestApp | null } = { t: null };
  const provider = o.sandbox === false ? null : httpLoopProvider(appRef);
  const llm = new ScriptedLlmClient(responder);
  const t = makeTestApp(db, {
    deps: {
      gatewayClient: w.gatewayClient,
      simClient: w.simClient,
      llm,
      sandbox: provider,
      sandboxEdge: sandboxEdgeOf(createRuntime({ db, llm, gateway: w.gatewayClient, retry: { sleep: fast } })),
    },
    env: { gemini: { project: undefined, location: "global", agentModel: DEFAULT_AGENT_MODEL, plannerModel: DEFAULT_AGENT_MODEL, compareModels: [] } },
  });
  appRef.t = t;
  const issued = await issueSession(db, { workspaceId: w.ws.workspaceId, userId: w.ws.userId, ipHash: null, userAgent: null, now: T0 });
  return { w, t, cookie: issued.cookieValue, csrf: issued.csrfToken, planner, plannerPrompts, provider };
}

const post = (s: Setup, p: string, body: unknown) => send(s.t, "POST", `/api/v1${p}`, { cookie: s.cookie, csrf: s.csrf, body });
const get = (s: Setup, p: string) => send(s.t, "GET", `/api/v1${p}`, { cookie: s.cookie });

describe("パック（GET /packs・POST /packs/{id}/install）", () => {
  it("棚にパックが並び、入れると担当・スキル・作業場の最初のファイルができる。2度目は 409、知らないパックは 404", async () => {
    const s = await setup();
    const list = ListPacksResponseSchema.parse(await (await get(s, "/packs")).json());
    expect(list.packs.map((p) => p.id)).toEqual(["teacher", "designer", "engineer", "sales", "accounting", "student", "shop"]);
    expect(list.categories).toEqual(["学び・教育", "つくる", "売る・お店", "お金・事務"]);
    expect(list.packs.every((p) => p.installedAt === null && p.sandboxAvailable)).toBe(true);
    expect(list.packs.every((p) => p.agents.every((a) => a.agentId === null))).toBe(true);
    const teacher = list.packs[0]!;
    expect(teacher.needsSandbox).toBe(true);
    expect(teacher.agents.find((a) => a.template === "dev-coder")?.files).toContain("grade.py");

    const res = await post(s, "/packs/teacher/install", {});
    expect(res.status).toBe(201);
    const body = InstallPackResponseSchema.parse(await res.json());
    expect(body.agents.map((a) => a.name)).toEqual(["プリント錬金術師", "採点ロボ先生", "学級だより記者"]);
    expect(body.pack.installedAt).not.toBeNull();
    // 返り値の pack にも、作った担当の id が pack.agents と同じ順で入る（作業場の画面が担当を指す）
    expect(body.pack.agents.map((a) => a.agentId)).toEqual(body.agents.map((a) => a.agentId));

    const { db } = T();
    const grader = body.agents[1]!.agentId;
    const skills = await db.query<{ name: string; pack_id: string }>("SELECT name, pack_id FROM agent_skills WHERE agent_id = $1", [grader]);
    expect(skills.rows).toEqual([{ name: "採点の手順", pack_id: "teacher" }]);
    const snap = (await db.query<{ archive: Buffer; source: string }>("SELECT archive, source FROM agent_workspace_snapshots WHERE agent_id = $1", [grader])).rows[0]!;
    expect(snap.source).toBe("pack");
    expect(readTarGz(snap.archive).map((f) => f.path)).toEqual(["grade.py", "samples/answers.csv", "samples/key.csv"]);
    const job = (await db.query<{ template: string }>("SELECT template FROM agent_jobs WHERE agent_id = $1", [grader])).rows[0]!;
    expect(job.template).toBe("dev-coder");

    expect((await post(s, "/packs/teacher/install", {})).status).toBe(409);
    expect((await post(s, "/packs/nope/install", {})).status).toBe(404);
    const after = ListPacksResponseSchema.parse(await (await get(s, "/packs")).json());
    expect(after.packs.find((p) => p.id === "teacher")?.installedAt).not.toBeNull();
    expect(after.packs.find((p) => p.id === "teacher")?.agents.map((a) => a.agentId)).toEqual(body.agents.map((a) => a.agentId));
    expect(after.packs.filter((p) => p.id !== "teacher").every((p) => p.agents.every((a) => a.agentId === null))).toBe(true);
  });

  it("SG-05：運営の3パックをそのまま入れると、どのスキルも信頼の表（カタログの名前・説明・本文の SHA-256）と一致し、パックの控えは汚染なし", async () => {
    const s = await setup();
    for (const id of ["teacher", "designer", "engineer"]) expect((await post(s, `/packs/${id}/install`, {})).status).toBe(201);
    const { db } = T();
    const skills = (
      await db.query<{ name: string; description: string; body: string; pack_id: string | null }>("SELECT name, description, body, pack_id FROM agent_skills WHERE workspace_id = $1", [
        s.w.ws.workspaceId,
      ])
    ).rows;
    expect(new Set(skills.map((r) => r.pack_id))).toEqual(new Set(["teacher", "designer", "engineer"]));
    for (const r of skills) expect(isTrustedSkill(TRUSTED_SKILLS, r)).toBe(true);
    // 本文を1文字でも書き換えると一致しない
    const one = skills[0]!;
    expect(isTrustedSkill(TRUSTED_SKILLS, { ...one, body: `${one.body} ` })).toBe(false);
    const snaps = (await db.query<{ source: string; tainted: boolean; taint_sources: unknown[] }>("SELECT source, tainted, taint_sources FROM agent_workspace_snapshots WHERE workspace_id = $1", [s.w.ws.workspaceId])).rows;
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps.every((r) => r.source === "pack" && !r.tainted && r.taint_sources.length === 0)).toBe(true);
  });

  it("SG-05：パックで入れた担当で依頼を走らせると、スキルはシステムプロンプトに出て、load_skill は包まれず、タスクは汚染されない（本番の配線）", async () => {
    let system = "";
    let loaded = "";
    const responder: ScriptedResponder = (req) => {
      const usage = { inputTokens: 500, outputTokens: 50, thinkingTokens: 0 };
      const toolMessages = req.messages.filter((m) => m.role === "tool");
      if (toolMessages.length === 0) {
        system = req.system;
        return { parts: [{ type: "tool_call", id: "s1", name: "load_skill", arguments: { name: "保護者連絡の書き方" } }], usage };
      }
      loaded = JSON.stringify(toolMessages.at(-1));
      return { parts: [{ type: "tool_call", id: "rep", name: "submit_report", arguments: { title: "おたより", body: "下書きです", sources: [] } }], usage };
    };
    const planner: unknown[] = [];
    const s = await setup({ responder, planner, sandbox: false });
    const installed = (await (await post(s, "/packs/teacher/install", {})).json()) as { agents: Array<{ agentId: string; name: string }> };
    const letter = installed.agents.find((a) => a.name === "学級だより記者")!;
    planner.push({
      formation: { shape: "single", members: [{ agentId: letter.agentId, summary: "おたよりを書く", template: "briefer", instructions: "保護者向けのおたよりを書いてください。", grants: [] }] },
    });
    const res = await post(s, "/asks", { text: "遠足のおたよりを書いて" });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { ask: AskSummary }).ask.id;
    let d = AskDetailResponseSchema.parse(await (await get(s, `/asks/${id}`)).json());
    for (let i = 0; i < 400 && d.ask.status !== "done" && d.ask.status !== "failed"; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      d = AskDetailResponseSchema.parse(await (await get(s, `/asks/${id}`)).json());
    }
    expect(d.ask.status).toBe("done");
    expect(system).toContain("# 使えるスキル");
    expect(system).toContain("保護者連絡の書き方");
    expect(loaded).toContain("# スキル「保護者連絡の書き方」");
    expect(loaded).not.toContain("<untrusted");
    const { db } = T();
    const t = (await db.query<{ tainted: boolean; taint_sources: unknown[] }>("SELECT tainted, taint_sources FROM tasks WHERE id = $1", [d.stages[0]!.taskId])).rows[0]!;
    expect(t).toEqual({ tainted: false, taint_sources: [] });
  });

  it("パックの作業場からの依頼（POST /asks の packId）：入っていないパックは 400、入っていれば依頼に残し、設定プランナーにパックの担当を優先させる", async () => {
    const responder: ScriptedResponder = () => ({
      parts: [{ type: "tool_call", id: "rep", name: "submit_report", arguments: { title: "おたより", body: "下書きです", sources: [] } }],
      usage: { inputTokens: 500, outputTokens: 50, thinkingTokens: 0 },
    });
    const planner: unknown[] = [];
    const s = await setup({ responder, planner, sandbox: false });
    const { db } = T();

    const notInstalled = await post(s, "/asks", { text: "遠足のおたよりを書いて", packId: "teacher" });
    expect(notInstalled.status).toBe(400);
    expect(await notInstalled.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", details: [{ field: "packId", reason: "入っていないパックです" }] } });
    expect((await post(s, "/asks", { text: "遠足のおたよりを書いて", packId: "nope" })).status).toBe(400);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM asks WHERE workspace_id = $1", [s.w.ws.workspaceId])).rows[0]?.n).toBe(0);

    const installed = InstallPackResponseSchema.parse(await (await post(s, "/packs/teacher/install", {})).json());
    const letter = installed.agents.find((a) => a.name === "学級だより記者")!;
    planner.push({
      formation: { shape: "single", members: [{ agentId: letter.agentId, summary: "おたよりを書く", template: "briefer", instructions: "保護者向けのおたよりを書いてください。", grants: [] }] },
    });
    const res = await post(s, "/asks", { text: "遠足のおたよりを書いて", packId: "teacher" });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { ask: AskSummary }).ask.id;
    let d = AskDetailResponseSchema.parse(await (await get(s, `/asks/${id}`)).json());
    for (let i = 0; i < 400 && d.ask.status !== "done" && d.ask.status !== "failed"; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      d = AskDetailResponseSchema.parse(await (await get(s, `/asks/${id}`)).json());
    }
    expect(d.ask.status).toBe("done");

    expect((await db.query<{ pack_id: string | null }>("SELECT pack_id FROM asks WHERE id = $1", [id])).rows[0]?.pack_id).toBe("teacher");
    const audit = (await db.query<{ payload: { packId: string | null } }>("SELECT payload FROM audit_logs WHERE workspace_id = $1 AND event_type = 'ask.created'", [s.w.ws.workspaceId])).rows;
    expect(audit.map((r) => r.payload.packId)).toEqual(["teacher"]);
    const prompt = s.plannerPrompts[0]!;
    expect(prompt).toContain("# パックの作業場からの依頼\n『教員パック』の作業場から出された依頼。");
    expect(prompt).toContain(`この依頼はまずパックの担当（${installed.agents.map((a) => `id=${a.agentId}`).join(", ")}）で分担する。`);
  });

  it("作業場のプロバイダーがなければ、棚に「作業場なし」と出る", async () => {
    const s = await setup({ sandbox: false });
    const list = ListPacksResponseSchema.parse(await (await get(s, "/packs")).json());
    expect(list.packs.every((p) => !p.sandboxAvailable)).toBe(true);
  });
});

describe("作業場で書いて動かす担当（dev-coder）", () => {
  it("依頼から dev-coder が生まれ、作業場（/sandbox/v1）で書いて動かし、回答と作ったファイルのダウンロードまで届く", async () => {
    let step = 0;
    const responder: ScriptedResponder = (req) => {
      const toolResults = req.messages.filter((m) => m.role === "tool").length;
      step = toolResults;
      const usage = { inputTokens: 500, outputTokens: 50, thinkingTokens: 0 };
      if (toolResults === 0) {
        return { parts: [{ type: "tool_call", id: "w1", name: "write_file", arguments: { path: "sum.js", content: "console.log([80, 95, 70].reduce((a, b) => a + b));\n" } }], usage };
      }
      if (toolResults === 1) return { parts: [{ type: "tool_call", id: "r1", name: "run_command", arguments: { command: "node sum.js" } }], usage };
      // 決まった形のコマンドだけ自動で動く（SG-07）。以前の「python3 sum.py || node -e …」のようなシェルの構文は run_shell で動かない
      const ran = JSON.stringify(req.messages.at(-1));
      return {
        parts: [{ type: "tool_call", id: "rep", name: "submit_report", arguments: { title: "合計", body: ran.includes("245") ? "合計は245点です（sum.js で計算）" : "計算できませんでした", sources: [] } }],
        usage,
      };
    };
    const s = await setup({
      responder,
      planner: [{ formation: { shape: "single", members: [{ newName: "計算マイスター", role: "assist", summary: "点数を合計する", template: "dev-coder", instructions: "点数を合計するスクリプトを書いて動かしてください。", grants: [] }] } }],
    });
    const res = await post(s, "/asks", { text: "80点・95点・70点を合計するスクリプトを作って動かして" });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { ask: AskSummary }).ask.id;
    let d = AskDetailResponseSchema.parse(await (await get(s, `/asks/${id}`)).json());
    for (let i = 0; i < 400 && d.ask.status !== "done" && d.ask.status !== "failed"; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      d = AskDetailResponseSchema.parse(await (await get(s, `/asks/${id}`)).json());
    }
    expect(step).toBe(2);
    expect(d.ask.status).toBe("done");
    expect(d.answer?.conclusion).toBe("合計は245点です（sum.js で計算）");
    const stage = d.stages[0]!;
    expect(stage.files).toEqual({ count: 1, bytes: 51 });

    const dl = await get(s, `/tasks/${stage.taskId}/files`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/gzip");
    expect(readTarGz(Buffer.from(await dl.arrayBuffer())).map((f) => [f.path, f.content.toString()])).toEqual([["sum.js", "console.log([80, 95, 70].reduce((a, b) => a + b));\n"]]);

    await Promise.all(s.provider!.runs);
    // 作業場のトークンなしでは /sandbox/v1 に入れない
    const noToken = await s.t.app.request(`http://${HOST}/sandbox/v1/claim`, { method: "POST" });
    expect(noToken.status).toBe(401);
  });
});
