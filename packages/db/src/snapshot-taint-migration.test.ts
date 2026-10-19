// 0013（作業場の控えの汚染：SG-05）の移し替えの試験。0012 まで流したデータベースに控えを入れてから 0013 を流す。
// 控えの鎖をたどる（SG-07 の最終監査の直し）：その控えより前に作業場を開いた同じ担当のタスクに外の内容で汚染されたものがあれば
// workspace_snapshot（upstream にその出どころ）で汚染。なければ、控えを残したタスクがコマンドを動かしていれば sandbox_run、動かしていなければ汚染なし
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Db } from "./client.ts";
import { loadMigrations, MIGRATIONS_DIR, runMigrations } from "./migrate.ts";
import { fxAgent, fxTask, fxWorkspace, useTestDb, type FxAgent, type FxWorkspace } from "./testing.ts";

const T = useTestDb({ migrate: false });

/** 0012 まで流す */
async function migrateTo0012(url: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ot-mig-0012-"));
  try {
    for (const m of await loadMigrations(MIGRATIONS_DIR)) {
      if (m.version <= "0012") await copyFile(join(MIGRATIONS_DIR, m.file), join(dir, m.file));
    }
    await runMigrations(url, { dir, roles: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 0012 の形の行を入れる道具 */
function rows(db: Db, ws: FxWorkspace, agent: FxAgent) {
  const W = ws.workspaceId;
  let minute = 0;
  /** 時刻を1分ずつ進める（鎖の前後を created_at で決めるため） */
  const tick = () => new Date(Date.UTC(2026, 9, 12, 9, minute++)).toISOString();
  return {
    async task(taint?: unknown[]): Promise<string> {
      const id = (await fxTask(db, ws, agent, { status: "completed" })).taskId;
      if (taint !== undefined) await db.query("UPDATE tasks SET tainted = true, taint_sources = $2 WHERE id = $1", [id, taint]);
      return id;
    },
    /** 作業場を開く（ran なら run_command を実行し始めた） */
    async session(taskId: string, o: { ran?: boolean } = {}): Promise<void> {
      const sess = (
        await db.query<{ id: string }>(
          `INSERT INTO sandbox_sessions (workspace_id, task_id, agent_id, token_hash, provider, status, closed_at, created_at)
           VALUES ($1, $2, $3, sha256(gen_random_uuid()::text::bytea), 'inprocess', 'closed', $4, $4) RETURNING id`,
          [W, taskId, agent.agentId, tick()],
        )
      ).rows[0]!.id;
      if (o.ran === true) {
        await db.query(
          "INSERT INTO sandbox_commands (workspace_id, session_id, task_id, tool, args, status, started_at) VALUES ($1, $2, $3, 'run_command', '{\"command\":\"x\"}', 'expired', now())",
          [W, sess, taskId],
        );
      }
    },
    async snap(taskId: string | null): Promise<string> {
      return (
        await db.query<{ id: string }>(
          "INSERT INTO agent_workspace_snapshots (workspace_id, agent_id, task_id, source, archive, files, bytes, created_at) VALUES ($1, $2, $3, $4, '\\x1f8b', 1, 2, $5) RETURNING id",
          [W, agent.agentId, taskId, taskId === null ? "pack" : "task", tick()],
        )
      ).rows[0]!.id;
    },
  };
}

async function snapshotsOf(db: Db): Promise<Map<string, { tainted: boolean; taint_sources: Array<Record<string, unknown>> }>> {
  const r = await db.query<{ id: string; tainted: boolean; taint_sources: Array<Record<string, unknown>> }>("SELECT id, tainted, taint_sources FROM agent_workspace_snapshots");
  return new Map(r.rows.map((x) => [x.id, x]));
}

const WEB = { kind: "web_fetch", url: "https://example.com/a", at: "2026-10-12T09:00:00.000Z" };

describe("0013：既存の控えの汚染の移し替え（控えの鎖をたどる）", () => {
  it("鎖に外の内容がない：コマンドを動かしていなければ汚染なし、動かしていれば sandbox_run。パックの控えは汚染なし", async () => {
    const { db, url } = T();
    await migrateTo0012(url);
    const ws = await fxWorkspace(db);
    const agent = await fxAgent(db, ws);
    const r = rows(db, ws, agent);
    const pack = await r.snap(null);
    const clean = await r.task(); // 汚染なし・コマンドなし
    await r.session(clean);
    const cleanSnap = await r.snap(clean);
    const ran = await r.task(); // 汚染なし・run_command を実行した
    await r.session(ran, { ran: true });
    const ranSnap = await r.snap(ran);
    // sandbox_run だけの汚染のタスク、upstream が sandbox_run だけの受け渡しで始まったタスクも外の内容ではない
    const handoff = await r.task([{ kind: "handoff", fromTaskId: ran, fromAgentName: "作る係", upstream: [{ kind: "sandbox_run", at: WEB.at }], at: WEB.at }]);
    await r.session(handoff);
    const handoffSnap = await r.snap(handoff);

    expect((await runMigrations(url, { roles: false })).applied).toContain("0013");
    const m = await snapshotsOf(db);
    expect(m.get(pack)).toMatchObject({ tainted: false, taint_sources: [] });
    expect(m.get(cleanSnap)).toMatchObject({ tainted: false, taint_sources: [] });
    expect(m.get(ranSnap)).toMatchObject({ tainted: true, taint_sources: [{ kind: "sandbox_run", at: expect.any(String) }] });
    expect(m.get(handoffSnap)).toMatchObject({ tainted: false, taint_sources: [] });

    // 移し替えたあとは書き換えられない
    await expect(db.query("UPDATE agent_workspace_snapshots SET tainted = false, taint_sources = '[]' WHERE id = $1", [ranSnap])).rejects.toThrow(/cannot be updated/);
  });

  it("鎖に外の内容がある：汚染されたタスクの控えと、そのあとの同じ担当の控えはすべて workspace_snapshot（upstream に出どころ）。前の控え・別の担当は変わらない", async () => {
    const { db, url } = T();
    await migrateTo0012(url);
    const ws = await fxWorkspace(db);
    const agent = await fxAgent(db, ws);
    const other = await fxAgent(db, ws);
    const r = rows(db, ws, agent);
    const ro = rows(db, ws, other);

    const before = await r.task(); // 汚染より前の控え：汚染なしのまま
    await r.session(before);
    const beforeSnap = await r.snap(before);
    const web = await r.task([WEB]); // Web を読んで汚染
    await r.session(web, { ran: true });
    const webSnap = await r.snap(web);
    const after = await r.task(); // 汚染なし・コマンドなしだが、汚染されたタスクの控えを受け取っている
    await r.session(after);
    const afterSnap = await r.snap(after);
    // 受け渡しで外の内容（upstream に Web）を受けたタスクも、鎖の汚染になる（upstream を平らにして持つ）
    const mcp = { kind: "mcp_read", connectorId: "c", connectorSlug: "mail", connectorName: "メール", tool: "list_inbox", at: WEB.at };
    const viaHandoff = await r.task([{ kind: "handoff", fromTaskId: web, fromAgentName: "調べ係", upstream: [mcp], at: WEB.at }]);
    await r.session(viaHandoff);
    const handoffSnap = await r.snap(viaHandoff);
    // 別の担当の控えは影響を受けない
    const otherTask = await ro.task();
    await ro.session(otherTask);
    const otherSnap = await ro.snap(otherTask);

    await runMigrations(url, { roles: false });
    const m = await snapshotsOf(db);
    expect(m.get(beforeSnap)).toMatchObject({ tainted: false, taint_sources: [] });
    expect(m.get(webSnap)).toMatchObject({
      tainted: true,
      taint_sources: [
        { kind: "workspace_snapshot", snapshotId: webSnap, fromTaskId: web, upstream: [WEB], at: expect.any(String) },
        { kind: "sandbox_run", at: expect.any(String) },
      ],
    });
    expect(m.get(afterSnap)).toMatchObject({
      tainted: true,
      taint_sources: [{ kind: "workspace_snapshot", snapshotId: afterSnap, fromTaskId: after, upstream: [WEB], at: expect.any(String) }],
    });
    const h = m.get(handoffSnap)!;
    expect(h.tainted).toBe(true);
    expect(h.taint_sources).toHaveLength(1);
    expect(h.taint_sources[0]).toMatchObject({ kind: "workspace_snapshot", fromTaskId: viaHandoff });
    expect(h.taint_sources[0]!.upstream).toEqual(expect.arrayContaining([WEB, mcp]));
    expect(m.get(otherSnap)).toMatchObject({ tainted: false, taint_sources: [] });
  });
});
