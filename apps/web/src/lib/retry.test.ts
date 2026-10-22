import { describe, expect, it } from "vitest";
import { askRetryAction, reaskKeyFor, retryPlanFor } from "./retry";

describe("retryPlanFor（失敗の行でどの操作をやり直すか）", () => {
  type Kind = "answer" | "task" | "evolution";
  const row = (reportKind: Kind, askId: string | null = "a1", failed = true) => ({
    failed,
    reportKind,
    link: { askId },
  });

  it("依頼の実行・担当の仕事の失敗は依頼のやり直し", () => {
    expect(retryPlanFor(row("answer"))).toBe("ask");
    expect(retryPlanFor(row("task"))).toBe("ask");
  });
  it("失敗していない行・askId が無い行・それ以外の種類はボタンを出さない", () => {
    expect(retryPlanFor(row("task", "a1", false))).toBeNull();
    expect(retryPlanFor(row("task", null))).toBeNull();
    expect(retryPlanFor(row("evolution"))).toBeNull();
  });
});

describe("askRetryAction（依頼を再開するか頼み直すか）", () => {
  const resume = { agentName: "担当A", reason: "失敗" };

  it("順番で止まっていて再開できるなら止まった段から（resume）", () => {
    expect(askRetryAction({ ask: { status: "waiting_input" }, resume })).toBe("resume");
  });
  it("止まっていても再開先が無ければ、終わっていない依頼として依頼のページを開く（頼み直さない）", () => {
    expect(askRetryAction({ ask: { status: "waiting_input" }, resume: null })).toBe("open");
  });
  it("failed・done・cancelled は頼み直す", () => {
    for (const status of ["failed", "done", "cancelled"] as const) {
      expect(askRetryAction({ ask: { status }, resume: null })).toBe("reask");
    }
  });
  it("まだ動いている依頼は作り直さずにページを開くだけ（二重にしない）", () => {
    for (const status of ["running", "generating"] as const) {
      expect(askRetryAction({ ask: { status }, resume: null })).toBe("open");
    }
  });
});

describe("reaskKeyFor（頼み直しの冪等キー）", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("同じ askId からは同じ UUID 形のキーになる（同じ依頼の行が複数あっても二重にならない）", async () => {
    const a = await reaskKeyFor("ask-1");
    expect(a).toMatch(UUID);
    expect(await reaskKeyFor("ask-1")).toBe(a);
  });
  it("違う askId からは違うキーになる", async () => {
    expect(await reaskKeyFor("ask-1")).not.toBe(await reaskKeyFor("ask-2"));
  });
});
