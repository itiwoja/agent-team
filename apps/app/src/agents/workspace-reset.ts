// 担当の作業場を最初に戻す（POST /agents/{agentId}/workspace/reset。SG-07 の最終監査の直し）。
// 作業場の控えは「担当の最新の控え → 次の作業場」の鎖で、汚染された控えのあとはずっと汚染として数える（SG-05）。
// 外の内容を読んだあとの控えが残ると、その担当はテストを自動で動かせなくなる。オーナーが中身を捨てて最初に戻す手段がこれ。
// 1つのトランザクションで：Kill Switch 中は 423 → 担当がいなければ 404 → その担当の動いているタスクが作業場を開いていれば 409 →
// パックから入った担当ならパックのファイル、そうでなければ空の控え（source = 'reset'・汚染なし）を足す → 監査ログ agent.workspace.reset。
// 前の控えは消さない（控えは書き換えない：0013。古い控えの整理は pruneAgentSnapshots）

import { appendAuditLog, lockWorkspace, type SessionCtx, type Uuid } from "@open-team/db";
import { getLatestAgentSnapshotTaint, insertWorkspaceSnapshot, listPackInstalls } from "@open-team/db/sandbox";
import { EMPTY_TAINT, type JsonObject } from "@open-team/kernel";
import { AppError } from "@open-team/platform";
import { createTarGz } from "@open-team/sandbox";
import type { AppDeps } from "../deps.ts";
import { findPack } from "../packs/catalog.ts";
import type { ResetAgentWorkspaceResponse } from "./contract.ts";

/** パックの担当の仕事の slug は 'pack-<担当の key>'（packs/install.ts） */
const PACK_JOB_PREFIX = "pack-";

export async function resetAgentWorkspace(deps: Pick<AppDeps, "db" | "clock">, s: SessionCtx, agentId: Uuid): Promise<ResetAgentWorkspaceResponse> {
  return deps.db.transaction(async (tx) => {
    const now = deps.clock.now();
    const ws = await lockWorkspace(tx, s);
    if (ws === null) throw new AppError("NOT_FOUND");
    if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");
    const agent = (
      await tx.query<{ id: Uuid; name: string }>("SELECT id, name FROM agents WHERE workspace_id = $1 AND id = $2 AND status <> 'removed'", [s.workspaceId, agentId])
    ).rows[0];
    if (agent === undefined) throw new AppError("NOT_FOUND");

    // 作業場が動いている間は戻さない（動いているタスクが受け取った中身と、戻した中身が食い違う）。
    // 作業場を開くとき（edge の ensureSession）もワークスペースをロックするので、この確認と足す控えの間に開かれない
    const busy = await tx.query(
      `SELECT 1 FROM sandbox_sessions ss JOIN tasks t ON t.workspace_id = ss.workspace_id AND t.id = ss.task_id
        WHERE ss.workspace_id = $1 AND ss.agent_id = $2 AND ss.status <> 'closed' AND t.status = 'running' LIMIT 1`,
      [s.workspaceId, agentId],
    );
    if (busy.rows.length > 0) throw new AppError("WORKSPACE_IN_USE");

    const previous = await getLatestAgentSnapshotTaint(tx, s, agentId);
    // 戻した控えが「担当の最新の控え」になるように、前の控えより後の時刻で残す（時計がずれていても前の控えに負けない）
    const at = previous !== null && previous.created_at.getTime() >= now.getTime() ? new Date(previous.created_at.getTime() + 1) : now;

    // パックから入った担当なら、パックのファイル（運営のパックの定数）に戻す
    const install = (await listPackInstalls(tx, s)).find((i) => Array.isArray(i.agent_ids) && i.agent_ids.includes(agentId));
    const pack = install === undefined ? undefined : findPack(install.pack_id);
    let packAgentKey: string | null = null;
    if (pack !== undefined) {
      const slugs = (await tx.query<{ slug: string }>("SELECT slug FROM agent_jobs WHERE workspace_id = $1 AND agent_id = $2", [s.workspaceId, agentId])).rows.map((r) => r.slug);
      packAgentKey = pack.agents.find((a) => slugs.includes(`${PACK_JOB_PREFIX}${a.key}`))?.key ?? null;
    }
    const packFiles = pack?.agents.find((a) => a.key === packAgentKey)?.files ?? [];
    const files = packFiles.map((f) => ({ path: f.path, content: Buffer.from(f.content, "utf8"), ...(f.executable ? { executable: true } : {}) }));
    const origin: "pack" | "empty" = files.length > 0 ? "pack" : "empty";

    const snap = await insertWorkspaceSnapshot(tx, s, {
      agentId,
      taskId: null,
      source: "reset",
      archive: createTarGz(files),
      files: files.length,
      bytes: files.reduce((n, f) => n + f.content.length, 0),
      taint: EMPTY_TAINT,
      now: at,
    });

    await appendAuditLog(
      tx,
      s.workspaceId,
      {
        eventType: "agent.workspace.reset",
        actorType: "user",
        actorId: s.userId,
        payload: {
          agentId,
          name: agent.name,
          previousSnapshotId: previous?.id ?? null,
          previousTainted: previous?.tainted ?? false,
          previousTaintSources: (previous?.taint_sources ?? []) as unknown as JsonObject[],
          snapshotId: snap.id,
          origin,
          packId: origin === "pack" ? (pack?.id ?? null) : null,
          files: files.map((f) => f.path),
        },
      },
      now,
    );
    return { agentId, snapshotId: snap.id, origin, files: files.map((f) => f.path), resetAt: snap.created_at.toISOString() };
  });
}
