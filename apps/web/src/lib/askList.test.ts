import { describe, expect, it } from "vitest";
import type { AskStatus } from "../api";
import { askMatches, countByFilter, filterAsks, filterOf, parseAskFilter, statusTone } from "./askList";

const ask = (text: string, status: AskStatus = "done", answerPreview: string | null = null, trigger: string | null = null) => ({
  text,
  status,
  answerPreview,
  trigger: trigger === null ? null : { label: trigger, nextRunAt: null },
});

describe("filterOf", () => {
  it("生成中は動いている、取り消しは済みに入れる", () => {
    expect(filterOf("generating")).toBe("active");
    expect(filterOf("running")).toBe("active");
    expect(filterOf("waiting_input")).toBe("waiting");
    expect(filterOf("done")).toBe("done");
    expect(filterOf("cancelled")).toBe("done");
    expect(filterOf("failed")).toBe("failed");
  });
});

describe("parseAskFilter", () => {
  it("知っている区分だけ通し、ほかは all", () => {
    expect(parseAskFilter("waiting")).toBe("waiting");
    expect(parseAskFilter("nope")).toBe("all");
    expect(parseAskFilter(null)).toBe("all");
  });
});

describe("statusTone", () => {
  it("済み＝done、動いている・手が要る＝running、失敗＝failed、取り消し＝muted", () => {
    expect(statusTone("done")).toBe("done");
    expect(statusTone("waiting_input")).toBe("running");
    expect(statusTone("failed")).toBe("failed");
    expect(statusTone("cancelled")).toBe("muted");
  });
});

describe("askMatches", () => {
  it("依頼の文・回答の要約・定期のラベルのどこかに、言葉がすべて含まれる", () => {
    const a = ask("在庫が減ったら発注して", "done", "A社に発注しました", "毎朝7時");
    expect(askMatches(a, "")).toBe(true);
    expect(askMatches(a, "在庫")).toBe(true);
    expect(askMatches(a, "A社")).toBe(true);
    expect(askMatches(a, "a社 毎朝")).toBe(true);
    expect(askMatches(a, "在庫　B社")).toBe(false);
  });
});

describe("filterAsks / countByFilter", () => {
  const list = [ask("発注して", "running"), ask("まとめて", "done"), ask("調べて", "failed"), ask("発注の確認", "waiting_input")];
  it("区分と言葉で絞り、並びは保つ", () => {
    expect(filterAsks(list, "all", "").map((a) => a.text)).toEqual(["発注して", "まとめて", "調べて", "発注の確認"]);
    expect(filterAsks(list, "all", "発注").map((a) => a.text)).toEqual(["発注して", "発注の確認"]);
    expect(filterAsks(list, "waiting", "発注").map((a) => a.text)).toEqual(["発注の確認"]);
    expect(filterAsks(list, "failed", "発注")).toEqual([]);
  });
  it("区分ごとの件数", () => {
    expect(countByFilter(list)).toEqual({ all: 4, active: 1, waiting: 1, done: 1, failed: 1 });
    expect(countByFilter([])).toEqual({ all: 0, active: 0, waiting: 0, done: 0, failed: 0 });
  });
});
