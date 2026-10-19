import { describe, expect, it } from "vitest";
import { parseLocation } from "./router";

describe("parseLocation", () => {
  it("入口・チェック・済んだもの・依頼のページを見分ける", () => {
    expect(parseLocation("/")).toEqual({ name: "home" });
    expect(parseLocation("/check")).toEqual({ name: "check", item: null });
    expect(parseLocation("/check", "?item=abc")).toEqual({ name: "check", item: "abc" });
    expect(parseLocation("/done")).toEqual({ name: "done" });
    expect(parseLocation("/agents")).toEqual({ name: "agents" });
    expect(parseLocation("/agents/")).toEqual({ name: "agents" });
    expect(parseLocation("/packs")).toEqual({ name: "packs", q: "", category: null });
    expect(parseLocation("/packs", "?q=%E6%8E%A1%E7%82%B9&cat=x")).toEqual({ name: "packs", q: "採点", category: "x" });
    expect(parseLocation("/packs/teacher")).toEqual({ name: "pack", packId: "teacher" });
    expect(parseLocation("/packs/%E0%A4%A")).toEqual({ name: "notFound" });
    expect(parseLocation("/asks/a-1")).toEqual({ name: "ask", askId: "a-1" });
    expect(parseLocation("/asks")).toEqual({ name: "asks", q: "", status: null });
    expect(parseLocation("/asks/", "?q=%E7%99%BA%E6%B3%A8&status=done")).toEqual({ name: "asks", q: "発注", status: "done" });
  });
  it("監査ログは ?seq= を数で持つ（正の整数でなければ null）", () => {
    expect(parseLocation("/audit")).toEqual({ name: "audit", seq: null });
    expect(parseLocation("/audit", "?seq=348")).toEqual({ name: "audit", seq: 348 });
    expect(parseLocation("/audit", "?seq=0")).toEqual({ name: "audit", seq: null });
    expect(parseLocation("/audit", "?seq=abc")).toEqual({ name: "audit", seq: null });
  });
  it("末尾の / は無視し、知らないパスは notFound", () => {
    expect(parseLocation("/check/")).toEqual({ name: "check", item: null });
    expect(parseLocation("/asks/a/b")).toEqual({ name: "notFound" });
    expect(parseLocation("/nope")).toEqual({ name: "notFound" });
  });
  it("依頼の id はパーセント符号を戻し、壊れていれば notFound", () => {
    expect(parseLocation("/asks/a%20b")).toEqual({ name: "ask", askId: "a b" });
    expect(parseLocation("/asks/%E0%A4%A")).toEqual({ name: "notFound" });
  });
  it("useRoute と同じ ? の分割で、パスとクエリを別に渡しても同じ結果になる", () => {
    const loc = "/check?item=abc&x=1";
    const q = loc.indexOf("?");
    expect(parseLocation(loc.slice(0, q), loc.slice(q))).toEqual({ name: "check", item: "abc" });
    // ? を含めたままパスとして渡すと別の画面にならない（分割が要ることの確認）
    expect(parseLocation(loc)).toEqual({ name: "notFound" });
  });
});
