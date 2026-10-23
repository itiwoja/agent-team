import { describe, expect, it } from "vitest";
import type { AskDetail, AskSummary, AskTurnView } from "../api";
import { CONTINUE_MS, chatOrder, isLive, routeOf } from "./chat";

const NOW = Date.parse("2026-10-23T12:00:00Z");

const turn: AskTurnView = { runId: "r1", runNo: 1, kind: "ask", text: "在庫を見て", status: "done", answer: null, startedAt: "2026-10-23T11:50:00Z", finishedAt: "2026-10-23T11:55:00Z" };

const detail = (over: Partial<AskSummary> = {}): Pick<AskDetail, "ask" | "run" | "answer" | "turns"> => ({
  ask: { id: "a1", text: "在庫を見て", status: "done", shape: "single", updatedAt: "2026-10-23T11:55:00Z", createdAt: "2026-10-23T11:50:00Z", ...over } as AskSummary,
  run: null,
  answer: null,
  turns: [turn],
});

describe("routeOf（送った文の行き先）", () => {
  it("会話が空なら新しい依頼", () => {
    expect(routeOf(null, NOW)).toEqual({ kind: "new" });
  });
  it("直前の依頼が続けられて、間がなければ返事", () => {
    expect(routeOf(detail(), NOW)).toEqual({ kind: "reply", askId: "a1" });
    expect(routeOf(detail({ status: "running" }), NOW)).toEqual({ kind: "reply", askId: "a1" });
  });
  it("最後に動いてから時間がたっていれば新しい依頼", () => {
    const old = new Date(NOW - CONTINUE_MS - 1000).toISOString();
    expect(routeOf(detail({ updatedAt: old }), NOW)).toEqual({ kind: "new" });
  });
  it("続けられない依頼（失敗・並列・生成中）なら新しい依頼", () => {
    expect(routeOf(detail({ status: "failed" }), NOW)).toEqual({ kind: "new" });
    expect(routeOf(detail({ shape: "parallel" }), NOW)).toEqual({ kind: "new" });
    expect(routeOf(detail({ status: "generating" }), NOW)).toEqual({ kind: "new" });
  });
});

describe("chatOrder・isLive", () => {
  it("古い順に並べ直す", () => {
    const a = { id: "new", createdAt: "2026-10-23T12:00:00Z" } as AskSummary;
    const b = { id: "old", createdAt: "2026-10-22T12:00:00Z" } as AskSummary;
    expect(chatOrder([a, b]).map((x) => x.id)).toEqual(["old", "new"]);
  });
  it("生成中・動いている・入力待ちは取り直す", () => {
    expect(isLive("running")).toBe(true);
    expect(isLive("generating")).toBe(true);
    expect(isLive("waiting_input")).toBe(true);
    expect(isLive("done")).toBe(false);
  });
});
