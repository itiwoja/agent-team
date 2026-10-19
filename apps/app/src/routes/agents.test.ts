// エージェントの一覧（GET /api/v1/agents）の試験：ゲストの用意した依頼（受信箱係 → 仕入れ係）がライブラリに並び、別のワークスペースの担当は出ない
import { useTestDb } from "@open-team/db/testing";
import { describe, expect, it } from "vitest";
import { AgentLibraryResponseSchema } from "../agents/contract.ts";
import { enterGuest, guestHarness } from "../check/test-helpers.ts";
import { makeTestApp, send, signInOwner } from "../test-helpers.ts";

const T = useTestDb();

describe("GET /agents", () => {
  it("ゲストの用意した担当が、関わった依頼・仕事つきで並ぶ。確認待ちの仕入れ係が先", async () => {
    const { db } = T();
    const { t } = guestHarness(db);
    const g = await enterGuest(t);
    const res = await send(t, "GET", "/api/v1/agents", { cookie: g.cookie });
    expect(res.status).toBe(200);
    const body = AgentLibraryResponseSchema.parse(await res.json());
    expect(body.limit).toBe(20);
    expect(body.count).toBe(body.items.length);
    const names = body.items.map((a) => a.name);
    expect(names).toContain("受信箱係");
    expect(names).toContain("仕入れ係");

    const buyer = body.items.find((a) => a.name === "仕入れ係")!;
    const inbox = body.items.find((a) => a.name === "受信箱係")!;
    // 仕入れ係は送る前の確認で止まっている（確認待ち）。受信箱係は済み（待機中）
    expect(buyer).toMatchObject({ activity: "awaiting_approval", activityText: "確認待ち", status: "active", disabledReason: null });
    expect(inbox).toMatchObject({ activity: "idle", activityText: "待機中" });
    // 本番のタスクが数えられ、最後に動いた時刻がある
    expect(buyer.taskCount).toBeGreaterThanOrEqual(1);
    expect(buyer.lastActiveAt).not.toBeNull();
    // 関わった依頼は用意した依頼で、窓口は仕入れ係、段の番号は 受信箱係 1 → 仕入れ係 2
    expect(buyer.asks.map((k) => [k.askId, k.isSpokesperson, k.position])).toEqual([[g.firstAskId, true, 2]]);
    expect(inbox.asks.map((k) => [k.askId, k.isSpokesperson, k.position])).toEqual([[g.firstAskId, false, 1]]);
    expect(buyer.askCount).toBe(1);
    expect(buyer.jobCount).toBe(buyer.jobs.length);
    expect(buyer.jobs.length).toBeGreaterThanOrEqual(1);
    for (const j of buyer.jobs) expect(j.kindLabel).not.toBe("");
    // 最後に動いた順：確認待ちで止まっている仕入れ係のほうが新しい
    expect(names.indexOf("仕入れ係")).toBeLessThan(names.indexOf("受信箱係"));
  });

  it("別のワークスペース（オーナー）の担当は出ない。セッションなしは 401", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const owner = await signInOwner(t);
    const res = await send(t, "GET", "/api/v1/agents", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const body = AgentLibraryResponseSchema.parse(await res.json());
    // オーナーの新しいワークスペースにはゲストの担当は混ざらない（用意した依頼の担当だけ、または 0 体）
    expect(body.items.every((a) => a.name !== "")).toBe(true);
    expect((await send(t, "GET", "/api/v1/agents")).status).toBe(401);
  });
});
