// postEvents（API-038）の試験：1回20件・毎秒10件（finished は数えない）・ハートビート・finished で failed とトークンの失効
// （formation-runtime.md §2.6・§3.12 の finish、si:133・135、rt:152、HL-03・HL-24）
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@open-team/kernel";
import { EdgeError, type ProgressEvent } from "@open-team/runner";
import { useTestDb } from "@open-team/db/testing";
import type { Db } from "@open-team/db";
import { buildEdge, llmRequest, mcp, USAGE } from "./__fixtures__/env.ts";
import { T0, fxWorkspace, seedAgent, seedConnectors, seedTask, supplierDefinition, tokenFor } from "./__fixtures__/seed.ts";

const T = useTestDb();

async function running(db: Db, script: Parameters<typeof buildEdge>[1] = {}) {
  const ws = await fxWorkspace(db, { kind: "guest", audit: true });
  await seedConnectors(db, ws);
  const agent = await seedAgent(db, ws, supplierDefinition());
  const taskId = await seedTask(db, ws, agent, "reorder");
  const token = await tokenFor(db, ws, taskId);
  const env = buildEdge(db, script);
  const ctx = await env.edge.getTaskContext(token);
  return { ws, taskId, token, env, ctx };
}

const msg = (i: number): ProgressEvent => ({ type: "message", payload: { text: `m${i}` } });

async function expectEdgeError(p: Promise<unknown>, code: string): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(EdgeError);
  expect((e as EdgeError).code).toBe(code);
}

describe("postEvents（API-038）", () => {
  it("rt:152 毎秒10件まで受け付け、超えた分は捨てて dropped。1秒たてばまた受け付ける", async () => {
    const { db } = T();
    const w = await running(db);
    expect(await w.env.edge.postEvents(w.token, Array.from({ length: 8 }, (_, i) => msg(i)))).toEqual({ accepted: 8, dropped: 0 });
    expect(await w.env.edge.postEvents(w.token, Array.from({ length: 5 }, (_, i) => msg(i)))).toEqual({ accepted: 2, dropped: 3 });
    w.env.clock.advance(1_000);
    expect(await w.env.edge.postEvents(w.token, [msg(1)])).toEqual({ accepted: 1, dropped: 0 });
    const n = (await db.query("SELECT 1 FROM task_events WHERE task_id = $1 AND type = 'message'", [w.taskId])).rowCount;
    expect(n).toBe(11);
  });

  it("HL-24 1回に25件 → 20件まで考え、毎秒10件の上限で10件を受け付け、残り15件は dropped", async () => {
    const { db } = T();
    const w = await running(db, { limits: { eventsPerSecond: 100 } });
    expect(await w.env.edge.postEvents(w.token, Array.from({ length: 25 }, (_, i) => msg(i)))).toEqual({ accepted: 20, dropped: 5 });
    const def = await running(db);
    expect(await def.env.edge.postEvents(def.token, Array.from({ length: 25 }, (_, i) => msg(i)))).toEqual({ accepted: 10, dropped: 15 });
  });

  it("保存する値はマスクして上限で切る（resultSummary 500文字）。by: runner。ハートビートを更新する", async () => {
    const { db } = T();
    const w = await running(db);
    w.env.clock.set(T0.getTime() + 30_000);
    await w.env.edge.postEvents(w.token, [
      { type: "phase_started", payload: { phase: "計画" } },
      { type: "tool_called", payload: { toolCallId: "c1", name: "mcp_call", resultSummary: "あ".repeat(600) } },
      { type: "message", payload: { text: "鍵は sk-abcdefghijklmnopqrstuv です" } },
    ]);
    const rows = (await db.query<{ type: string; payload: JsonObject }>("SELECT type, payload FROM task_events WHERE task_id = $1 AND payload->>'by' = 'runner' ORDER BY id", [w.taskId])).rows;
    expect(rows.map((r) => r.type)).toEqual(["phase_started", "tool_called", "message"]);
    expect([...(rows[1]!.payload.resultSummary as string)].length).toBe(500);
    expect(rows[2]!.payload.text).toBe("鍵は [REDACTED] です");
    const hb = (await db.query<{ last_heartbeat_at: Date }>("SELECT last_heartbeat_at FROM tasks WHERE id = $1", [w.taskId])).rows[0]!;
    expect(hb.last_heartbeat_at.getTime()).toBe(T0.getTime() + 30_000);
  });

  it("形が違う進捗は 400 VALIDATION_ERROR（種類・payload の項目）", async () => {
    const { db } = T();
    const w = await running(db);
    await expectEdgeError(w.env.edge.postEvents(w.token, [{ type: "unknown", payload: {} } as unknown as ProgressEvent]), "VALIDATION_ERROR");
    await expectEdgeError(w.env.edge.postEvents(w.token, [{ type: "message", payload: { text: "x", extra: 1 } } as unknown as ProgressEvent]), "VALIDATION_ERROR");
  });

  it("HL-03 finished(no_change) → failed(agent_no_change)、トークン失効、承認待ちの Intent は expired(task_ended)（IA §8-7）。finished は毎秒の上限に数えない", async () => {
    const { db } = T();
    const w = await running(db, {
      script: [{ parts: [mcp("w1", "supplier", "place_order", { supplier_id: "supplier-01", items: [{ sku: "BEAN-01", quantity: 2, unit_price: 1800 }] })], usage: USAGE }],
    });
    await w.env.edge.llmMessages(w.token, llmRequest(w.ctx.tools));
    // 毎秒の上限を使い切ってから finished
    await w.env.edge.postEvents(w.token, Array.from({ length: 10 }, (_, i) => msg(i)));
    expect(await w.env.edge.postEvents(w.token, [{ type: "finished", payload: { outcome: "no_change", reason: "発注は要りません" } }])).toEqual({ accepted: 1, dropped: 0 });
    const t = (await db.query<{ status: string; fail_reason: string; task_token_hash: Buffer | null; finished_at: Date | null }>(
      "SELECT status, fail_reason, task_token_hash, finished_at FROM tasks WHERE id = $1",
      [w.taskId],
    )).rows[0]!;
    expect(t).toMatchObject({ status: "failed", fail_reason: "agent_no_change", task_token_hash: null });
    expect(t.finished_at).not.toBeNull();
    const intent = (await db.query<{ status: string; expire_reason: string }>("SELECT status, expire_reason FROM action_intents WHERE task_id = $1", [w.taskId])).rows[0]!;
    expect(intent).toEqual({ status: "expired", expire_reason: "task_ended" });
    const approval = (await db.query<{ status: string }>("SELECT status FROM approvals WHERE task_id = $1", [w.taskId])).rows[0]!;
    expect(approval.status).toBe("expired");
    expect(w.env.hooks.at(-1)).toEqual({ hook: "onTaskTerminal", taskId: w.taskId, status: "failed" });
    await expectEdgeError(w.env.edge.llmMessages(w.token, llmRequest([])), "UNAUTHORIZED");
  });

  it("finished(unable) → failed(agent_unable)", async () => {
    const { db } = T();
    const w = await running(db);
    await w.env.edge.postEvents(w.token, [{ type: "finished", payload: { outcome: "unable", reason: "続けられない" } }]);
    const t = (await db.query<{ status: string; fail_reason: string }>("SELECT status, fail_reason FROM tasks WHERE id = $1", [w.taskId])).rows[0]!;
    expect(t).toEqual({ status: "failed", fail_reason: "agent_unable" });
  });
});
