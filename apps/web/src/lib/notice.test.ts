import { describe, expect, it } from "vitest";
import { noticeHeadline, noticeLead, noticePoints } from "./notice";

const answer = (over: Partial<{ failed: boolean; pending: number; stopped: string[] }> = {}) => ({
  conclusion: "",
  memberLines: over.failed ? [{ agentName: "予定係", text: "失敗", failed: true }] : [],
  needsYou: { pendingApprovals: over.pending ?? 0, line: null, stoppedMembers: over.stopped ?? [] },
});

describe("届いた知らせの見出し", () => {
  it("やったこと（Web の検索）から「リサーチしたよ！」", () => {
    expect(noticeHeadline({ askText: "毎朝まとめて", answer: answer(), stages: [{ activity: [{ label: "Web の検索", outcome: "done", at: "" }] }] })).toBe("リサーチしたよ！");
  });
  it("やったことが無ければ頼んだ文の言葉から。どれにも当たらなければ「終わったよ！」", () => {
    expect(noticeHeadline({ askText: "競合の値段を調べて、表にして", answer: answer() })).toBe("リサーチしたよ！");
    expect(noticeHeadline({ askText: "今月の売上をまとめて", answer: answer() })).toBe("まとめたよ！");
    expect(noticeHeadline({ askText: "よろしく", answer: answer() })).toBe("終わったよ！");
  });
  it("確認待ちがあれば「確認してね」、止まった担当があれば先にそれを言う", () => {
    expect(noticeHeadline({ askText: "来週の予定を確認して", answer: answer({ pending: 1 }) })).toBe("予定を見ておいたよ。確認してね");
    expect(noticeHeadline({ askText: "調べて", answer: answer({ failed: true }) })).toBe("途中で止まっちゃった");
    expect(noticeHeadline({ askText: "調べて", answer: answer({ stopped: ["予定係"] }) })).toBe("途中で止まっちゃった");
  });
  it("外に作用するもの（予定の登録）を、前段で読んだメールより先に見る。確認へ回した登録も準備できたものとして数える", () => {
    const stages = [{ activity: [{ label: "受信箱の確認", outcome: "done" as const, at: "" }] }, { activity: [{ label: "予定の登録", outcome: "approval" as const, at: "" }] }];
    expect(noticeHeadline({ askText: "受信箱を見て、打ち合わせの予定を入れて", answer: answer(), stages })).toBe("予定を入れる準備をしたよ！");
  });
  it("統制・安全装置が止めた呼び出しは、やったことに数えない", () => {
    expect(noticeHeadline({ askText: "よろしく", answer: answer(), stages: [{ activity: [{ label: "コミットの追加", outcome: "denied", at: "" }] }] })).toBe("終わったよ！");
  });
});

describe("カードの2行目・シートの要点", () => {
  it("noticeLead：見出し記号・太字を外した最初の1文。長ければ省く", () => {
    expect(noticeLead("## 今日のまとめ\n\n本文です。")).toBe("今日のまとめ");
    expect(noticeLead("- **空き時間**は少ないです。調整します。")).toBe("空き時間は少ないです。");
    expect(noticeLead("|a|b|\n|---|---|\n本文")).toBe("本文");
    expect(noticeLead("あ".repeat(80), 10)).toBe(`${"あ".repeat(9)}…`);
    expect(noticeLead("[Anthropic の発表](https://www.anthropic.com/news) によると新しいモデルです。")).toBe("Anthropic の発表 によると新しいモデルです。");
    expect(noticeLead("[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) によると。")).toBe("Foo によると。");
    expect(noticeLead("")).toBe("");
  });
  it("noticePoints：箇条書きの先頭3件（深い入れ子は除く）", () => {
    expect(noticePoints("前置き\n- 一\n* **二**\n1. 三\n- 四\n    - 深い")).toEqual(["一", "二", "三"]);
    expect(noticePoints("箇条書きなし")).toEqual([]);
  });
});
