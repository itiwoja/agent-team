// 確認カードの文（reasons.ts）の試験：予定の登録（mcp.gcal.create_event）の時刻・場所・招待の一文と、操作名
import { describe, expect, it } from "vitest";
import { actionNounOf, calendarCardOf, calendarWhenText, githubCardOf, intentTitle } from "./reasons.ts";

describe("calendarWhenText：時刻は資格情報の時間帯で出す（既定は Asia/Tokyo）", () => {
  it("同じ日なら「10/12(月) 15:00〜16:00」", () => {
    expect(calendarWhenText("2026-10-12T15:00:00+09:00", "2026-10-12T16:00:00+09:00", "Asia/Tokyo")).toBe("10/12(月) 15:00〜16:00");
  });

  it("時間帯を変えると、その時間帯の時刻で出す（同じ瞬間）", () => {
    // 2026-10-12 15:00 JST = 06:00 UTC（同じ日）
    expect(calendarWhenText("2026-10-12T15:00:00+09:00", "2026-10-12T16:00:00+09:00", "UTC")).toBe("10/12(月) 06:00〜07:00");
  });

  it("日をまたぐなら両方の日を出す", () => {
    expect(calendarWhenText("2026-10-12T23:00:00+09:00", "2026-10-13T01:00:00+09:00", "Asia/Tokyo")).toBe("10/12(月) 23:00〜10/13(火) 01:00");
  });

  it("読めない値は null", () => {
    expect(calendarWhenText("not a date", "2026-10-12T16:00:00+09:00", "Asia/Tokyo")).toBeNull();
    expect(calendarWhenText(undefined, undefined, "Asia/Tokyo")).toBeNull();
  });
});

describe("calendarCardOf：予定の登録のカード", () => {
  const args = {
    title: "打ち合わせ",
    start: "2026-10-12T15:00:00+09:00",
    end: "2026-10-12T16:00:00+09:00",
    location: "会議室A",
    attendees: ["supplier@example.com", "b@example.com"],
  };

  it("題名・時刻・場所・招待の一文（招待は送らずに登録する）", () => {
    expect(calendarCardOf("mcp.gcal.create_event", args, "Asia/Tokyo")).toEqual({
      title: "打ち合わせ",
      when: "10/12(月) 15:00〜16:00",
      location: "会議室A",
      attendees: ["supplier@example.com", "b@example.com"],
      inviteNote: "2人に招待を送らずに登録します",
    });
  });

  it("招待する人がいなければ一文は出さない。場所がなければ null", () => {
    expect(calendarCardOf("mcp.gcal.create_event", { title: "x", start: args.start, end: args.end }, "Asia/Tokyo")).toEqual({
      title: "x",
      when: "10/12(月) 15:00〜16:00",
      location: null,
      attendees: [],
      inviteNote: null,
    });
  });

  it("予定の登録以外は null", () => {
    expect(calendarCardOf("mcp.gcal.delete_event", args, "Asia/Tokyo")).toBeNull();
    expect(calendarCardOf("mcp.supplier.place_order", args, "Asia/Tokyo")).toBeNull();
  });
});

describe("予定の操作の名前（確認カードの題・理由の文）", () => {
  it("予定の登録・削除の題と名詞", () => {
    expect(intentTitle("mcp.gcal.create_event")).toBe("予定を登録する");
    expect(intentTitle("mcp.gcal.delete_event")).toBe("予定を削除する");
    expect(actionNounOf("mcp.gcal.create_event")).toBe("予定の登録");
  });
});

describe("githubCardOf（18 §3.7）", () => {
  it("push_commit：リポジトリ・ブランチ・書く／消すファイル。main・master は必ず一文で目立たせる", () => {
    const args = { repo: "octo/app", branch: "makase/fix", message: "直す", files: [{ path: "README.md", content: "x" }], delete_paths: ["old.txt"] };
    expect(githubCardOf("mcp.github.push_commit", args)).toEqual({
      kind: "push_commit",
      repo: "octo/app",
      branch: "makase/fix",
      base: null,
      files: ["README.md"],
      deletes: ["old.txt"],
      protectedNote: null,
    });
    expect(githubCardOf("mcp.github.push_commit", { ...args, branch: "main" })?.protectedNote).toBe("「main」に直接書き込みます（PR を通さずに反映されます）");
    expect(intentTitle("mcp.github.push_commit")).toBe("GitHub にコミットを積む");
  });

  it("create_pull_request は head → base。ほかの操作は null", () => {
    expect(githubCardOf("mcp.github.create_pull_request", { repo: "octo/app", head: "makase/fix", title: "t" })).toMatchObject({ kind: "create_pull_request", branch: "makase/fix", base: null });
    expect(githubCardOf("mcp.gcal.create_event", {})).toBeNull();
    expect(intentTitle("mcp.github.create_pull_request")).toBe("GitHub にプルリクエストを出す");
  });
});
