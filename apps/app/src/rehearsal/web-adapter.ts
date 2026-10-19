// リハーサルの Web（web_search・web_fetch）を模擬の世界に向ける口（edge の RehearsalWeb）。sim-world の POST /executions/:id/web を呼ぶ。
// edge は口を1つしか受け取らず、呼び出しに実行の ID を渡さないので、走らせるタスクの実行（runVariant）が bind で今の実行を決める。
// 走行は1本ずつ順に走るので、bind した実行が今のタスクの実行になる。

import type { SimClient } from "@open-team/sim-client";
import type { EdgeDeps } from "@open-team/edge";

/** edge の口（EdgeDeps.rehearsalWeb の形） */
type RehearsalWeb = NonNullable<EdgeDeps["rehearsalWeb"]>;

export interface RehearsalWebBinding {
  web: RehearsalWeb;
  /** これから走らせるタスクの実行（sim の execution）を決める */
  bind(executionId: string): void;
}

export function rehearsalWebOf(simClient: Pick<SimClient, "webFetch" | "webSearch">, workspaceId: string): RehearsalWebBinding {
  let executionId: string | null = null;
  const current = (): string => {
    if (executionId === null) throw new Error("リハーサルの Web を呼ぶ実行が決まっていない");
    return executionId;
  };
  const web: RehearsalWeb = {
    async fetch({ url, signal }) {
      const r = await simClient.webFetch({ workspaceId, executionId: current() }, url, signal === undefined ? {} : { signal });
      if (r.result.kind !== "fetch") throw new Error(`sim-world の応答が取得ではない：${r.result.kind}`);
      if (r.result.status === 404) return { status: 404, title: null, body: r.result.message, finalUrl: url };
      return { status: 200, title: r.result.title, body: r.result.body, finalUrl: url };
    },
    async search({ query, signal, maxResults }) {
      const r = await simClient.webSearch({ workspaceId, executionId: current() }, query, signal === undefined ? {} : { signal }, maxResults);
      if (r.result.kind !== "search") throw new Error(`sim-world の応答が検索ではない：${r.result.kind}`);
      return r.result.results.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet }));
    },
  };
  return {
    web,
    bind(id) {
      executionId = id;
    },
  };
}
