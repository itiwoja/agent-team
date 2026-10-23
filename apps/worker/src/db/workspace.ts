// ワークスペースの行（workspace。id = 1 の1行）。packages/db/src/workspace.ts の WorkspaceDO 版。
// Postgres 版の WsCtx（workspaceId で絞る）は要らない（DO そのものがワークスペース）。人の操作の利用者は引数で渡す。
// ロックの順（M-21）も要らない（DO の中は1本の流れ）

import { appendAuditLog } from "./audit.ts";
import { CODECS } from "./codecs.ts";
import { one, run, type WsDb } from "./sqlite.ts";
import type { Uuid, WorkspaceRow } from "./types.ts";

export const WORKSPACE_DEFAULTS = {
  /** 日次予算の区切り（M-59、SO I-08） */
  timezone: "Asia/Tokyo",
  maxConcurrentTasks: 3,
} as const;

const WORKSPACE_COLUMNS = `workspace_id, owner_user_id, status, timezone, max_concurrent_tasks, audit_seq, audit_last_hash, created_at, updated_at`;

/** ワークスペースの行（init の前は null） */
export function getWorkspace(db: WsDb): WorkspaceRow | null {
  return one<WorkspaceRow>(db, CODECS.workspace, `SELECT ${WORKSPACE_COLUMNS} FROM workspace WHERE id = 1`);
}

/** ワークスペースの行。init の前なら例外（業務の処理は init のあとにしか来ない） */
export function requireWorkspace(db: WsDb): WorkspaceRow {
  const ws = getWorkspace(db);
  if (!ws) throw new Error("ワークスペースの行がない（init の前）");
  return ws;
}

/**
 * 初めてならワークスペースの持ち主を入れ、監査ログの起点 workspace.created（seq 1）を足す。冪等（2回目以降は何もしない）。
 * 違う持ち主・違う ID なら例外
 */
export function initWorkspace(db: WsDb, input: { workspaceId: Uuid; ownerUserId: Uuid; now: Date }): { created: boolean } {
  return db.transaction(() => {
    const ws = getWorkspace(db);
    if (ws) {
      if (ws.workspace_id !== input.workspaceId || ws.owner_user_id !== input.ownerUserId) throw new Error("ワークスペースの持ち主が違う");
      return { created: false };
    }
    run(
      db,
      `INSERT INTO workspace (id, workspace_id, owner_user_id, timezone, max_concurrent_tasks, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
      input.workspaceId,
      input.ownerUserId,
      WORKSPACE_DEFAULTS.timezone,
      WORKSPACE_DEFAULTS.maxConcurrentTasks,
      input.now,
      input.now,
    );
    appendAuditLog(db, { eventType: "workspace.created", actorType: "system", actorId: "app", payload: { kind: "owner" } }, input.now);
    return { created: true };
  });
}
