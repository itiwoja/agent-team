// タスクが見た URL の集合（SG-04・D-30。task_web_urls：0016）。汚染後の web_fetch は、この集合にある URL だけを取れる。
// 持つのは edge が正規化した URL の SHA-256（16進 64 字）だけ。正規化と、何を入れるかは edge の web-seen.ts が決める。
// 足す・写す・照らすはどれも ctx.workspaceId で絞る（別のワークスペースのタスクの集合は読まない・写さない）

import type { Queryable, Tx } from "../client.ts";
import type { Uuid } from "../types.ts";
import type { WsCtx } from "../workspace.ts";

/**
 * 1タスクの集合の上限。超えた分は足さない（古いものを捨てない＝あとから見たリンクが辿れなくなる側に倒す）。
 * 根拠：web_fetch の既定の上限の回数ぶんのページから十分な数のリンクを覚えつつ、1タスクの行の数を抑える（edge の SEEN_URLS_MAX_PER_TASK）
 */
export const TASK_WEB_URLS_MAX = 2_000;

/**
 * 集合に足す。urlHashes は見た順に（先のものほど上限に収まりやすい）。集合が max 件に達したら、それより先は足さない。
 * 呼ぶ側はタスクの行を FOR UPDATE してから呼ぶか、タスクを作ったのと同じトランザクションで呼ぶ（数えてから足すまでを直列にする）。足した件数を返す
 */
export async function addTaskWebUrls(tx: Tx, ctx: WsCtx, taskId: Uuid, urlHashes: readonly string[], max: number, now: Date): Promise<number> {
  if (urlHashes.length === 0) return 0;
  const r = await tx.query(
    `WITH room AS (
       SELECT GREATEST($4::int - count(*)::int, 0) AS n FROM task_web_urls WHERE workspace_id = $1 AND task_id = $2
     ), fresh AS (
       SELECT decode(h, 'hex') AS url_hash, min(ord) AS ord
         FROM unnest($3::text[]) WITH ORDINALITY AS u(h, ord)
        WHERE NOT EXISTS (SELECT 1 FROM task_web_urls s WHERE s.task_id = $2 AND s.url_hash = decode(u.h, 'hex'))
        GROUP BY 1
     )
     INSERT INTO task_web_urls (workspace_id, task_id, url_hash, created_at)
     SELECT $1, $2, url_hash, $5 FROM fresh ORDER BY ord LIMIT (SELECT n FROM room)
     ON CONFLICT DO NOTHING`,
    [ctx.workspaceId, taskId, [...urlHashes], max, now],
  );
  return r.rowCount;
}

/**
 * 引き継ぎ元のタスク（受け渡しの入力・追いのターンの親）の集合を写す。同じワークスペースのタスクのものだけ。
 * 元で先に見たものから、集合が max 件に達するまで。写した件数を返す
 */
export async function copyTaskWebUrls(tx: Tx, ctx: WsCtx, taskId: Uuid, fromTaskIds: readonly Uuid[], max: number, now: Date): Promise<number> {
  const from = fromTaskIds.filter((id) => id !== taskId);
  if (from.length === 0) return 0;
  const r = await tx.query(
    `WITH room AS (
       SELECT GREATEST($4::int - count(*)::int, 0) AS n FROM task_web_urls WHERE workspace_id = $1 AND task_id = $2
     ), src AS (
       SELECT url_hash, min(created_at) AS first_seen
         FROM task_web_urls s
        WHERE s.workspace_id = $1 AND s.task_id = ANY($3::uuid[])
          AND NOT EXISTS (SELECT 1 FROM task_web_urls d WHERE d.task_id = $2 AND d.url_hash = s.url_hash)
        GROUP BY url_hash
     )
     INSERT INTO task_web_urls (workspace_id, task_id, url_hash, created_at)
     SELECT $1, $2, url_hash, $5 FROM src ORDER BY first_seen, url_hash LIMIT (SELECT n FROM room)
     ON CONFLICT DO NOTHING`,
    [ctx.workspaceId, taskId, [...from], max, now],
  );
  return r.rowCount;
}

/** 集合にあるか（urlHash は正規化した URL の SHA-256 の16進）。ワークスペースでも絞る（別のワークスペースから同じタスクの id を渡しても通らない） */
export async function hasTaskWebUrl(q: Queryable, ctx: WsCtx, taskId: Uuid, urlHash: string): Promise<boolean> {
  const r = await q.query<{ ok: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM task_web_urls WHERE workspace_id = $1 AND task_id = $2 AND url_hash = decode($3, 'hex')) AS ok",
    [ctx.workspaceId, taskId, urlHash],
  );
  return r.rows[0]?.ok === true;
}
