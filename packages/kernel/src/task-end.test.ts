import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  INTENT_STATUSES,
  STOPPED_WRITE_KINDS,
  TASK_TERMINAL_STATUSES,
  computeTaskEnding,
  isTerminalTaskStatus,
  nextTaskStatus,
  stoppedWritesOfTask,
} from "./task-end.ts";
import type { IntentStatus, TaskEndInput, TaskEndIntent } from "./task-end.ts";
import type { TaskStatus } from "./types.ts";

const intents = (...statuses: IntentStatus[]) => statuses.map((status) => ({ status }));
const ending = (...statuses: IntentStatus[]) => computeTaskEnding({ isDryRun: false, rehearsal: false, intents: intents(...statuses) });

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
  it("試し実行（リハーサルでない）→ completed(dry_run)。リハーサルの走行は Intent で決める（15:121）", () => {
    expect(computeTaskEnding({ isDryRun: true, rehearsal: false, intents: intents("simulated") })).toEqual({ status: "completed", detail: "dry_run" });
    expect(computeTaskEnding({ isDryRun: true, rehearsal: true, intents: intents("executed") })).toEqual({ status: "succeeded" });
    expect(computeTaskEnding({ isDryRun: true, rehearsal: true, intents: intents("unknown_outcome") })).toEqual({ status: "failed", failReason: "action_failed" });
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
    nextTaskStatus({ status, loopEnded, isDryRun: false, rehearsal: false, intents: intents(...ss) });

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

describe("stoppedWritesOfTask（M-26、IA §2.9・§3.21、SW §4.7、15:190-193）", () => {
  const T0 = "2026-10-03T09:00:00.000Z";
  const KEY = "1".repeat(64);
  const DIGEST = "2".repeat(64);
  const intent = (over: Partial<TaskEndIntent> = {}): TaskEndIntent => ({
    id: "i-1",
    action: "mcp.supplier.place_order",
    arguments: { supplier_id: "supplier-01", items: [{ sku: "BEAN-HOUSE", quantity: 200, unit_price: 780 }] },
    destinationKey: KEY,
    optionDigest: DIGEST,
    decision: "approve",
    reasonCode: "guard_exceeded",
    status: "rejected",
    expireReason: null,
    createdAt: T0,
    decidedAt: "2026-10-03T09:05:00.000Z",
    ...over,
  });
  const run = (over: Partial<TaskEndInput["task"]> = {}, list: TaskEndIntent[] = [intent()]) =>
    stoppedWritesOfTask({
      task: {
        id: "t-1",
        jobId: "j-1",
        isDryRun: false,
        shadow: false,
        rehearsalRunId: null,
        status: "completed",
        haltReason: null,
        startedAt: T0,
        finishedAt: "2026-10-03T09:10:00.000Z",
        ...over,
      },
      intents: list,
    });

  it("止まり方の列挙（M-27：user_reject）", () => {
    expect(STOPPED_WRITE_KINDS).toEqual(["kernel_approve", "kernel_deny", "user_reject", "kill_switch"]);
  });

  it("S-1：本番で approve(guard_exceeded) → kernel_approve を1件（人が承認して実行されたものも数える）", () => {
    const r = run({ status: "succeeded" }, [intent({ status: "executed" })]);
    expect(r.incident).toBe(true);
    expect(r.stoppedWrites).toEqual([
      {
        intentId: "i-1",
        sourceTaskId: "t-1",
        jobId: "j-1",
        action: "mcp.supplier.place_order",
        destinationKey: KEY,
        optionDigest: DIGEST,
        argumentsSnapshot: { supplier_id: "supplier-01", items: [{ sku: "BEAN-HOUSE", quantity: 200, unit_price: 780 }] },
        stoppedBy: "kernel_approve",
        reasonCode: "guard_exceeded",
        occurredAt: T0,
      },
    ]);
    expect(r.primary).toEqual({ kind: "kernel_approve", reasonCode: "guard_exceeded" });
  });

  it("S-2：本番で deny → kernel_deny（handoff の判定も同じ扱い）", () => {
    const r = run({}, [intent({ decision: "deny", reasonCode: "intent_limit", status: "denied" })]);
    expect(r.stoppedWrites.map((s) => [s.stoppedBy, s.reasonCode])).toEqual([["kernel_deny", "intent_limit"]]);
    expect(run({}, [intent({ decision: "handoff", reasonCode: "autonomy_handoff", status: "denied" })]).stoppedWrites[0]?.stoppedBy).toBe("kernel_deny");
  });

  it("S-3・AP-16：本番で ✕ → user_reject。reasonCode は元の Intent の reasonCode、時刻は却下の時刻", () => {
    const r = run();
    expect(r.stoppedWrites).toHaveLength(1);
    expect(r.stoppedWrites[0]).toMatchObject({ stoppedBy: "user_reject", reasonCode: "guard_exceeded", occurredAt: "2026-10-03T09:05:00.000Z" });
    expect(r.primary).toEqual({ kind: "user_reject", reasonCode: "guard_exceeded" });
  });

  it("却下の時刻がなければ作成の時刻", () => {
    expect(run({}, [intent({ decidedAt: null })]).stoppedWrites[0]?.occurredAt).toBe(T0);
  });

  it("S-4：本番で running 中に Kill Switch → kill_switch（失効した Intent ごと）。Intent がなくても試験は作る", () => {
    const halted = { status: "halted" as const, haltReason: "kill_switch" };
    const r = run(halted, [intent({ decision: "allow", reasonCode: "rule_matched", status: "expired", expireReason: "kill_switch" })]);
    expect(r.killSwitch).toBe(true);
    expect(r.stoppedWrites.map((s) => [s.stoppedBy, s.reasonCode, s.occurredAt])).toEqual([["kill_switch", "kill_switch", "2026-10-03T09:10:00.000Z"]]);
    const none = run(halted, []);
    expect(none).toEqual({ incident: true, killSwitch: true, stoppedWrites: [], primary: { kind: "kill_switch", reasonCode: "kill_switch" } });
    // Kill Switch のあとの呼び出しが halt(kill_switch) で Intent になったものも kill_switch
    const after = run(halted, [intent({ decision: "halt", reasonCode: "kill_switch", status: "denied" })]);
    expect(after.stoppedWrites[0]?.stoppedBy).toBe("kill_switch");
  });

  it("Kill Switch で止まっても、動き始める前（queued・provisioning：startedAt なし）のタスクは記録しない（IA §8-18）", () => {
    expect(run({ status: "halted", haltReason: "kill_switch", startedAt: null }, [])).toEqual({
      incident: false,
      killSwitch: false,
      stoppedWrites: [],
      primary: null,
    });
  });

  it("Kernel が止めた書き込みが Kill Switch でも失効したら kernel_approve（理由コードの方が障害 ID を引ける）", () => {
    const r = run({ status: "halted", haltReason: "kill_switch" }, [intent({ status: "expired", expireReason: "kill_switch" })]);
    expect(r.stoppedWrites.map((s) => s.stoppedBy)).toEqual(["kernel_approve"]);
    expect(r.killSwitch).toBe(true);
  });

  it("S-5：リハーサル・影・試し実行では記録しない", () => {
    const empty = { incident: false, killSwitch: false, stoppedWrites: [], primary: null };
    expect(run({ rehearsalRunId: "rr-1", isDryRun: true })).toEqual(empty);
    expect(run({ shadow: true })).toEqual(empty);
    expect(run({ isDryRun: true })).toEqual(empty);
    expect(run({ rehearsalRunId: "rr-1", isDryRun: true, status: "halted", haltReason: "kill_switch" })).toEqual(empty);
  });

  it("S-6：approve(certificate_missing) は記録しない（人が却下したものは user_reject で記録する）", () => {
    expect(run({}, [intent({ reasonCode: "certificate_missing", status: "executed" })])).toEqual({
      incident: false,
      killSwitch: false,
      stoppedWrites: [],
      primary: null,
    });
    expect(run({}, [intent({ reasonCode: "certificate_missing", status: "rejected" })]).stoppedWrites[0]?.stoppedBy).toBe("user_reject");
  });

  it("allow（ルール）で実行された書き込み・予算の halt は止まった書き込みにしない（BR-80 のきっかけでない）", () => {
    const r = run({ status: "halted", haltReason: "budget_exceeded" }, [
      intent({ decision: "allow", reasonCode: "rule_matched", status: "executed" }),
      intent({ id: "i-2", decision: "halt", reasonCode: "budget_exceeded", status: "denied" }),
    ]);
    expect(r).toEqual({ incident: false, killSwitch: false, stoppedWrites: [], primary: null });
  });

  it("1タスクの止まった書き込みをまとめる（1タスク1件の試験）。代表はいちばん早く止まったもの", () => {
    const r = run({}, [
      intent({ id: "i-1", status: "rejected", decidedAt: "2026-10-03T09:30:00.000Z" }),
      intent({ id: "i-2", decision: "deny", reasonCode: "tool_needs_review", status: "denied", createdAt: "2026-10-03T09:20:00.000Z" }),
      intent({ id: "i-3", decision: "approve", reasonCode: "unknown_outcome_pending", status: "pending_approval", createdAt: "2026-10-03T09:25:00+09:00" }),
    ]);
    expect(r.stoppedWrites.map((s) => [s.intentId, s.stoppedBy])).toEqual([
      ["i-1", "user_reject"],
      ["i-2", "kernel_deny"],
      ["i-3", "kernel_approve"],
    ]);
    // i-3 は 09:25 JST ＝ 00:25 UTC でいちばん早い
    expect(r.primary).toEqual({ kind: "kernel_approve", reasonCode: "unknown_outcome_pending" });
  });

  it("引数の写しは元の値と別のもの（あとで書き換えても変わらない）", () => {
    const src = intent();
    const r = run({}, [src]);
    (src.arguments as { supplier_id: string }).supplier_id = "changed";
    expect(r.stoppedWrites[0]?.argumentsSnapshot.supplier_id).toBe("supplier-01");
  });
});
