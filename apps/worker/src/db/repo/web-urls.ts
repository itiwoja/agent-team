// タスクが見た URL の集合（packages/db/src/repo/web-urls.ts の WorkspaceDO 版。SG-04・D-30。task_web_urls）。
// 汚染後の web_fetch は、この集合にある URL だけを取れる。
// 持つのは edge が正規化した URL の SHA-256（32バイト）だけ。正規化と、何を入れるかは edge の web-seen.ts が決める。
// 別のワークスペースのタスクは DO の中にないので、写す元・照らす先は自分のワークスペースのタスクだけになる

import { Buffer } from "node:buffer";
import { count, one, run, type WsDb } from "../sqlite.ts";
import type { Uuid } from "../types.ts";

/**
 * 1タスクの集合の上限。超えた分は足さない（古いものを捨てない＝あとから見たリンクが辿れなくなる側に倒す）。
 * 根拠：web_fetch の既定の上限の回数ぶんのページから十分な数のリンクを覚えつつ、1タスクの行の数を抑える（edge の SEEN_URLS_MAX_PER_TASK）
 */
export const TASK_WEB_URLS_MAX = 2_000;

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

/** 16進64桁 → 32バイト（形が違えば例外） */
function urlHashBytes(h: string): Buffer {
  if (!HEX64_RE.test(h)) throw new TypeError(`URL の鍵が16進64桁ではない：${h.slice(0, 16)}`);
  return Buffer.from(h, "hex");
}

function room(db: WsDb, taskId: Uuid, max: number): number {
  return Math.max(max - count(db, "SELECT count(*) FROM task_web_urls WHERE task_id = ?", taskId), 0);
}

/**
 * 集合に足す。urlHashes は見た順に（先のものほど上限に収まりやすい）。集合が max 件に達したら、それより先は足さない。
 * すでにある鍵は数えない。数えてから足すまでは1つのトランザクション。足した件数を返す
 */
export function addTaskWebUrls(db: WsDb, taskId: Uuid, urlHashes: readonly string[], max: number, now: Date): number {
  if (urlHashes.length === 0) return 0;
  const bytes = urlHashes.map(urlHashBytes);
  return db.transaction(() => {
    const n = room(db, taskId, max);
    let added = 0;
    for (const b of bytes) {
      if (added >= n) break;
      added += run(db, "INSERT OR IGNORE INTO task_web_urls (task_id, url_hash, created_at) VALUES (?, ?, ?)", taskId, b, now);
    }
    return added;
  });
}

/**
 * 引き継ぎ元のタスク（受け渡しの入力・追いのターンの親）の集合を写す。
 * 元で先に見たものから、集合が max 件に達するまで。写した件数を返す
 */
export function copyTaskWebUrls(db: WsDb, taskId: Uuid, fromTaskIds: readonly Uuid[], max: number, now: Date): number {
  const from = fromTaskIds.filter((id) => id !== taskId);
  if (from.length === 0) return 0;
  return db.transaction(() => {
    const n = room(db, taskId, max);
    if (n === 0) return 0;
    return run(
      db,
      `INSERT OR IGNORE INTO task_web_urls (task_id, url_hash, created_at)
       SELECT ?, url_hash, ? FROM (
         SELECT s.url_hash, min(s.created_at) AS first_seen
           FROM task_web_urls s
          WHERE s.task_id IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (SELECT 1 FROM task_web_urls d WHERE d.task_id = ? AND d.url_hash = s.url_hash)
          GROUP BY s.url_hash
       )
       ORDER BY first_seen, url_hash LIMIT ?`,
      taskId,
      now,
      from,
      taskId,
      n,
    );
  });
}

/** 集合にあるか（urlHash は正規化した URL の SHA-256 の16進） */
export function hasTaskWebUrl(db: WsDb, taskId: Uuid, urlHash: string): boolean {
  if (!HEX64_RE.test(urlHash)) return false;
  return one(db, {}, "SELECT 1 AS ok FROM task_web_urls WHERE task_id = ? AND url_hash = ?", taskId, Buffer.from(urlHash, "hex")) !== null;
}
