import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  INTENT_STATUSES,
  TASK_TERMINAL_STATUSES,
  computeTaskEnding,
  isTerminalTaskStatus,
  nextTaskStatus,
} from "./task-end.ts";
import type { IntentStatus } from "./task-end.ts";
import type { TaskStatus } from "./types.ts";

const intents = (...statuses: IntentStatus[]) => statuses.map((status) => ({ status }));
const ending = (...statuses: IntentStatus[]) => computeTaskEnding({ isDryRun: false, intents: intents(...statuses) });

describe("computeTaskEnding（IA §3.18、intents.md:201-206）", () => {
  it("TS-1：Intent なし（レポートあり）→ completed(report)", () => {
    expect(ending()).toEqual({ status: "completed", detail: "report" });
  });
  it("TS-2：すべて executed（verified を含む）→ succeeded", () => {
    expect(ending("executed", "executed")).toEqual({ status: "succeeded" });
    expect(ending("executed", "verified")).toEqual({ status: "succeeded" });
  });
  it("TS-3・CH-10：executed ＋ rejected → completed(actions_declined)", () => {
    expect(ending("executed", "rejected")).toEqual({ status: "completed", detail: "actions_declined" });
    expect(ending("rejected")).toEqual({ status: "completed", detail: "actions_declined" });
  });
  it("TS-4・X-6：executed ＋ expired(superseded) → completed(actions_declined)", () => {
    expect(ending("executed", "expired")).toEqual({ status: "completed", detail: "actions_declined" });
  });
  it("TS-5・X-7：executed ＋ unknown_outcome → failed(action_failed)", () => {
    expect(ending("executed", "unknown_outcome")).toEqual({ status: "failed", failReason: "action_failed" });
  });
  it("TS-6：rejected ＋ failed → failed(action_failed)（失敗が先）", () => {
    expect(ending("rejected", "failed")).toEqual({ status: "failed", failReason: "action_failed" });
  });
  it("TS-7：denied だけ → completed(actions_declined)（IA §8-8）", () => {
    expect(ending("denied")).toEqual({ status: "completed", detail: "actions_declined" });
  });
  it("試し実行 → completed(dry_run)", () => {
    expect(computeTaskEnding({ isDryRun: true, intents: intents("simulated") })).toEqual({ status: "completed", detail: "dry_run" });
  });
  it("実行されていない残り（simulated・まだ動いている Intent）は succeeded にしない", () => {
    expect(ending("executed", "simulated")).toEqual({ status: "completed", detail: "actions_declined" });
    expect(ending("pending_approval")).toEqual({ status: "completed", detail: "actions_declined" });
  });
  it("性質：succeeded はすべて executed・verified のときだけ。failed・unknown_outcome があれば必ず failed", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...INTENT_STATUSES), { minLength: 1, maxLength: 6 }), (ss) => {
        const e = ending(...ss);
        expect(e.status === "succeeded").toBe(ss.every((s) => s === "executed" || s === "verified"));
        if (ss.some((s) => s === "failed" || s === "unknown_outcome")) expect(e).toEqual({ status: "failed", failReason: "action_failed" });
      }),
    );
  });
});

describe("nextTaskStatus（IA §3.18。Intent の状態が変わるたびに決め直す）", () => {
  const next = (status: TaskStatus, loopEnded: boolean, ...ss: IntentStatus[]) =>
    nextTaskStatus({ status, loopEnded, isDryRun: false, intents: intents(...ss) });

  it("終了状態は変えない（unknown_outcome をあとで確定しても変えない）", () => {
    for (const s of TASK_TERMINAL_STATUSES) expect(next(s, true, "executed")).toEqual({ status: s, ending: null });
    expect(next("failed", true, "executed")).toEqual({ status: "failed", ending: null });
  });

  it("ループが終わっていなければ running のまま（Intent は並行して実行されうる）", () => {
    expect(next("running", false, "pending_approval", "executed")).toEqual({ status: "running", ending: null });
  });

  it("IN-10：ループ中に承認待ちが1件、ループ終了 → awaiting_approval", () => {
    expect(next("running", true, "pending_approval")).toEqual({ status: "awaiting_approval", ending: null });
    expect(next("running", true, "proposed")).toEqual({ status: "awaiting_approval", ending: null });
  });

  it("IN-11：ループ終了時、auto の Intent が実行中 → executing → 実行後 succeeded", () => {
    expect(next("running", true, "approved")).toEqual({ status: "executing", ending: null });
    expect(next("executing", false, "executing")).toEqual({ status: "executing", ending: null });
    expect(next("executing", false, "executed")).toEqual({ status: "succeeded", ending: { status: "succeeded" } });
  });

  it("TS-8：承認待ちのままループ終了 → 承認 → 実行 → awaiting_approval → executing → succeeded", () => {
    expect(next("running", true, "pending_approval").status).toBe("awaiting_approval");
    expect(next("awaiting_approval", false, "approved").status).toBe("executing");
    expect(next("executing", false, "executed")).toEqual({ status: "succeeded", ending: { status: "succeeded" } });
  });

  it("TS-9：承認待ち2件のうち1件承認・1件はまだ → awaiting_approval のまま（承認した方は並行して実行）", () => {
    expect(next("awaiting_approval", true, "approved", "pending_approval")).toEqual({ status: "awaiting_approval", ending: null });
    expect(next("awaiting_approval", true, "executed", "pending_approval")).toEqual({ status: "awaiting_approval", ending: null });
  });

  it("CH-15・X-6：承認待ちが置き換え（expired）で消えたら completed(actions_declined)", () => {
    expect(next("awaiting_approval", true, "expired")).toEqual({ status: "completed", ending: { status: "completed", detail: "actions_declined" } });
  });

  it("CH-12：窓口の書き込みが承認待ちのまま submit_report → awaiting_approval（回答は待たずに出す）", () => {
    expect(next("running", true, "pending_approval")).toEqual({ status: "awaiting_approval", ending: null });
  });

  it("Intent なしでループ終了 → completed(report)", () => {
    expect(next("running", true)).toEqual({ status: "completed", ending: { status: "completed", detail: "report" } });
  });

  it("isTerminalTaskStatus", () => {
    expect(TASK_TERMINAL_STATUSES).toEqual(["succeeded", "completed", "rejected", "failed", "cancelled", "halted"]);
    expect(isTerminalTaskStatus("awaiting_approval")).toBe(false);
    expect(isTerminalTaskStatus("halted")).toBe(true);
  });
});
