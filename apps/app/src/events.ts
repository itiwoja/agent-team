// ワークスペースの事象の配り手（SSE。AS §3.14・8-4、ADR-007、M-53）
// 事象は workspace_events に書き（appendWorkspaceEvent。業務の変更と同じトランザクション）、NOTIFY には '<workspaceId>:<id>' だけを載せる。
// 各インスタンスは LISTEN の接続を1本だけ持ち、通知の来たワークスペースの SSE の接続を起こす。起こされた接続は自分のカーソルより
// 後の行を DB から読む（通知は「読みに行け」の合図だけ。本体はいつも行から読むので、通知が落ちても次の見回りで取り戻せる）
// 決めたこと：payload に workspaceId を足した（id だけだと、どのワークスペースの接続を起こすかを知るのにワークスペースで絞らない
// 問い合わせが要る）。id だけの payload（ほかの書き手）を受けたら全部の接続を起こす

import type { Db, Listener, Uuid } from "@open-team/db";
import { WORKSPACE_EVENTS_CHANNEL } from "@open-team/db/app";
import type { Logger } from "@open-team/platform";

export interface WorkspaceEventHub {
  /** そのワークスペースに事象が増えたら wake を呼ぶ。戻り値で外す */
  subscribe(workspaceId: Uuid, wake: () => void): () => void;
  /** そのワークスペースの接続を起こす */
  wake(workspaceId: Uuid): void;
  /** すべての接続を起こす */
  wakeAll(): void;
  /** LISTEN を張る（2回目からは何もしない） */
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly listening: boolean;
  /** 今の接続の数（試験・ログ） */
  readonly subscriberCount: number;
}

const PAYLOAD_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+)$/i;

export function createWorkspaceEventHub(deps: { db: Db; log: Logger }): WorkspaceEventHub {
  const subscribers = new Map<string, Set<() => void>>();
  let listener: Listener | null = null;
  let starting: Promise<void> | null = null;

  const call = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      deps.log.warn("sse.wake_failed", "SSE の接続を起こせなかった", { error });
    }
  };
  const hub: WorkspaceEventHub = {
    subscribe(workspaceId, wake) {
      const ws = workspaceId.toLowerCase();
      const set = subscribers.get(ws) ?? new Set();
      set.add(wake);
      subscribers.set(ws, set);
      return () => {
        const s = subscribers.get(ws);
        if (!s) return;
        s.delete(wake);
        if (s.size === 0) subscribers.delete(ws);
      };
    },
    wake(workspaceId) {
      for (const fn of subscribers.get(workspaceId.toLowerCase()) ?? []) call(fn);
    },
    wakeAll() {
      for (const set of subscribers.values()) for (const fn of set) call(fn);
    },
    async start() {
      if (listener) return;
      starting ??= deps.db
        .listen(WORKSPACE_EVENTS_CHANNEL, (payload) => {
          const m = PAYLOAD_RE.exec(payload.trim());
          if (m?.[1]) hub.wake(m[1]);
          else hub.wakeAll();
        })
        .then((l) => {
          listener = l;
        })
        .finally(() => {
          starting = null;
        });
      await starting;
    },
    async stop() {
      const l = listener;
      listener = null;
      await l?.unlisten().catch(() => {});
    },
    get listening() {
      return listener !== null;
    },
    get subscriberCount() {
      let n = 0;
      for (const s of subscribers.values()) n += s.size;
      return n;
    },
  };
  return hub;
}
