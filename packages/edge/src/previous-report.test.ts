// 定期の実行（見張り）の「前回の報告」：同じ担当の前の回の報告は、受け渡しではなく previousReport として渡す。
// 定期でない実行（返事など）で前の回のタスクを受けたときは、これまでどおり受け渡しとして渡す
import { describe, expect, it } from "vitest";
import type { Db, Uuid } from "@open-team/db";
import { useTestDb } from "@open-team/db/testing";
import { buildEdge } from "./__fixtures__/env.ts";
import { T0, fxWorkspace, inboxDefinition, seedAgent, seedChainAsk, seedShopConnectors, seedTask, supplierDefinition, tokenFor } from "./__fixtures__/shop.ts";

const T = useTestDb();

async function setup(db: Db, trigger: "schedule" | "manual") {
  const ws = await fxWorkspace(db, { kind: "owner", audit: true });
  await seedShopConnectors(db, ws);
  const inbox = await seedAgent(db, ws, inboxDefinition());
  const supplier = await seedAgent(db, ws, supplierDefinition());
  const ask = await seedChainAsk(db, ws, [
    { agent: inbox, jobSlug: "read-supplier-mail", position: 1, spokesperson: false },
    { agent: supplier, jobSlug: "reorder", position: 2, spokesperson: true },
  ]);
  // 1回目：受信箱係が報告を出して終わった
  const prev = await seedTask(db, ws, inbox, "read-supplier-mail", { ask, memberName: "受信箱係" });
  await db.query(
    "UPDATE tasks SET status = 'succeeded', started_at = $2, finished_at = $2, report = '新しい日程はありません', report_title = '見張り', report_kind = 'normal' WHERE id = $1",
    [prev, T0],
  );
  // 2回目（定期 or 返事）：同じ担当が前の回のタスクを受けて始まる
  const run2 = (
    await db.query<{ id: Uuid }>("INSERT INTO ask_runs (workspace_id, ask_id, run_no, trigger_type, started_at) VALUES ($1, $2, 2, $3, $4) RETURNING id", [
      ws.workspaceId,
      ask.askId,
      trigger,
      T0,
    ])
  ).rows[0]!.id;
  const task = await seedTask(db, ws, inbox, "read-supplier-mail", { ask: { ...ask, askRunId: run2 }, memberName: "受信箱係", inputTaskIds: [prev] });
  return { ws, task };
}

describe("前回の報告（定期の見張り）", () => {
  it("定期の実行では、同じ担当の前の回の報告を previousReport で渡し、受け渡しには入れない", async () => {
    const { db } = T();
    const w = await setup(db, "schedule");
    const env = buildEdge(db);
    const ctx = await env.edge.getTaskContext(await tokenFor(db, w.ws, w.task));
    expect(ctx.input.previousReport).toEqual({ at: "2026-10-12T18:00:00+09:00", tainted: false, body: "新しい日程はありません" });
    expect(ctx.input.handoffs).toEqual([]);
  });

  it("定期でない実行（返事）では、これまでどおり受け渡しとして渡す", async () => {
    const { db } = T();
    const w = await setup(db, "manual");
    const env = buildEdge(db);
    const ctx = await env.edge.getTaskContext(await tokenFor(db, w.ws, w.task));
    expect(ctx.input.previousReport).toBeUndefined();
    expect(ctx.input.handoffs.map((h) => h.body)).toEqual(["新しい日程はありません"]);
  });
});
