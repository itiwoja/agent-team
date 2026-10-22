// 依頼の表示の固定の文（apps/app/src/asks/format.test.ts の WorkspaceDO 版）。「接続が要る」の判定（needsConnectionOf）は語で決まる決定論の判定だけを見る。
// 担当からの質問への答え（answerOf）は書き込みの側なので移していない
import { describe, expect, it } from "vitest";
import { answerExtrasOf } from "../../src/views/asks/answer.ts";
import { needsConnectionOf, reuseLineOf, triggerLabel, triggerView } from "../../src/views/asks/format.ts";

describe("needsConnectionOf", () => {
  it("カレンダーの語を含む依頼は gcal", () => {
    expect(needsConnectionOf("この勉強会の日程をカレンダーに入れて")).toBe("gcal");
    expect(needsConnectionOf("来週、空いてる時間にジムを3回入れて")).toBe("gcal");
    expect(needsConnectionOf("明日の予定を教えて")).toBe("gcal");
    expect(needsConnectionOf("毎週月曜のスケジュールを組んで")).toBe("gcal");
  });

  it("英語の語は大文字・小文字を問わない", () => {
    expect(needsConnectionOf("Put this on my Calendar")).toBe("gcal");
    expect(needsConnectionOf("SCHEDULE a call")).toBe("gcal");
  });

  it("GitHub・リポジトリ・プルリク・イシューの語を含む依頼は github（カレンダーの語が先）", () => {
    expect(needsConnectionOf("リポジトリの README の誤字を直して PR を出して")).toBe("github");
    expect(needsConnectionOf("GitHub のイシューを片付けて")).toBe("github");
    expect(needsConnectionOf("このプルリクの CI を見て")).toBe("github");
    expect(needsConnectionOf("リポジトリのリリース予定をカレンダーに入れて")).toBe("gcal");
  });

  it("カレンダーの語がなければ null", () => {
    expect(needsConnectionOf("仕入れ先の在庫を調べて発注して")).toBeNull();
    expect(needsConnectionOf("")).toBeNull();
  });
});

describe("triggerLabel・triggerView（定期の表示）", () => {
  it("毎日の時刻を1つ・複数で言う。毎日でない cron はそのまま", () => {
    expect(triggerLabel({ cron: "0 18 * * *", timezone: "Asia/Tokyo" })).toBe("毎日18時");
    expect(triggerLabel({ cron: "30 9 * * *", timezone: "Asia/Tokyo" })).toBe("毎日9時30分");
    expect(triggerLabel({ cron: "0 9,18 * * *", timezone: "Asia/Tokyo" })).toBe("毎日9時・18時");
    expect(triggerLabel({ cron: "0 9 * * 1", timezone: "Asia/Tokyo" })).toBe("0 9 * * 1");
    expect(triggerLabel({ cron: "0 */3 * * *", timezone: "Asia/Tokyo" })).toBe("0 */3 * * *");
  });

  it("次に動く時刻を付ける（なければ null）", () => {
    const trigger = { type: "schedule" as const, cron: "0 9 * * *", timezone: "Asia/Tokyo" };
    expect(triggerView({ trigger, next_run_at: new Date("2026-10-15T00:00:00Z") })?.nextRunAt).toBe("2026-10-15T00:00:00.000Z");
    expect(triggerView({ trigger })?.nextRunAt).toBeNull();
    expect(triggerView({ trigger: null })).toBeNull();
  });
});

describe("answerExtrasOf（回答に足す次の手の提案・変化なし）", () => {
  const task = (id: string, meta: { nextActions?: string[]; changed?: boolean } | null) => ({ id, report: "報告", report_meta: meta });
  it("次の手の提案は回答を書いた窓口のものだけ", () => {
    const latest = new Map([
      ["m1", task("t1", { nextActions: ["A"] })],
      ["m2", task("t2", { nextActions: ["B"] })],
    ]);
    expect(answerExtrasOf("t2", latest)).toEqual({ nextActions: ["B"] });
    expect(answerExtrasOf(null, latest)).toEqual({});
  });

  it("変化の有無を言った担当がみな「変化なし」なら unchanged。1人でも変化あり・誰も言っていなければ付けない", () => {
    expect(answerExtrasOf("t1", new Map([["m1", task("t1", { changed: false })]]))).toEqual({ unchanged: true });
    expect(answerExtrasOf("t1", new Map([["m1", task("t1", { changed: false })], ["m2", task("t2", { changed: true })]]))).toEqual({});
    expect(answerExtrasOf("t1", new Map([["m1", task("t1", null)]]))).toEqual({});
  });
});

describe("reuseLineOf", () => {
  it("この依頼で作った担当は「新しく作りました」", () => {
    expect(reuseLineOf(true, 0)).toBe("新しく作りました");
  });
  it("使い回した担当は前の依頼の数を足す", () => {
    expect(reuseLineOf(false, 3)).toBe("いつもの担当 · 前の依頼 3件でも働きました");
  });
  it("前の依頼がなければ「いつもの担当」だけ", () => {
    expect(reuseLineOf(false, 0)).toBe("いつもの担当");
  });
});
