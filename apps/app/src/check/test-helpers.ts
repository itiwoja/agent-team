// 承認・チェック・ゲストの試験の道具（本番では読み込まれない）
// ゲストの入口は本物の経路（EP-01 → ゲストのワークスペースとデモ用のデータ）を使い、偽の gateway・同じプロセスの sim-world につなぐ

import type { Db } from "@open-team/db";
import type { AppEnv } from "../env.ts";
import { GatewayClientError, type GwExecuteResponse } from "@open-team/gateway-client";
import { PostgresSimStore } from "@open-team/sim-world";
import { GUEST_TOKEN, OWNER_TOKEN, T0, fakeGatewayClient, inProcessSimWorld, makeTestApp, send, sessionCookieOf, type FakeGateway, type TestApp } from "../test-helpers.ts";

export interface GuestHarness {
  t: TestApp;
  gateway: FakeGateway & { executed: string[]; /** 次の実行から gateway に届かない（null で戻す） */
  failExecute(status: number | null): void };
}

/** Intent の実行を DB に書くだけの偽の gateway（本物は apps/gateway。実行の経路は gateway の試験が持つ）。executed に ID が残る */
export function guestHarness(db: Db, o: { executeResult?: "executed" | "unknown_outcome"; env?: Partial<AppEnv> } = {}): GuestHarness {
  const base = fakeGatewayClient(db);
  const executed: string[] = [];
  let failure: number | null = null;
  const gateway = Object.assign(base, {
    executed,
    failExecute: (status: number | null) => {
      failure = status;
    },
    async executeIntent(intentId: string): Promise<GwExecuteResponse> {
      if (failure !== null) throw new GatewayClientError(failure, "UPSTREAM");
      executed.push(intentId);
      const status = o.executeResult ?? "executed";
      await db.query(
        `UPDATE action_intents SET status = $2, executed_at = CASE WHEN $2 = 'executed' THEN now() ELSE NULL END, updated_at = now()
          WHERE id = $1 AND status = 'approved'`,
        [intentId, status],
      );
      return { intentId, status, failReason: null, expiredReason: null };
    },
  });
  // sim-world の保存は Postgres（タスクの sim_snapshot_id の外部キーが sim.snapshots を指すので、本番と同じ保存で通す）
  const sim = inProcessSimWorld({ now: () => T0 }, new PostgresSimStore(db));
  const t = makeTestApp(db, { ...(o.env ? { env: o.env } : {}), deps: { gatewayClient: gateway, simClient: sim.simClient } });
  return { t, gateway };
}

export interface GuestSession {
  cookie: string;
  csrf: string;
  workspaceId: string;
  userId: string;
  firstAskId: string;
}

/** 審査用のトークンで入る（新しいゲストのワークスペースができる） */
export async function enterGuest(t: TestApp): Promise<GuestSession> {
  const res = await send(t, "POST", "/api/v1/entry", { body: { token: GUEST_TOKEN } });
  if (res.status !== 200) throw new Error(`ゲストで入れなかった：${res.status} ${await res.text()} ${JSON.stringify(t.logs.filter((l) => l.severity === "ERROR").slice(-2))}`);
  const cookie = sessionCookieOf(res);
  if (!cookie) throw new Error("Cookie が出なかった");
  const body = (await res.json()) as { firstAskId: string };
  const me = (await (await send(t, "GET", "/api/v1/me", { cookie })).json()) as { csrfToken: string; workspace: { id: string }; user: { id: string } };
  return { cookie, csrf: me.csrfToken, workspaceId: me.workspace.id, userId: me.user.id, firstAskId: body.firstAskId };
}

export const call = async <T = unknown>(t: TestApp, s: Pick<GuestSession, "cookie" | "csrf">, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const res = await send(t, method, path, { cookie: s.cookie, csrf: s.csrf, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text === "" ? null : JSON.parse(text)) as T };
};

export { GUEST_TOKEN, OWNER_TOKEN };
