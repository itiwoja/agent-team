// packages/db/src/repo/sandbox.ts と system/sandbox.ts の WorkspaceDO 版。
// 作業場（サンドボックス）・ファイルの控え・スキル・パックの問い合わせ（0012・D-116）。
// 作業場は edge が開き（openSandboxSession）、コマンドを積み（enqueueSandboxCommand）、作業場の実行役が取って（claimNextSandboxCommand）結果を書く。
// 作業場のトークンは SHA-256 で token_hash に入れる（タスクのトークンとは別：作業場は LLM を呼べない）。
// DO の中の行だけを扱う。Postgres 版の FOR UPDATE SKIP LOCKED は要らない（DO の中は1本の流れ）

import type { TaintState } from "@open-team/kernel";
import { CODECS } from "../codecs.ts";
import { all, newId, one, run, type WsDb } from "../sqlite.ts";
import type {
  AgentSkillRow,
  AgentWorkspaceSnapshotRow,
  JsonObject,
  PackInstallRow,
  SandboxCommandRow,
  SandboxSessionRow,
  SandboxTool,
  SkillOrigin,
  Uuid,
  WorkspaceRow,
} from "../types.ts";
import { requireWorkspace } from "../workspace.ts";

// ---- 作業場 ----

/**
 * 作業場のトークン（の SHA-256）から作業場を引く（system/sandbox.ts の WorkspaceDO 版。D-116）。
 * Postgres 版はワークスペースをまたいで引いたが、DO の中ではこのワークスペースの作業場と Kill Switch だけを返す
 */
export function findSandboxSessionByTokenHash(
  db: WsDb,
  tokenHash: Uint8Array,
): { session: SandboxSessionRow; workspace: Pick<WorkspaceRow, "kill_switch_engaged"> } | null {
  const session = one<SandboxSessionRow>(db, CODECS.sandbox_sessions, "SELECT * FROM sandbox_sessions WHERE token_hash = ?", tokenHash);
  if (session === null) return null;
  return { session, workspace: { kill_switch_engaged: requireWorkspace(db).kill_switch_engaged } };
}

/** 作業場を開く（starting）。同じタスクに開いた作業場があれば null（一意の索引 sandbox_sessions_task_open_uq） */
export function openSandboxSession(db: WsDb, v: { taskId: Uuid; agentId: Uuid; tokenHash: Uint8Array; provider: string; now: Date }): SandboxSessionRow | null {
  return one<SandboxSessionRow>(
    db,
    CODECS.sandbox_sessions,
    `INSERT INTO sandbox_sessions (id, task_id, agent_id, token_hash, provider, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id) WHERE status <> 'closed' DO NOTHING
     RETURNING *`,
    newId(),
    v.taskId,
    v.agentId,
    v.tokenHash,
    v.provider,
    v.now,
  );
}

/** タスクの開いている作業場 */
export function getOpenSandboxSession(db: WsDb, taskId: Uuid): SandboxSessionRow | null {
  return one<SandboxSessionRow>(db, CODECS.sandbox_sessions, "SELECT * FROM sandbox_sessions WHERE task_id = ? AND status <> 'closed'", taskId);
}

/** 作業場を ID で引く */
export function getSandboxSession(db: WsDb, sessionId: Uuid): SandboxSessionRow | null {
  return one<SandboxSessionRow>(db, CODECS.sandbox_sessions, "SELECT * FROM sandbox_sessions WHERE id = ?", sessionId);
}

/** プロバイダーが起こした作業場の参照（コンテナの名前など）を残す */
export function setSandboxProviderRef(db: WsDb, sessionId: Uuid, ref: string): void {
  run(db, "UPDATE sandbox_sessions SET provider_ref = ? WHERE id = ?", ref.slice(0, 500), sessionId);
}

/** 作業場が来た（starting → running・最後に見た時刻） */
export function touchSandboxSession(db: WsDb, sessionId: Uuid, now: Date): void {
  run(
    db,
    "UPDATE sandbox_sessions SET last_seen_at = ?, status = CASE WHEN status = 'starting' THEN 'running' ELSE status END WHERE id = ? AND status <> 'closed'",
    now,
    sessionId,
  );
}

/** 作業場を閉じる。積んだまま実行されていないコマンドは expired にする。閉じた行を返す（もう閉じていれば null） */
export function closeSandboxSession(db: WsDb, sessionId: Uuid, reason: string, now: Date): SandboxSessionRow | null {
  return db.transaction(() => {
    const row = one<SandboxSessionRow>(
      db,
      CODECS.sandbox_sessions,
      "UPDATE sandbox_sessions SET status = 'closed', closed_at = ?, close_reason = ? WHERE id = ? AND status <> 'closed' RETURNING *",
      now,
      reason,
      sessionId,
    );
    run(db, "UPDATE sandbox_commands SET status = 'expired', finished_at = ? WHERE session_id = ? AND status IN ('queued','running')", now, sessionId);
    return row;
  });
}

/** タスクの開いている作業場を閉じる（タスクが終わった） */
export function closeSandboxSessionsOfTask(db: WsDb, taskId: Uuid, reason: string, now: Date): number {
  const open = getOpenSandboxSession(db, taskId);
  if (open === null) return 0;
  return closeSandboxSession(db, open.id, reason, now) === null ? 0 : 1;
}

// ---- コマンド ----

export function enqueueSandboxCommand(db: WsDb, v: { sessionId: Uuid; taskId: Uuid; tool: SandboxTool; args: JsonObject; now: Date }): SandboxCommandRow {
  return one<SandboxCommandRow>(
    db,
    CODECS.sandbox_commands,
    "INSERT INTO sandbox_commands (id, session_id, task_id, tool, args, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
    newId(),
    v.sessionId,
    v.taskId,
    v.tool,
    v.args,
    v.now,
  )!;
}

export function getSandboxCommand(db: WsDb, commandId: Uuid): SandboxCommandRow | null {
  return one<SandboxCommandRow>(db, CODECS.sandbox_commands, "SELECT * FROM sandbox_commands WHERE id = ?", commandId);
}

/** 次のコマンドを取る（queued → running。古い順に1件） */
export function claimNextSandboxCommand(db: WsDb, sessionId: Uuid, now: Date): SandboxCommandRow | null {
  return one<SandboxCommandRow>(
    db,
    CODECS.sandbox_commands,
    `UPDATE sandbox_commands SET status = 'running', started_at = ?
      WHERE id = (SELECT id FROM sandbox_commands WHERE session_id = ? AND status = 'queued' ORDER BY created_at, id LIMIT 1)
      RETURNING *`,
    now,
    sessionId,
  );
}

/** 積まれたまま取られていないコマンドの道具（古い順に1件。取る前の下見） */
export function peekQueuedSandboxCommand(db: WsDb, sessionId: Uuid): SandboxTool | null {
  return (
    one<{ tool: SandboxTool }>(db, {}, "SELECT tool FROM sandbox_commands WHERE session_id = ? AND status = 'queued' ORDER BY created_at, id LIMIT 1", sessionId)
      ?.tool ?? null
  );
}

/** 結果を書く（running のときだけ）。書けたら true */
export function completeSandboxCommand(
  db: WsDb,
  v: { sessionId: Uuid; commandId: Uuid; ok: boolean; output: string; exitCode: number | null; now: Date },
): boolean {
  return (
    run(
      db,
      `UPDATE sandbox_commands SET status = 'done', ok = ?, output = ?, exit_code = ?, finished_at = ?
        WHERE session_id = ? AND id = ? AND status = 'running'`,
      v.ok,
      v.output,
      v.exitCode,
      v.now,
      v.sessionId,
      v.commandId,
    ) > 0
  );
}

/** 待ちを諦めたコマンドを expired にする（まだ終わっていなければ） */
export function expireSandboxCommand(db: WsDb, commandId: Uuid, now: Date): void {
  run(db, "UPDATE sandbox_commands SET status = 'expired', finished_at = ? WHERE id = ? AND status IN ('queued','running')", now, commandId);
}

/** 作業場に渡さずに断ったコマンドの output の印（expired と区別して、edge が固定の拒否の文を返す：SG-07） */
export const SANDBOX_COMMAND_REFUSED_OUTPUT = "refused:run_shell";

/**
 * 取ったコマンドを実行役に渡さずに断る（expired にし、output に印を付ける）。SG-07：作業場が控えを受け取ったあとの汚染で
 * 判定し直したら run_shell になったとき。取った直後（running）のコマンドだけ
 */
export function refuseSandboxCommand(db: WsDb, commandId: Uuid, now: Date): void {
  run(
    db,
    "UPDATE sandbox_commands SET status = 'expired', output = ?, finished_at = ? WHERE id = ? AND status = 'running'",
    SANDBOX_COMMAND_REFUSED_OUTPUT,
    now,
    commandId,
  );
}

// ---- ファイルの控え ----

/** 控えの列（bytes は行の型に合わせて文字列で返す：Postgres 版の bigint と同じ） */
function snapshotColumns(p = ""): string {
  return `${p}id, ${p}agent_id, ${p}task_id, ${p}source, ${p}archive, ${p}files, CAST(${p}bytes AS TEXT) AS bytes, ${p}tainted, ${p}taint_sources, ${p}created_at`;
}
type SnapshotTaint = Pick<AgentWorkspaceSnapshotRow, "id" | "task_id" | "tainted" | "taint_sources" | "created_at">;

/**
 * 控えを残す。taint は控えを残したタスクの汚染（SG-05：次のタスクが受け取ったら持ち越す）。
 * パックの控えは汚染なしで残す（DB の CHECK：agent_workspace_snapshots_pack_clean_chk）。控えはあとから書き換えられない（トリガー）
 */
export function insertWorkspaceSnapshot(
  db: WsDb,
  v: { agentId: Uuid; taskId: Uuid | null; source: "task" | "pack" | "reset"; archive: Uint8Array; files: number; bytes: number; taint: TaintState; now: Date },
): AgentWorkspaceSnapshotRow {
  // tainted と sources が食い違っていたら汚染として残す（厳しい側：kernel の isTainted と同じ）
  const tainted = v.taint.tainted === true || v.taint.sources.length > 0;
  return one<AgentWorkspaceSnapshotRow>(
    db,
    CODECS.agent_workspace_snapshots,
    `INSERT INTO agent_workspace_snapshots (id, agent_id, task_id, source, archive, files, bytes, tainted, taint_sources, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${snapshotColumns()}`,
    newId(),
    v.agentId,
    v.taskId,
    v.source,
    v.archive,
    v.files,
    v.bytes,
    tainted,
    [...v.taint.sources],
    v.now,
  )!;
}

/** 担当の最新の控え（次の作業場の最初の中身） */
export function getLatestAgentSnapshot(db: WsDb, agentId: Uuid): AgentWorkspaceSnapshotRow | null {
  return one<AgentWorkspaceSnapshotRow>(
    db,
    CODECS.agent_workspace_snapshots,
    `SELECT ${snapshotColumns()} FROM agent_workspace_snapshots WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    agentId,
  );
}

// 順番の依頼では、同じ実行の完了した直前タスクの成果を渡す。
// 複数入力のマージはしない。自タスクの控えがあれば再開を優先し、従来の担当の控えは最後の候補。
// claim とコマンド事前判定は必ず同じ候補・順序を使う（SG-05/07）。
function initialSandboxSnapshot<T>(db: WsDb, taskId: Uuid, projection: string): T | null {
  return one<T>(
    db,
    CODECS.agent_workspace_snapshots,
    `SELECT ${projection} FROM tasks t
     JOIN agent_workspace_snapshots s
     WHERE t.id = ? AND (
       s.agent_id = t.agent_id OR EXISTS (
         SELECT 1 FROM tasks upstream JOIN asks a ON a.id = t.ask_id
         WHERE a.shape = 'chain' AND json_array_length(t.input_task_ids) = 1
           AND upstream.id = json_extract(t.input_task_ids, '$[0]') AND s.task_id = upstream.id
           AND s.agent_id = upstream.agent_id
           AND upstream.ask_id = t.ask_id AND upstream.ask_run_id = t.ask_run_id
           AND upstream.status = 'completed'
       )
     ) ORDER BY CASE WHEN s.task_id = t.id THEN 0
                     WHEN s.task_id IN (SELECT value FROM json_each(t.input_task_ids)) AND s.agent_id <> t.agent_id THEN 1
                     ELSE 2 END, s.created_at DESC, s.id DESC LIMIT 1`,
    taskId,
  );
}

export function getInitialSandboxSnapshot(db: WsDb, taskId: Uuid): AgentWorkspaceSnapshotRow | null {
  return initialSandboxSnapshot<AgentWorkspaceSnapshotRow>(db, taskId, snapshotColumns("s."));
}

export function getInitialSandboxSnapshotTaint(db: WsDb, taskId: Uuid): SnapshotTaint | null {
  return initialSandboxSnapshot<SnapshotTaint>(db, taskId, "s.id, s.task_id, s.tainted, s.taint_sources, s.created_at");
}

/**
 * 担当の最新の控えの汚染だけ（中身の tar.gz は読まない）。次に作業場を起こしたときに受け取る控えと同じ行（getLatestAgentSnapshot と同じ並び）。
 * SG-07：作業場がまだ控えを受け取っていない（claim の前）うちに判定する run_command に、受け取る控えの汚染を先に効かせる
 */
export function getLatestAgentSnapshotTaint(db: WsDb, agentId: Uuid): SnapshotTaint | null {
  return one<SnapshotTaint>(
    db,
    CODECS.agent_workspace_snapshots,
    "SELECT id, task_id, tainted, taint_sources, created_at FROM agent_workspace_snapshots WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    agentId,
  );
}

/** タスクの最新の控え（成果のダウンロード） */
export function getLatestTaskSnapshot(db: WsDb, taskId: Uuid): AgentWorkspaceSnapshotRow | null {
  return one<AgentWorkspaceSnapshotRow>(
    db,
    CODECS.agent_workspace_snapshots,
    `SELECT ${snapshotColumns()} FROM agent_workspace_snapshots WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    taskId,
  );
}

/** タスクごとの最新の控えの大きさ（画面の「作ったファイル」。中身は読まない） */
export function listTaskSnapshotSizes(db: WsDb, taskIds: readonly Uuid[]): Map<Uuid, { files: number; bytes: number }> {
  if (taskIds.length === 0) return new Map();
  const rows = all<{ task_id: Uuid; files: number; bytes: number }>(
    db,
    {},
    `SELECT task_id, files, bytes FROM (
       SELECT task_id, files, bytes, row_number() OVER (PARTITION BY task_id ORDER BY created_at DESC, id DESC) AS rn
         FROM agent_workspace_snapshots WHERE task_id IN (SELECT value FROM json_each(?))
     ) WHERE rn = 1`,
    [...taskIds],
  );
  return new Map(rows.map((x) => [x.task_id, { files: x.files, bytes: Number(x.bytes) }]));
}

/** 古い控えを消す（担当ごとに新しい keep 件だけ残す。タスクの成果は最新の1件があれば足りる） */
export function pruneAgentSnapshots(db: WsDb, agentId: Uuid, keep: number): void {
  run(
    db,
    `DELETE FROM agent_workspace_snapshots WHERE agent_id = ?1 AND id NOT IN (
       SELECT id FROM agent_workspace_snapshots WHERE agent_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2)`,
    agentId,
    keep,
  );
}

// ---- スキル ----

/**
 * スキルを足す。同じ名前があれば中身と出どころを新しい値で上書きし、外していたら（removed_at）使える状態に戻す。
 * origin 以下は育ったスキル（learned）を承認して足すときに渡す（省略は pack のまま）
 */
export function insertAgentSkill(
  db: WsDb,
  v: {
    agentId: Uuid;
    name: string;
    description: string;
    body: string;
    packId: string | null;
    now: Date;
    origin?: SkillOrigin;
    approvedBy?: Uuid | null;
    approvedAt?: Date | null;
    approvedDigest?: string | null;
    proposalId?: Uuid | null;
  },
): AgentSkillRow {
  return one<AgentSkillRow>(
    db,
    CODECS.agent_skills,
    `INSERT INTO agent_skills (id, agent_id, name, description, body, pack_id, created_at, origin, approved_by, approved_at, approved_digest, proposal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent_id, name) DO UPDATE SET description = excluded.description, body = excluded.body, pack_id = excluded.pack_id,
       origin = excluded.origin, approved_by = excluded.approved_by, approved_at = excluded.approved_at, approved_digest = excluded.approved_digest,
       proposal_id = excluded.proposal_id, removed_at = NULL
     RETURNING *`,
    newId(),
    v.agentId,
    v.name,
    v.description,
    v.body,
    v.packId,
    v.now,
    v.origin ?? "pack",
    v.approvedBy ?? null,
    v.approvedAt ?? null,
    v.approvedDigest ?? null,
    v.proposalId ?? null,
  )!;
}

/** 担当のスキル（名前の順）。整理で外したもの（removed_at）は含めない */
export function listAgentSkills(db: WsDb, agentId: Uuid): AgentSkillRow[] {
  return all<AgentSkillRow>(db, CODECS.agent_skills, "SELECT * FROM agent_skills WHERE agent_id = ? AND removed_at IS NULL ORDER BY name", agentId);
}

// ---- パック ----

export function insertPackInstall(db: WsDb, v: { packId: string; version: number; userId: Uuid | null; agentIds: readonly Uuid[]; now: Date }): PackInstallRow | null {
  return one<PackInstallRow>(
    db,
    CODECS.pack_installs,
    `INSERT INTO pack_installs (id, pack_id, pack_version, installed_by, agent_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (pack_id) DO NOTHING RETURNING *`,
    newId(),
    v.packId,
    v.version,
    v.userId,
    [...v.agentIds],
    v.now,
  );
}

export function listPackInstalls(db: WsDb): PackInstallRow[] {
  return all<PackInstallRow>(db, CODECS.pack_installs, "SELECT * FROM pack_installs ORDER BY created_at, id");
}
