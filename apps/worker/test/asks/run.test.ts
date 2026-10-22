// 編成の実行の DB 側（src/asks/run.ts）の試験：実行を始める（startAskRunTx）・1歩進める（advanceTx）・回答の保存。
// apps/app/src/asks/run.test.ts のうち、タスクを動かさず DB だけで確かめられるもの（タスクの終わりは行を書き換えて作る）。
// タスクを動かす部分（driveRun・executeTask など）は 4c で移すので、ここでは試さない
import { AppError } from "@open-team/platform";
import { describe, expect, it } from "vitest";
import { startAskRunTx, advanceTx, askStatusFor } from "../../src/asks/run.ts";
import { getAsk, getAskRun, listMembers, listRunTasks } from "../../src/db/repo/asks.ts";
import { hasTaskWebUrl } from "../../src/db/repo/web-urls.ts";
import { run, type WsDb } from "../../src/db/sqlite.ts";
import type { AskRow, Uuid } from "../../src/db/types.ts";
import { normalizeWebUrl, seenUrlHash } from "../../src/edge/web-seen.ts";
import { FIXED_NOW, inWorkspace } from "../db/fixtures.ts";
import { auditTypes, draftMember, events, formAsk, fxPolicy } from "./helpers.ts";

const NOW = FIXED_NOW;
const at = (s: number) => new Date(NOW.getTime() + s * 1000);

const chain = (n: number) => ({ shape: "chain", members: Array.from({ length: n }, (_, i) => draftMember({ newName: `調べ屋${i + 1}`, summary: `段${i + 1}` })) });
const parallel = (n: number) => ({ shape: "parallel", members: Array.from({ length: n }, (_, i) => draftMember({ newName: `並び屋${i + 1}`, summary: `担当${i + 1}` })) });
const single = { shape: "single", members: [draftMember({ newName: "ひとり屋" })] };

/** タスクを報告つきで終わらせる（担当が submit_report した形） */
function finishTask(db: WsDb, taskId: Uuid, report: string, kind: "normal" | "answer" = "normal"): void {
  run(
    db,
    "UPDATE tasks SET status = 'succeeded', started_at = ?, finished_at = ?, report = ?, report_title = ?, report_kind = ? WHERE id = ?",
    NOW,
    NOW,
    report,
    "報告",
    kind,
    taskId,
  );
}

function failTaskRow(db: WsDb, taskId: Uuid): void {
  run(db, "UPDATE tasks SET status = 'failed', fail_reason = 'agent_unable', started_at = ?, finished_at = ? WHERE id = ?", NOW, NOW, taskId);
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("投げるはず");
}

describe("startAskRunTx", () => {
  it("single：実行を作り、担当のタスクを queued で作る（依頼の文がお願い・URL は見た集合に入る）。ask.step.started と監査ログを残す", () =>
    inWorkspace(async (db, ws) => {
      fxPolicy(db, NOW);
      const { askId } = await formAsk(db, ws.userId, NOW, single);
      const started = startAskRunTx(db, askId, { requesterId: ws.userId, trigger: "initial", now: at(1) });
      expect(started?.run).toMatchObject({ ask_id: askId, run_no: 1, trigger_type: "initial", status: "running" });
      expect(started?.run.first_member_started_at?.toISOString()).toBe(at(1).toISOString());
      expect(started?.tasks).toHaveLength(1);
      const task = started!.tasks[0]!;
      expect(task).toMatchObject({ status: "queued", trigger_type: "ask", ask_id: askId, ask_run_id: started!.run.id, prompt: "調べて https://example.com/a を見て", input_task_ids: [] });
      expect(hasTaskWebUrl(db, task.id, seenUrlHash(normalizeWebUrl("https://example.com/a")!))).toBe(true);
      expect(events(db, "ask.step.started").map((e) => e.data.taskId)).toEqual([task.id]);
      expect(auditTypes(db)).toEqual(expect.arrayContaining(["ask.run.started", "ask.step.started"]));
      expect(getAsk(db, askId)?.status).toBe("running");
    }));

  it("chain：1段目だけを始める", () =>
    inWorkspace(async (db, ws) => {
      fxPolicy(db, NOW);
      const { askId } = await formAsk(db, ws.userId, NOW, chain(3));
      const started = startAskRunTx(db, askId, { requesterId: ws.userId, trigger: "initial", now: at(1) });
      const first = listMembers(db, askId).find((m) => m.position === 1)!;
      expect(started?.tasks.map((t) => t.ask_member_id)).toEqual([first.id]);
    }));

  it("parallel：全員を同時に始める", () =>
    inWorkspace(async (db, ws) => {
      fxPolicy(db, NOW);
      const { askId } = await formAsk(db, ws.userId, NOW, parallel(3));
      const started = startAskRunTx(db, askId, { requesterId: ws.userId, trigger: "initial", now: at(1) });
      expect(started?.tasks).toHaveLength(3);
      expect(new Set(started?.tasks.map((t) => t.ask_member_id))).toEqual(new Set(listMembers(db, askId).map((m) => m.id)));
    }));

  it("動いている実行があれば、もう1つは始めない（null）", () =>
    inWorkspace(async (db, ws) => {
      fxPolicy(db, NOW);
      const { askId } = await formAsk(db, ws.userId, NOW, single);
      expect(startAskRunTx(db, askId, { requesterId: ws.userId, trigger: "initial", now: at(1) })).not.toBeNull();
      expect(startAskRunTx(db, askId, { requesterId: ws.userId, trigger: "manual", now: at(2) })).toBeNull();
    }));

  it("Kill Switch 発動中は 423（実行も作らない）", () =>
    inWorkspace(async (db, ws) => {
      fxPolicy(db, NOW);
      const { askId } = await formAsk(db, ws.userId, NOW, single);
      run(db, "UPDATE workspace SET kill_switch_engaged = 1, kill_switch_engaged_at = ? WHERE id = 1", NOW);
      const e = caught(() => startAskRunTx(db, askId, { requesterId: ws.userId, trigger: "initial", now: at(1) }));
      expect(e).toBeInstanceOf(AppError);
      expect(e).toMatchObject({ code: "KILL_SWITCH_ENGAGED" });
      expect(auditTypes(db)).not.toContain("ask.run.started");
    }));
});

describe("advanceTx", () => {
  it("chain：前の段が済んだら次の段を、前の段の報告を受け渡して始める。最後の段が済んだら回答を保存し、実行も依頼も done", () =>
    inWorkspace(async (db, ws) => {
      fxPolicy(db, NOW);
      const { askId } = await formAsk(db, ws.userId, NOW, chain(2));
      const started = startAskRunTx(db, askId, { requesterId: ws.userId, trigger: "initial", now: at(1) })!;
      const runId = started.run.id;
      // 1段目が動いている間は何も始めない
      expect(advanceTx(db, runId, { requesterId: ws.userId, now: at(2) })).toEqual({ tasks: [], runStatus: "running" });
      finishTask(db, started.tasks[0]!.id, "1段目の結果");
      const step2 = advanceTx(db, runId, { requesterId: ws.userId, now: at(3) });
      expect(step2.runStatus).toBe("running");
      expect(step2.tasks).toHaveLength(1);
      expect(step2.tasks[0]!.input_task_ids).toEqual([started.tasks[0]!.id]);
      finishTask(db, step2.tasks[0]!.id, "まとめた答え", "answer");
      const last = advanceTx(db, runId, { requesterId: ws.userId, now: at(4) });
      expect(last).toEqual({ tasks: [], runStatus: "done" });
      const r = getAskRun(db, runId);
      expect(r).toMatchObject({ status: "done", answer_task_id: step2.tasks[0]!.id });
      expect(r?.answer).toBeTruthy();
      expect(getAsk(db, askId)?.status).toBe("done");
      expect(events(db, "ask.answered")).toHaveLength(1);
      expect(events(db, "ask.status").map((e) => e.data.status)).toEqual(["done"]);
      expect(auditTypes(db)).toEqual(expect.arrayContaining(["ask.answered", "ask.run.finished"]));
      // 終わった実行は何もしない
      expect(advanceTx(db, runId, { requesterId: ws.userId, now: at(5) })).toEqual({ tasks: [], runStatus: null });
    }));

  it("chain：段が失敗したら次を始めず waiting_input（依頼も waiting_input）", () =>
    inWorkspace(async (db, ws) => {
      fxPolicy(db, NOW);
      const { askId } = await formAsk(db, ws.userId, NOW, chain(2));
      const started = startAskRunTx(db, askId, { requesterId: ws.userId, trigger: "initial", now: at(1) })!;
      failTaskRow(db, started.tasks[0]!.id);
      expect(advanceTx(db, started.run.id, { requesterId: ws.userId, now: at(2) })).toEqual({ tasks: [], runStatus: "waiting_input" });
      expect(listRunTasks(db, started.run.id)).toHaveLength(1);
      expect(getAsk(db, askId)?.status).toBe("waiting_input");
    }));

  it("Kill Switch 発動中は何も始めない", () =>
    inWorkspace(async (db, ws) => {
      fxPolicy(db, NOW);
      const { askId } = await formAsk(db, ws.userId, NOW, chain(2));
      const started = startAskRunTx(db, askId, { requesterId: ws.userId, trigger: "initial", now: at(1) })!;
      finishTask(db, started.tasks[0]!.id, "1段目の結果");
      run(db, "UPDATE workspace SET kill_switch_engaged = 1, kill_switch_engaged_at = ? WHERE id = 1", NOW);
      expect(advanceTx(db, started.run.id, { requesterId: ws.userId, now: at(2) })).toEqual({ tasks: [], runStatus: null });
      expect(listRunTasks(db, started.run.id)).toHaveLength(1);
    }));
});

describe("askStatusFor", () => {
  it("定期の依頼は実行が終わっても running のまま（waiting_input だけ映す）", () => {
    const ask = (trigger: AskRow["trigger"]) => ({ trigger }) as AskRow;
    const sched = ask({ type: "schedule", cron: "0 9 * * *", timezone: "Asia/Tokyo" });
    expect(askStatusFor(sched, "done")).toBe("running");
    expect(askStatusFor(sched, "waiting_input")).toBe("waiting_input");
    expect(askStatusFor(ask(null), "done")).toBe("done");
    expect(askStatusFor(ask(null), "failed")).toBe("failed");
  });
});
