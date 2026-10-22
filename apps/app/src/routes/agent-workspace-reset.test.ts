// 担当の作業場を最初に戻す（POST /api/v1/agents/{agentId}/workspace/reset。SG-07 の最終監査の直し）の試験：
// 汚染された控えのあとでも、パックの担当はパックのファイル・それ以外は空の、汚染なしの控えに戻せる。監査ログ agent.workspace.reset が残る。
// 作業場が動いている間は 409、Kill Switch 中は 423、viewer は 403、知らない担当は 404
import { fxTask, useTestDb, type FxAgent, type FxWorkspace } from "@open-team/db/testing";
import { insertWorkspaceSnapshot } from "@open-team/db/sandbox";
import { insertWorkspacePolicyIfMissing } from "@open-team/db/app";
import { defaultWorkspacePolicy, hashCanonical, type JsonObject } from "@open-team/kernel";
import { createTarGz, readTarGz } from "@open-team/sandbox";
import { describe, expect, it } from "vitest";
import { ResetAgentWorkspaceResponseSchema } from "../agents/contract.ts";
import { makeTestApp, send, signInOwner, type TestApp } from "../test-helpers.ts";

const T = useTestDb();

const WEB = { kind: "web_fetch" as const, url: "https://example.com/inject", at: "2026-10-12T09:00:00.000Z" };

async function owner(t: TestApp) {
  const o = await signInOwner(t);
  const ws: FxWorkspace = { workspaceId: o.workspaceId, userId: o.userId, kind: "owner", ctx: { workspaceId: o.workspaceId, kind: "owner", userId: o.userId } };
  // パックを入れるのにワークスペースのポリシーが要る
  const policy = defaultWorkspacePolicy();
  await t.deps.db.transaction((tx) =>
    insertWorkspacePolicyIfMissing(tx, ws.ctx, { policy: policy as unknown as JsonObject, policyHash: hashCanonical(policy), createdBy: null, now: new Date() }),
  );
  return { ...o, ws };
}

/** 担当を FxAgent の形で引く（fxTask に渡す） */
async function fxAgentOf(t: TestApp, agentId: string): Promise<FxAgent> {
  const db = t.deps.db;
  const snap = (await db.query<{ id: string }>("SELECT id FROM agent_snapshots WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1", [agentId])).rows[0]!;
  const job = (await db.query<{ id: string; slug: string }>("SELECT id, slug FROM agent_jobs WHERE agent_id = $1 LIMIT 1", [agentId])).rows[0]!;
  return { agentId, snapshotId: snap.id, jobId: job.id, jobSlug: job.slug, policyHash: "" };
}

/** 汚染されたタスクが残した控え（Web を読んだあとに書かされたファイル） */
async function seedTaintedSnapshot(t: TestApp, ws: FxWorkspace, agent: FxAgent): Promise<string> {
  const task = (await fxTask(t.deps.db, ws, agent, { status: "completed", tainted: true })).taskId;
  const evil = Buffer.from("console.log('注入')\n", "utf8");
  const row = await insertWorkspaceSnapshot(t.deps.db, ws.ctx, {
    agentId: agent.agentId,
    taskId: task,
    source: "task",
    archive: createTarGz([{ path: "t.js", content: evil }]),
    files: 1,
    bytes: evil.length,
    taint: { tainted: true, sources: [WEB] },
    now: new Date(),
  });
  return row.id;
}

async function latestSnapshot(t: TestApp, agentId: string) {
  return (
    await t.deps.db.query<{ id: string; source: string; tainted: boolean; taint_sources: unknown[]; task_id: string | null; archive: Buffer }>(
      "SELECT id, source, tainted, taint_sources, task_id, archive FROM agent_workspace_snapshots WHERE agent_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
      [agentId],
    )
  ).rows[0]!;
}

describe("POST /agents/{agentId}/workspace/reset", () => {
  it("パックの担当：汚染された控えのあとでも、パックのファイルの汚染なしの控え（source='reset'）に戻し、監査ログを残す", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const o = await owner(t);
    const installed = await send(t, "POST", "/api/v1/packs/teacher/install", { cookie: o.cookie, csrf: o.csrf, body: {} });
    expect(installed.status).toBe(201);
    const grader = ((await installed.json()) as { agents: Array<{ agentId: string }> }).agents[1]!.agentId;
    const agent = await fxAgentOf(t, grader);
    const tainted = await seedTaintedSnapshot(t, o.ws, agent);
    expect((await latestSnapshot(t, grader)).tainted).toBe(true);

    const res = await send(t, "POST", `/api/v1/agents/${grader}/workspace/reset`, { cookie: o.cookie, csrf: o.csrf, body: {} });
    expect(res.status).toBe(200);
    const body = ResetAgentWorkspaceResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ agentId: grader, origin: "pack", files: ["grade.py", "samples/answers.csv", "samples/key.csv"] });

    const snap = await latestSnapshot(t, grader);
    expect(snap).toMatchObject({ id: body.snapshotId, source: "reset", tainted: false, taint_sources: [], task_id: null });
    expect(readTarGz(snap.archive).map((f) => f.path)).toEqual(["grade.py", "samples/answers.csv", "samples/key.csv"]);

    const audit = (
      await db.query<{ actor_id: string; payload: Record<string, unknown> }>(
        "SELECT actor_id, payload FROM audit_logs WHERE workspace_id = $1 AND event_type = 'agent.workspace.reset'",
        [o.workspaceId],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_id).toBe(o.userId);
    expect(audit[0]!.payload).toMatchObject({
      agentId: grader,
      previousSnapshotId: tainted,
      previousTainted: true,
      previousTaintSources: [WEB],
      snapshotId: body.snapshotId,
      origin: "pack",
      packId: "teacher",
    });
  });

  it("パックでない担当（作業場のファイルがない担当）は空の控えに戻す", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const o = await owner(t);
    const installed = await send(t, "POST", "/api/v1/packs/teacher/install", { cookie: o.cookie, csrf: o.csrf, body: {} });
    // プリント錬金術師（researcher 系）はファイルを持たない
    const writer = ((await installed.json()) as { agents: Array<{ agentId: string }> }).agents[0]!.agentId;
    const res = await send(t, "POST", `/api/v1/agents/${writer}/workspace/reset`, { cookie: o.cookie, csrf: o.csrf, body: {} });
    expect(res.status).toBe(200);
    const body = ResetAgentWorkspaceResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ origin: "empty", files: [] });
    const snap = await latestSnapshot(t, writer);
    expect(snap).toMatchObject({ source: "reset", tainted: false });
    expect(readTarGz(snap.archive)).toEqual([]);
  });

  it("作業場が動いている間は 409、Kill Switch 中は 423、知らない担当は 404、viewer は 403、CSRF がなければ 403", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const o = await owner(t);
    const installed = await send(t, "POST", "/api/v1/packs/teacher/install", { cookie: o.cookie, csrf: o.csrf, body: {} });
    const grader = ((await installed.json()) as { agents: Array<{ agentId: string }> }).agents[1]!.agentId;
    const agent = await fxAgentOf(t, grader);
    const path = `/api/v1/agents/${grader}/workspace/reset`;

    // 動いているタスクが作業場を開いている
    const running = (await fxTask(db, o.ws, agent, { status: "running" })).taskId;
    await db.query(
      `INSERT INTO sandbox_sessions (workspace_id, task_id, agent_id, token_hash, provider) VALUES ($1, $2, $3, sha256(gen_random_uuid()::text::bytea), 'inprocess')`,
      [o.workspaceId, running, grader],
    );
    const busy = await send(t, "POST", path, { cookie: o.cookie, csrf: o.csrf, body: {} });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe("WORKSPACE_IN_USE");
    // タスクが終われば戻せる
    await db.query("UPDATE tasks SET status = 'completed', finished_at = now() WHERE id = $1", [running]);
    expect((await send(t, "POST", path, { cookie: o.cookie, csrf: o.csrf, body: {} })).status).toBe(200);

    expect((await send(t, "POST", "/api/v1/agents/00000000-0000-4000-8000-000000000000/workspace/reset", { cookie: o.cookie, csrf: o.csrf, body: {} })).status).toBe(404);
    expect((await send(t, "POST", path, { cookie: o.cookie, body: {} })).status).toBe(403);

    await db.query("UPDATE workspaces SET kill_switch_engaged = true WHERE id = $1", [o.workspaceId]);
    expect((await send(t, "POST", path, { cookie: o.cookie, csrf: o.csrf, body: {} })).status).toBe(423);
    await db.query("UPDATE workspaces SET kill_switch_engaged = false WHERE id = $1", [o.workspaceId]);

    await db.query("UPDATE memberships SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2", [o.workspaceId, o.userId]);
    expect((await send(t, "POST", path, { cookie: o.cookie, csrf: o.csrf, body: {} })).status).toBe(403);
  });
});
