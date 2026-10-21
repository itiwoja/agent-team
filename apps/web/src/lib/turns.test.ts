import { describe, expect, it } from "vitest";
import type { AskDetail, AskTurnView } from "../api";
import { noAnswerText, pendingReplyLabel, replyAvailability, replySentNote, showsRequest, turnLabel, turnsOf } from "./turns";

const turn = (over: Partial<AskTurnView>): AskTurnView => ({
  runId: "r1",
  runNo: 1,
  kind: "ask",
  text: "在庫を見て発注して",
  status: "done",
  answer: null,
  startedAt: "2026-10-13T09:00:00Z",
  finishedAt: null,
  ...over,
});

describe("turnsOf", () => {
  const base = { ask: { text: "在庫を見て発注して" } as AskDetail["ask"], answer: null, run: null } as Pick<AskDetail, "ask" | "run" | "answer" | "turns">;
  it("サーバーの turns をそのまま使う", () => {
    const t = [turn({}), turn({ runId: "r2", runNo: 2, kind: "reply", text: "もう少し詳しく" })];
    expect(turnsOf({ ...base, turns: t })).toBe(t);
  });
  it("turns がない（古い応答）ときは今の実行だけから作り、実行がなければ空", () => {
    expect(turnsOf(base)).toEqual([]);
    const run = { runId: "r9", runNo: 3, status: "done", triggerType: "schedule", startedAt: "2026-10-13T09:00:00Z", finishedAt: "2026-10-13T09:05:00Z" } as NonNullable<AskDetail["run"]>;
    expect(turnsOf({ ...base, run, turns: [] })).toEqual([{ runId: "r9", runNo: 3, kind: "schedule", text: "在庫を見て発注して", status: "done", answer: null, startedAt: "2026-10-13T09:00:00Z", finishedAt: "2026-10-13T09:05:00Z" }]);
  });
});

describe("頼んだことの行", () => {
  it("最初の依頼の文は見出しにあるので出さず、返事・定期の実行は出す", () => {
    expect(showsRequest(turn({}), "在庫を見て発注して")).toBe(false);
    expect(showsRequest(turn({ kind: "reply", text: "もう少し詳しく" }), "在庫を見て発注して")).toBe(true);
    expect(showsRequest(turn({ kind: "schedule" }), "在庫を見て発注して")).toBe(true);
    expect(showsRequest(turn({ text: "別の文" }), "在庫を見て発注して")).toBe(true);
  });
  it("札は返事・定期だけ。定期はトリガーの文を添える", () => {
    expect(turnLabel(turn({}), null)).toBeNull();
    expect(turnLabel(turn({ kind: "reply" }), null)).toBe("追加で頼んだこと");
    expect(turnLabel(turn({ kind: "schedule" }), "毎日18時")).toBe("定期の実行（毎日18時）");
    expect(turnLabel(turn({ kind: "schedule" }), null)).toBe("定期の実行");
  });
  it("回答のない実行の1行は、止まったときだけ（動いている間は null）", () => {
    expect(noAnswerText("running")).toBeNull();
    expect(noAnswerText("done")).toBeNull();
    expect(noAnswerText("failed")).toBe("回答はありません（止まりました）");
    expect(noAnswerText("waiting_input")).toBe("途中で止まっています");
  });
});

describe("返事欄の出し方", () => {
  const detailOf = (over: { shape?: string; status?: string; turns?: AskTurnView[] }) =>
    ({ ask: { text: "在庫を見て発注して", shape: over.shape ?? "single", status: over.status ?? "done" }, run: null, answer: null, turns: over.turns ?? [turn({})] }) as unknown as Pick<AskDetail, "ask" | "run" | "answer" | "turns">;
  it("回答が出た後は出す。動いている間も出す（順番待ちになる）", () => {
    expect(replyAvailability(detailOf({}))).toEqual({ show: true, queues: false });
    expect(replyAvailability(detailOf({ status: "running", turns: [turn({ status: "running" })] }))).toEqual({ show: true, queues: true });
  });
  it("並列・生成中・失敗・やめた・再開待ち・実行がまだないときは出さない", () => {
    expect(replyAvailability(detailOf({ shape: "parallel" })).show).toBe(false);
    for (const status of ["generating", "failed", "cancelled", "waiting_input"]) expect(replyAvailability(detailOf({ status })).show).toBe(false);
    expect(replyAvailability(detailOf({ turns: [] })).show).toBe(false);
  });
  it("順番待ちの文と送った後の知らせ", () => {
    expect(pendingReplyLabel("もう少し詳しく")).toBe("順番待ち：もう少し詳しく");
    expect(replySentNote({ queued: true })).toMatch(/順番待ち/);
    expect(replySentNote({})).toBeNull();
    expect(replySentNote(undefined)).toBeNull();
  });
});
