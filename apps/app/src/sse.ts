// EP-45 GET /api/v1/workspaces/{workspaceId}/stream（AS §3.14、ADR-007、09_api/tasks.md:226-240）
// 形式：id: <workspace_events.id>／event: <type>／data: <JSON 1行>。15秒ごとに ": heartbeat"、55分でサーバーから切る。
// Last-Event-ID（なければクエリ lastEventId）より後の事象を id の昇順で送り、以後は通知で起こされたら続きを読む。
// 決めたこと（AS §3.14 の [おすすめ] を具体にした）：
// - Last-Event-ID がない：今の最新から（それまでの事象は送らない。画面は REST で取り直してからつなぐ）。最初に id: だけの
//   メッセージを送り、ブラウザの lastEventId を今の位置に合わせる（つなぎ直しで取りこぼさない）
// - Last-Event-ID = 0：残っている事象をすべて（つないだ時点で事象がなかった接続のつなぎ直し）
// - Last-Event-ID の行がこのワークスペースに残っていない（保持期間の24時間を過ぎた・ほかのワークスペースの ID）：
//   event: reset（id は今の最新）を送り、そこから続ける。画面は取り直す
// - 見回り：ハートビートのたびにも続きを読む（NOTIFY が落ちても15秒で追いつく）

import type { Db, WorkspaceEventRow, WsCtx } from "@open-team/db";
import { latestWorkspaceEventId, listWorkspaceEventsAfter, workspaceEventExists } from "@open-team/db/app";
import type { Logger } from "@open-team/platform";
import type { WorkspaceEventHub } from "./events.ts";

export interface SseOptions {
  /** 既定 15秒 */
  heartbeatMs: number;
  /** 既定 55分（Cloud Run の60分の前：09_api/tasks.md:228） */
  maxDurationMs: number;
  /** 1回に読む行の数（既定 100） */
  batchSize: number;
}

export const DEFAULT_SSE_OPTIONS: SseOptions = { heartbeatMs: 15_000, maxDurationMs: 55 * 60 * 1000, batchSize: 100 };

export interface SseDeps {
  db: Db;
  eventHub: WorkspaceEventHub;
  log: Logger;
  sse: SseOptions;
}

const encoder = new TextEncoder();

/** 1件の事象の SSE の文。type は workspace_events の CHECK（小文字と . と _）なので改行を含まない。data は JSON 1行 */
export function formatSseEvent(row: Pick<WorkspaceEventRow, "id" | "type" | "data">): string {
  return `id: ${row.id}\nevent: ${row.type}\ndata: ${JSON.stringify(row.data)}\n\n`;
}

/** Last-Event-ID（ヘッダーかクエリ）を読む。ない → null、0以上の整数でない → undefined（400） */
export function parseLastEventId(header: string | undefined, query: string | undefined): number | null | undefined {
  const raw = (header ?? query)?.trim();
  if (raw === undefined || raw === "") return null;
  if (!/^\d{1,15}$/.test(raw)) return undefined;
  return Number(raw);
}

/** SSE の応答を作る（ワークスペースとセッションの確認は呼ぶ側） */
export async function workspaceStream(deps: SseDeps, ctx: WsCtx, lastEventId: number | null, signal: AbortSignal): Promise<Response> {
  // 始まりの位置を決める（応答を返す前に読む。DB に届かなければ 500 の JSON になる）
  let cursor: number;
  let opening: string;
  if (lastEventId === null) {
    cursor = await latestWorkspaceEventId(deps.db, ctx);
    opening = `id: ${cursor}\n\n`;
  } else if (lastEventId === 0 || (await workspaceEventExists(deps.db, ctx, lastEventId))) {
    cursor = lastEventId;
    opening = ": resume\n\n";
  } else {
    cursor = await latestWorkspaceEventId(deps.db, ctx);
    opening = `id: ${cursor}\nevent: reset\ndata: {}\n\n`;
  }

  let closed = false;
  let pumping = false;
  let again = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    if (heartbeat) clearInterval(heartbeat);
    if (deadline) clearTimeout(deadline);
    signal.removeEventListener("abort", onAbort);
  };
  const write = (text: string): void => {
    if (closed || !ctrl) return;
    try {
      ctrl.enqueue(encoder.encode(text));
    } catch {
      cleanup();
    }
  };
  const finish = (): void => {
    const c = ctrl;
    cleanup();
    try {
      c?.close();
    } catch {
      // すでに閉じた・取り消された
    }
  };
  function onAbort(): void {
    cleanup();
  }

  // 続きを読んで送る（同時に1つだけ。読んでいる間に起こされたら、終わってからもう一度読む）
  const pump = async (): Promise<void> => {
    if (closed) return;
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        for (;;) {
          const rows = await listWorkspaceEventsAfter(deps.db, ctx, cursor, deps.sse.batchSize);
          if (closed) return;
          for (const row of rows) {
            write(formatSseEvent(row));
            cursor = row.id;
          }
          if (rows.length < deps.sse.batchSize) break;
        }
      } while (again && !closed);
    } catch (error) {
      deps.log.warn("sse.read_failed", "SSE の事象を読めなかった（次の通知・ハートビートで読み直す）", { workspaceId: ctx.workspaceId, error });
    } finally {
      pumping = false;
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
      write(opening);
      unsubscribe = deps.eventHub.subscribe(ctx.workspaceId, () => void pump());
      heartbeat = setInterval(() => {
        write(": heartbeat\n\n");
        void pump();
      }, deps.sse.heartbeatMs);
      deadline = setTimeout(finish, deps.sse.maxDurationMs);
      if (signal.aborted) cleanup();
      else signal.addEventListener("abort", onAbort, { once: true });
      void pump();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      // 途中のプロキシに溜めさせない（圧縮もしない）
      "x-accel-buffering": "no",
    },
  });
}
