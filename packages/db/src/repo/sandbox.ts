// 作業場（サンドボックス）・ファイルの控え・スキル・パックの問い合わせ（0012・D-116）。
// 作業場は edge が開き（openSandboxSession）、コマンドを積み（enqueueSandboxCommand）、作業場の実行役が取って（claimNextSandboxCommand）結果を書く。
// 作業場のトークンは SHA-256 で token_hash に入れる（タスクのトークンとは別：作業場は LLM を呼べない）

import type { TaintState } from "@open-team/kernel";
import type { Queryable, Tx } from "../client.ts";
import type {
  AgentSkillRow,
  AgentWorkspaceSnapshotRow,
  JsonObject,
  PackInstallRow,
  SandboxCommandRow,
  SandboxSessionRow,
  SandboxTool,
  Uuid,
} from "../types.ts";
import type { WsCtx } from "../workspace.ts";

// ---- 作業場 ----

/** 作業場を開く（starting）。同じタスクに開いた作業場があれば null（ユニーク索引） */
export async function openSandboxSession(
  tx: Tx,
  ctx: WsCtx,
  v: { taskId: Uuid; agentId: Uuid; tokenHash: Buffer; provider: string; now: Date },
): Promise<SandboxSessionRow | null> {
  const r = await tx.query<SandboxSessionRow>(
    `INSERT INTO sandbox_sessions (workspace_id, task_id, agent_id, token_hash, provider, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (task_id) WHERE status <> 'closed' DO NOTHING
     RETURNING *`,
    [ctx.workspaceId, v.taskId, v.agentId, v.tokenHash, v.provider, v.now],
  );
  return r.rows[0] ?? null;
}

/** タスクの開いている作業場 */
export async function getOpenSandboxSession(q: Queryable, ctx: WsCtx, taskId: Uuid): Promise<SandboxSessionRow | null> {
  const r = await q.query<SandboxSessionRow>("SELECT * FROM sandbox_sessions WHERE workspace_id = $1 AND task_id = $2 AND status <> 'closed'", [ctx.workspaceId, taskId]);
  return r.rows[0] ?? null;
}

/** 作業場を ID で引く（ワークスペースで絞る） */
export async function getSandboxSession(q: Queryable, ctx: WsCtx, sessionId: Uuid): Promise<SandboxSessionRow | null> {
  const r = await q.query<SandboxSessionRow>("SELECT * FROM sandbox_sessions WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, sessionId]);
  return r.rows[0] ?? null;
}

/** プロバイダーが起こした作業場の参照（Cloud Run の実行の名前など）を残す */
export async function setSandboxProviderRef(q: Queryable, ctx: WsCtx, sessionId: Uuid, ref: string): Promise<void> {
  await q.query("UPDATE sandbox_sessions SET provider_ref = $3 WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, sessionId, ref.slice(0, 500)]);
}

/** 作業場が来た（starting → running・最後に見た時刻） */
export async function touchSandboxSession(q: Queryable, ctx: WsCtx, sessionId: Uuid, now: Date): Promise<void> {
  await q.query(
    "UPDATE sandbox_sessions SET last_seen_at = $3, status = CASE WHEN status = 'starting' THEN 'running' ELSE status END WHERE workspace_id = $1 AND id = $2 AND status <> 'closed'",
    [ctx.workspaceId, sessionId, now],
  );
}

/** 作業場を閉じる。積んだまま実行されていないコマンドは expired にする。閉じた行を返す（もう閉じていれば null） */
export async function closeSandboxSession(q: Queryable, ctx: WsCtx, sessionId: Uuid, reason: string, now: Date): Promise<SandboxSessionRow | null> {
  const r = await q.query<SandboxSessionRow>(
    "UPDATE sandbox_sessions SET status = 'closed', closed_at = $4, close_reason = $3 WHERE workspace_id = $1 AND id = $2 AND status <> 'closed' RETURNING *",
    [ctx.workspaceId, sessionId, reason, now],
  );
  await q.query("UPDATE sandbox_commands SET status = 'expired', finished_at = $3 WHERE workspace_id = $1 AND session_id = $2 AND status IN ('queued','running')", [
    ctx.workspaceId,
    sessionId,
    now,
  ]);
  return r.rows[0] ?? null;
}

/** タスクの開いている作業場を閉じる（タスクが終わった） */
export async function closeSandboxSessionsOfTask(q: Queryable, ctx: WsCtx, taskId: Uuid, reason: string, now: Date): Promise<number> {
  const open = await getOpenSandboxSession(q, ctx, taskId);
  if (open === null) return 0;
  return (await closeSandboxSession(q, ctx, open.id, reason, now)) === null ? 0 : 1;
}

// ---- コマンド ----

export async function enqueueSandboxCommand(q: Queryable, ctx: WsCtx, v: { sessionId: Uuid; taskId: Uuid; tool: SandboxTool; args: JsonObject; now: Date }): Promise<SandboxCommandRow> {
  const r = await q.query<SandboxCommandRow>(
    "INSERT INTO sandbox_commands (workspace_id, session_id, task_id, tool, args, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
    [ctx.workspaceId, v.sessionId, v.taskId, v.tool, v.args, v.now],
  );
  return r.rows[0]!;
}

export async function getSandboxCommand(q: Queryable, ctx: WsCtx, commandId: Uuid): Promise<SandboxCommandRow | null> {
  const r = await q.query<SandboxCommandRow>("SELECT * FROM sandbox_commands WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, commandId]);
  return r.rows[0] ?? null;
}

/** 次のコマンドを取る（queued → running。古い順に1件。同時に取られないよう行をロックして飛ばす） */
export async function claimNextSandboxCommand(q: Queryable, ctx: WsCtx, sessionId: Uuid, now: Date): Promise<SandboxCommandRow | null> {
  const r = await q.query<SandboxCommandRow>(
    `UPDATE sandbox_commands SET status = 'running', started_at = $3
      WHERE id = (SELECT id FROM sandbox_commands WHERE workspace_id = $1 AND session_id = $2 AND status = 'queued'
                  ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [ctx.workspaceId, sessionId, now],
  );
  return r.rows[0] ?? null;
}

/** 積まれたまま取られていないコマンドの道具（古い順に1件。ロックしない：取る前の下見） */
export async function peekQueuedSandboxCommand(q: Queryable, ctx: WsCtx, sessionId: Uuid): Promise<SandboxTool | null> {
  const r = await q.query<{ tool: SandboxTool }>(
    "SELECT tool FROM sandbox_commands WHERE workspace_id = $1 AND session_id = $2 AND status = 'queued' ORDER BY created_at, id LIMIT 1",
    [ctx.workspaceId, sessionId],
  );
  return r.rows[0]?.tool ?? null;
}

/** 結果を書く（running のときだけ）。書けたら true */
export async function completeSandboxCommand(
  q: Queryable,
  ctx: WsCtx,
  v: { sessionId: Uuid; commandId: Uuid; ok: boolean; output: string; exitCode: number | null; now: Date },
): Promise<boolean> {
  const r = await q.query(
    `UPDATE sandbox_commands SET status = 'done', ok = $4, output = $5, exit_code = $6, finished_at = $7
      WHERE workspace_id = $1 AND session_id = $2 AND id = $3 AND status = 'running'`,
    [ctx.workspaceId, v.sessionId, v.commandId, v.ok, v.output, v.exitCode, v.now],
  );
  return r.rowCount > 0;
}

/** 待ちを諦めたコマンドを expired にする（まだ終わっていなければ） */
export async function expireSandboxCommand(q: Queryable, ctx: WsCtx, commandId: Uuid, now: Date): Promise<void> {
  await q.query("UPDATE sandbox_commands SET status = 'expired', finished_at = $3 WHERE workspace_id = $1 AND id = $2 AND status IN ('queued','running')", [
    ctx.workspaceId,
    commandId,
    now,
  ]);
}

/** 作業場に渡さずに断ったコマンドの output の印（expired と区別して、edge が固定の拒否の文を返す：SG-07） */
export const SANDBOX_COMMAND_REFUSED_OUTPUT = "refused:run_shell";

/**
 * 取ったコマンドを実行役に渡さずに断る（expired にし、output に印を付ける）。SG-07：作業場が控えを受け取ったあとの汚染で
 * 判定し直したら run_shell になったとき。取った直後（running）のコマンドだけ
 */
export async function refuseSandboxCommand(q: Queryable, ctx: WsCtx, commandId: Uuid, now: Date): Promise<void> {
  await q.query("UPDATE sandbox_commands SET status = 'expired', output = $3, finished_at = $4 WHERE workspace_id = $1 AND id = $2 AND status = 'running'", [
    ctx.workspaceId,
    commandId,
    SANDBOX_COMMAND_REFUSED_OUTPUT,
    now,
  ]);
}

// ---- ファイルの控え ----

/**
 * 控えを残す。taint は控えを残したタスクの汚染（SG-05：次のタスクが受け取ったら持ち越す）。
 * パックの控えは汚染なしで残す（DB の CHECK：agent_workspace_snapshots_pack_clean_chk）。控えはあとから書き換えられない（0013 のトリガー）
 */
export async function insertWorkspaceSnapshot(
  q: Queryable,
  ctx: WsCtx,
  v: { agentId: Uuid; taskId: Uuid | null; source: "task" | "pack" | "reset"; archive: Buffer; files: number; bytes: number; taint: TaintState; now: Date },
): Promise<AgentWorkspaceSnapshotRow> {
  // tainted と sources が食い違っていたら汚染として残す（厳しい側：kernel の isTainted と同じ）
  const tainted = v.taint.tainted === true || v.taint.sources.length > 0;
  const r = await q.query<AgentWorkspaceSnapshotRow>(
    `INSERT INTO agent_workspace_snapshots (workspace_id, agent_id, task_id, source, archive, files, bytes, tainted, taint_sources, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [ctx.workspaceId, v.agentId, v.taskId, v.source, v.archive, v.files, v.bytes, tainted, [...v.taint.sources], v.now],
  );
  return r.rows[0]!;
}


/** 担当の最新の控え（次の作業場の最初の中身） */
export async function getLatestAgentSnapshot(q: Queryable, ctx: WsCtx, agentId: Uuid): Promise<AgentWorkspaceSnapshotRow | null> {
  const r = await q.query<AgentWorkspaceSnapshotRow>(
    "SELECT * FROM agent_workspace_snapshots WHERE workspace_id = $1 AND agent_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1",
    [ctx.workspaceId, agentId],
  );
  return r.rows[0] ?? null;
}

/**
 * 担当の最新の控えの汚染だけ（中身の tar.gz は読まない）。次に作業場を起こしたときに受け取る控えと同じ行（getLatestAgentSnapshot と同じ並び）。
 * SG-07：作業場がまだ控えを受け取っていない（claim の前）うちに判定する run_command に、受け取る控えの汚染を先に効かせる
 */
export async function getLatestAgentSnapshotTaint(
  q: Queryable,
  ctx: WsCtx,
  agentId: Uuid,
): Promise<Pick<AgentWorkspaceSnapshotRow, "id" | "task_id" | "tainted" | "taint_sources" | "created_at"> | null> {
  const r = await q.query<Pick<AgentWorkspaceSnapshotRow, "id" | "task_id" | "tainted" | "taint_sources" | "created_at">>(
    "SELECT id, task_id, tainted, taint_sources, created_at FROM agent_workspace_snapshots WHERE workspace_id = $1 AND agent_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1",
    [ctx.workspaceId, agentId],
  );
  return r.rows[0] ?? null;
}

/** タスクの最新の控え（成果のダウンロード） */
export async function getLatestTaskSnapshot(q: Queryable, ctx: WsCtx, taskId: Uuid): Promise<AgentWorkspaceSnapshotRow | null> {
  const r = await q.query<AgentWorkspaceSnapshotRow>(
    "SELECT * FROM agent_workspace_snapshots WHERE workspace_id = $1 AND task_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1",
    [ctx.workspaceId, taskId],
  );
  return r.rows[0] ?? null;
}

/** タスクごとの最新の控えの大きさ（画面の「作ったファイル」。中身は読まない） */
export async function listTaskSnapshotSizes(q: Queryable, ctx: WsCtx, taskIds: readonly Uuid[]): Promise<Map<Uuid, { files: number; bytes: number }>> {
  if (taskIds.length === 0) return new Map();
  const r = await q.query<{ task_id: Uuid; files: number; bytes: string }>(
    `SELECT DISTINCT ON (task_id) task_id, files, bytes FROM agent_workspace_snapshots
      WHERE workspace_id = $1 AND task_id = ANY($2::uuid[]) ORDER BY task_id, created_at DESC, id DESC`,
    [ctx.workspaceId, [...taskIds]],
  );
  return new Map(r.rows.map((x) => [x.task_id, { files: x.files, bytes: Number(x.bytes) }]));
}

/** 古い控えを消す（担当ごとに新しい keep 件だけ残す。タスクの成果は最新の1件があれば足りる） */
export async function pruneAgentSnapshots(q: Queryable, ctx: WsCtx, agentId: Uuid, keep: number): Promise<void> {
  await q.query(
    `DELETE FROM agent_workspace_snapshots WHERE workspace_id = $1 AND agent_id = $2 AND id NOT IN (
       SELECT id FROM agent_workspace_snapshots WHERE workspace_id = $1 AND agent_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3)`,
    [ctx.workspaceId, agentId, keep],
  );
}

// ---- スキル ----

export async function insertAgentSkill(tx: Tx, ctx: WsCtx, v: { agentId: Uuid; name: string; description: string; body: string; packId: string | null; now: Date }): Promise<AgentSkillRow> {
  const r = await tx.query<AgentSkillRow>(
    `INSERT INTO agent_skills (workspace_id, agent_id, name, description, body, pack_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (agent_id, name) DO UPDATE SET description = EXCLUDED.description, body = EXCLUDED.body, pack_id = EXCLUDED.pack_id
     RETURNING *`,
    [ctx.workspaceId, v.agentId, v.name, v.description, v.body, v.packId, v.now],
  );
  return r.rows[0]!;
}

/** 担当のスキル（名前の順） */
export async function listAgentSkills(q: Queryable, ctx: WsCtx, agentId: Uuid): Promise<AgentSkillRow[]> {
  const r = await q.query<AgentSkillRow>("SELECT * FROM agent_skills WHERE workspace_id = $1 AND agent_id = $2 ORDER BY name", [ctx.workspaceId, agentId]);
  return r.rows;
}

// ---- パック ----

export async function insertPackInstall(tx: Tx, ctx: WsCtx, v: { packId: string; version: number; userId: Uuid | null; agentIds: readonly Uuid[]; now: Date }): Promise<PackInstallRow | null> {
  const r = await tx.query<PackInstallRow>(
    `INSERT INTO pack_installs (workspace_id, pack_id, pack_version, installed_by, agent_ids, created_at)
     VALUES ($1, $2, $3, $4, $5::uuid[], $6) ON CONFLICT (workspace_id, pack_id) DO NOTHING RETURNING *`,
    [ctx.workspaceId, v.packId, v.version, v.userId, [...v.agentIds], v.now],
  );
  return r.rows[0] ?? null;
}

export async function listPackInstalls(q: Queryable, ctx: WsCtx): Promise<PackInstallRow[]> {
  const r = await q.query<PackInstallRow>("SELECT * FROM pack_installs WHERE workspace_id = $1 ORDER BY created_at, id", [ctx.workspaceId]);
  return r.rows;
}
