// 作業場・ファイルの控え・スキル・パックの問い合わせの試験（apps/worker/src/db/repo/sandbox.ts）。
// Postgres 版には試験がなかったので新しく書いた（スキルは evolution.test.ts でも見る）
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  claimNextSandboxCommand,
  closeSandboxSession,
  closeSandboxSessionsOfTask,
  completeSandboxCommand,
  enqueueSandboxCommand,
  expireSandboxCommand,
  findSandboxSessionByTokenHash,
  getInitialSandboxSnapshot,
  getInitialSandboxSnapshotTaint,
  getLatestAgentSnapshot,
  getLatestAgentSnapshotTaint,
  getLatestTaskSnapshot,
  getOpenSandboxSession,
  getSandboxCommand,
  getSandboxSession,
  insertAgentSkill,
  insertPackInstall,
  insertWorkspaceSnapshot,
  listAgentSkills,
  listPackInstalls,
  listTaskSnapshotSizes,
  openSandboxSession,
  peekQueuedSandboxCommand,
  pruneAgentSnapshots,
  refuseSandboxCommand,
  SANDBOX_COMMAND_REFUSED_OUTPUT,
  setSandboxProviderRef,
  touchSandboxSession,
} from "../../src/db/repo/sandbox.ts";
import { count, isTriggerAbort, newId, run, type WsDb } from "../../src/db/sqlite.ts";
import type { TaintState } from "@open-team/kernel";
import type { Uuid } from "../../src/db/types.ts";
import { FIXED_NOW, fxAgent, fxAsk, fxAskRun, fxTask, inWorkspace, type FxAgent, type FxWorkspace } from "./fixtures.ts";

const NOW = FIXED_NOW;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const tokenHash = (s: string) => createHash("sha256").update(s).digest();
const CLEAN: TaintState = { tainted: false, sources: [] };
const TAINTED = { tainted: true, sources: [{ kind: "web_search" as const, at: NOW.toISOString() }] };

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

function open(db: WsDb, ws: FxWorkspace) {
  const agent = fxAgent(db);
  const { taskId } = fxTask(db, ws, agent);
  const session = openSandboxSession(db, { taskId, agentId: agent.agentId, tokenHash: tokenHash(taskId), provider: "docker", now: NOW })!;
  return { agent, taskId, session };
}

describe("作業場", () => {
  it("開く・引く・来た・閉じる。同じタスクに開いた作業場は1つだけで、閉じたら開き直せる", async () => {
    await inWorkspace((db, ws) => {
      const { agent, taskId, session } = open(db, ws);
      expect(session).toMatchObject({ task_id: taskId, agent_id: agent.agentId, status: "starting", provider: "docker", created_at: NOW, closed_at: null });
      expect(session.token_hash.equals(tokenHash(taskId))).toBe(true);
      expect(openSandboxSession(db, { taskId, agentId: agent.agentId, tokenHash: tokenHash("other"), provider: "docker", now: NOW })).toBeNull();

      const found = findSandboxSessionByTokenHash(db, tokenHash(taskId));
      expect(found).toMatchObject({ session: { id: session.id }, workspace: { kill_switch_engaged: false } });
      expect(findSandboxSessionByTokenHash(db, tokenHash("nope"))).toBeNull();
      run(db, "UPDATE workspace SET kill_switch_engaged = 1, kill_switch_engaged_at = ? WHERE id = 1", NOW);
      expect(findSandboxSessionByTokenHash(db, tokenHash(taskId))?.workspace.kill_switch_engaged).toBe(true);

      setSandboxProviderRef(db, session.id, "c".repeat(600));
      touchSandboxSession(db, session.id, at(1000));
      expect(getSandboxSession(db, session.id)).toMatchObject({ status: "running", last_seen_at: at(1000) });
      expect(getSandboxSession(db, session.id)?.provider_ref).toHaveLength(500);
      expect(getOpenSandboxSession(db, taskId)?.id).toBe(session.id);

      const closed = closeSandboxSession(db, session.id, "task_finished", at(2000));
      expect(closed).toMatchObject({ status: "closed", close_reason: "task_finished", closed_at: at(2000) });
      expect(closeSandboxSession(db, session.id, "again", at(3000))).toBeNull();
      // 閉じたあとは来ても running に戻らない
      touchSandboxSession(db, session.id, at(4000));
      expect(getSandboxSession(db, session.id)).toMatchObject({ status: "closed", last_seen_at: at(1000) });
      expect(getOpenSandboxSession(db, taskId)).toBeNull();
      expect(getSandboxSession(db, newId())).toBeNull();

      const again = openSandboxSession(db, { taskId, agentId: agent.agentId, tokenHash: tokenHash("again"), provider: "docker", now: at(5000) });
      expect(again?.id).not.toBe(session.id);
      expect(closeSandboxSessionsOfTask(db, taskId, "task_finished", at(6000))).toBe(1);
      expect(closeSandboxSessionsOfTask(db, taskId, "task_finished", at(6000))).toBe(0);
    });
  });
});

describe("コマンド", () => {
  it("積んだ順に1件ずつ取り、running のときだけ結果を書く", async () => {
    await inWorkspace((db, ws) => {
      const { taskId, session } = open(db, ws);
      expect(claimNextSandboxCommand(db, session.id, NOW)).toBeNull();
      expect(peekQueuedSandboxCommand(db, session.id)).toBeNull();
      const c1 = enqueueSandboxCommand(db, { sessionId: session.id, taskId, tool: "read_file", args: { path: "a.txt" }, now: at(1) });
      const c2 = enqueueSandboxCommand(db, { sessionId: session.id, taskId, tool: "run_command", args: { cmd: "ls" }, now: at(2) });
      expect(c1).toMatchObject({ status: "queued", args: { path: "a.txt" }, ok: null });
      expect(peekQueuedSandboxCommand(db, session.id)).toBe("read_file");

      // queued のままでは結果を書けない
      expect(completeSandboxCommand(db, { sessionId: session.id, commandId: c1.id, ok: true, output: "x", exitCode: 0, now: at(3) })).toBe(false);
      const claimed = claimNextSandboxCommand(db, session.id, at(3));
      expect(claimed).toMatchObject({ id: c1.id, status: "running", started_at: at(3) });
      expect(peekQueuedSandboxCommand(db, session.id)).toBe("run_command");
      // 別の作業場の ID では書けない
      expect(completeSandboxCommand(db, { sessionId: newId(), commandId: c1.id, ok: true, output: "x", exitCode: 0, now: at(4) })).toBe(false);
      expect(completeSandboxCommand(db, { sessionId: session.id, commandId: c1.id, ok: true, output: "中身", exitCode: 0, now: at(4) })).toBe(true);
      expect(getSandboxCommand(db, c1.id)).toMatchObject({ status: "done", ok: true, output: "中身", exit_code: 0, finished_at: at(4) });
      expect(completeSandboxCommand(db, { sessionId: session.id, commandId: c1.id, ok: false, output: "y", exitCode: 1, now: at(5) })).toBe(false);

      expect(claimNextSandboxCommand(db, session.id, at(6))?.id).toBe(c2.id);
      expect(claimNextSandboxCommand(db, session.id, at(6))).toBeNull();
      expect(getSandboxCommand(db, newId())).toBeNull();
      expect(() => enqueueSandboxCommand(db, { sessionId: session.id, taskId, tool: "rm_rf" as never, args: {}, now: NOW })).toThrow(/sandbox_commands_tool_check/);
    });
  });

  it("expire は queued・running だけ、refuse は running だけ。閉じると残りは expired", async () => {
    await inWorkspace((db, ws) => {
      const { taskId, session } = open(db, ws);
      const mk = (n: number) => enqueueSandboxCommand(db, { sessionId: session.id, taskId, tool: "run_command", args: { n }, now: at(n) });
      const a = mk(1);
      expireSandboxCommand(db, a.id, at(10));
      expect(getSandboxCommand(db, a.id)).toMatchObject({ status: "expired", finished_at: at(10) });

      const b = mk(2);
      refuseSandboxCommand(db, b.id, at(11));
      expect(getSandboxCommand(db, b.id)?.status).toBe("queued");
      claimNextSandboxCommand(db, session.id, at(12));
      refuseSandboxCommand(db, b.id, at(13));
      expect(getSandboxCommand(db, b.id)).toMatchObject({ status: "expired", output: SANDBOX_COMMAND_REFUSED_OUTPUT, finished_at: at(13) });

      const c = mk(3);
      const d = mk(4);
      claimNextSandboxCommand(db, session.id, at(14));
      completeSandboxCommand(db, { sessionId: session.id, commandId: c.id, ok: true, output: "", exitCode: 0, now: at(15) });
      expireSandboxCommand(db, c.id, at(16));
      expect(getSandboxCommand(db, c.id)?.status).toBe("done");
      closeSandboxSession(db, session.id, "task_finished", at(17));
      expect(getSandboxCommand(db, d.id)).toMatchObject({ status: "expired", finished_at: at(17) });
    });
  });
});

describe("ファイルの控え", () => {
  const archive = (s: string) => Buffer.from(`tar:${s}`);

  function snap(db: WsDb, agent: FxAgent, o: { taskId?: Uuid | null; source?: "task" | "pack" | "reset"; taint?: TaintState; ms: number; bytes?: number }) {
    return insertWorkspaceSnapshot(db, {
      agentId: agent.agentId,
      taskId: o.taskId ?? null,
      source: o.source ?? (o.taskId ? "task" : "pack"),
      archive: archive(String(o.ms)),
      files: 2,
      bytes: o.bytes ?? 10,
      taint: o.taint ?? CLEAN,
      now: at(o.ms),
    });
  }

  it("控えを残して引く。汚染は sources があれば立てる。パックは汚染できず、控えは書き換えられない", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent);
      const pack = snap(db, agent, { source: "pack", ms: 1 });
      expect(pack).toMatchObject({ source: "pack", task_id: null, files: 2, bytes: "10", tainted: false, taint_sources: [] });
      expect(pack.archive.equals(archive("1"))).toBe(true);
      const t = insertWorkspaceSnapshot(db, { agentId: agent.agentId, taskId, source: "task", archive: archive("2"), files: 1, bytes: 3, taint: { tainted: false, sources: TAINTED.sources }, now: at(2) });
      expect(t).toMatchObject({ tainted: true, taint_sources: TAINTED.sources });
      expect(getLatestAgentSnapshot(db, agent.agentId)?.id).toBe(t.id);
      expect(getLatestAgentSnapshotTaint(db, agent.agentId)).toEqual({ id: t.id, task_id: taskId, tainted: true, taint_sources: TAINTED.sources, created_at: at(2) });
      expect(getLatestTaskSnapshot(db, taskId)).toMatchObject({ id: t.id, bytes: "3" });
      expect(getLatestTaskSnapshot(db, newId())).toBeNull();
      expect(getLatestAgentSnapshot(db, newId())).toBeNull();

      expect(() => snap(db, agent, { source: "pack", taint: TAINTED, ms: 3 })).toThrow(/agent_workspace_snapshots_pack_clean_chk/);
      expect(isTriggerAbort(caught(() => run(db, "UPDATE agent_workspace_snapshots SET files = 9 WHERE id = ?", t.id)))).toBe(true);
    });
  });

  it("listTaskSnapshotSizes はタスクごとの最新の大きさ。pruneAgentSnapshots は担当ごとに新しい keep 件を残す", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const other = fxAgent(db);
      const { taskId: t1 } = fxTask(db, ws, agent);
      const { taskId: t2 } = fxTask(db, ws, agent);
      snap(db, agent, { taskId: t1, ms: 1, bytes: 100 });
      snap(db, agent, { taskId: t1, ms: 2, bytes: 200 });
      snap(db, agent, { taskId: t2, ms: 3, bytes: 300 });
      snap(db, other, { source: "pack", ms: 4 });
      const sizes = listTaskSnapshotSizes(db, [t1, t2, newId()]);
      expect([...sizes.entries()].sort()).toEqual([
        [t1, { files: 2, bytes: 200 }],
        [t2, { files: 2, bytes: 300 }],
      ].sort());
      expect(listTaskSnapshotSizes(db, []).size).toBe(0);

      pruneAgentSnapshots(db, agent.agentId, 2);
      expect(count(db, "SELECT count(*) FROM agent_workspace_snapshots WHERE agent_id = ?", agent.agentId)).toBe(2);
      expect(listTaskSnapshotSizes(db, [t1]).get(t1)).toEqual({ files: 2, bytes: 200 });
      expect(count(db, "SELECT count(*) FROM agent_workspace_snapshots WHERE agent_id = ?", other.agentId)).toBe(1);
    });
  });

  it("最初の控え：自分のタスクの控え → 順番の直前のタスクの控え → 担当の最新の控え の順。直前が completed でなければ渡さない", async () => {
    await inWorkspace((db, ws) => {
      const up = fxAgent(db, { name: "上流係" });
      const down = fxAgent(db, { name: "下流係" });
      const { askId } = fxAsk(db, ws, { shape: "chain" });
      const { askRunId } = fxAskRun(db, askId);
      const { taskId: upTask } = fxTask(db, ws, up, { askId, askRunId, status: "completed" });
      const { taskId: downTask } = fxTask(db, ws, down, { askId, askRunId });
      run(db, "UPDATE tasks SET input_task_ids = ? WHERE id = ?", [upTask], downTask);

      expect(getInitialSandboxSnapshot(db, downTask)).toBeNull();
      // 担当の古い控え（最後の候補）
      const own = snap(db, down, { source: "pack", ms: 10 });
      expect(getInitialSandboxSnapshot(db, downTask)?.id).toBe(own.id);
      // 直前のタスクの控え（新しさより優先）
      const upSnap = snap(db, up, { taskId: upTask, taint: TAINTED, ms: 5 });
      expect(getInitialSandboxSnapshot(db, downTask)).toMatchObject({ id: upSnap.id, bytes: "10" });
      expect(getInitialSandboxSnapshot(db, downTask)?.archive.equals(archive("5"))).toBe(true);
      expect(getInitialSandboxSnapshotTaint(db, downTask)).toEqual({ id: upSnap.id, task_id: upTask, tainted: true, taint_sources: TAINTED.sources, created_at: at(5) });
      // 自分のタスクの控え（再開）が一番
      const mine = snap(db, down, { taskId: downTask, ms: 1 });
      expect(getInitialSandboxSnapshot(db, downTask)?.id).toBe(mine.id);
      run(db, "DELETE FROM agent_workspace_snapshots WHERE id = ?", mine.id);

      // 直前のタスクが completed でなければ渡さない（担当の控えに戻る）
      run(db, "UPDATE tasks SET status = 'failed', fail_reason = 'agent_unable' WHERE id = ?", upTask);
      expect(getInitialSandboxSnapshot(db, downTask)?.id).toBe(own.id);
      run(db, "UPDATE tasks SET status = 'completed', fail_reason = NULL WHERE id = ?", upTask);
      // 順番でない依頼・入力が2つ以上なら渡さない
      run(db, "UPDATE asks SET shape = 'parallel' WHERE id = ?", askId);
      expect(getInitialSandboxSnapshot(db, downTask)?.id).toBe(own.id);
      run(db, "UPDATE asks SET shape = 'chain' WHERE id = ?", askId);
      run(db, "UPDATE tasks SET input_task_ids = ? WHERE id = ?", [upTask, newId()], downTask);
      expect(getInitialSandboxSnapshot(db, downTask)?.id).toBe(own.id);
      expect(getInitialSandboxSnapshot(db, newId())).toBeNull();
    });
  });
});

describe("スキルとパック", () => {
  it("insertAgentSkill は同じ名前を上書きし、listAgentSkills は名前の順", async () => {
    await inWorkspace((db) => {
      const agent = fxAgent(db);
      const b = insertAgentSkill(db, { agentId: agent.agentId, name: "b", description: "d", body: "1", packId: "p1", now: NOW });
      insertAgentSkill(db, { agentId: agent.agentId, name: "a", description: "d", body: "1", packId: null, now: NOW });
      const b2 = insertAgentSkill(db, { agentId: agent.agentId, name: "b", description: "新", body: "2", packId: "p2", now: at(1) });
      expect(b2).toMatchObject({ id: b.id, description: "新", body: "2", pack_id: "p2", created_at: NOW });
      expect(listAgentSkills(db, agent.agentId).map((s) => s.name)).toEqual(["a", "b"]);
      expect(listAgentSkills(db, fxAgent(db).agentId)).toEqual([]);
    });
  });

  it("insertPackInstall は同じパックを2度入れない（null）", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const p = insertPackInstall(db, { packId: "teacher", version: 1, userId: ws.userId, agentIds: [agent.agentId], now: NOW });
      expect(p).toMatchObject({ pack_id: "teacher", pack_version: 1, installed_by: ws.userId, agent_ids: [agent.agentId], created_at: NOW });
      expect(insertPackInstall(db, { packId: "teacher", version: 2, userId: null, agentIds: [], now: at(1) })).toBeNull();
      insertPackInstall(db, { packId: "aaa", version: 1, userId: null, agentIds: [], now: at(2) });
      expect(listPackInstalls(db).map((x) => x.pack_id)).toEqual(["teacher", "aaa"]);
    });
  });
});
