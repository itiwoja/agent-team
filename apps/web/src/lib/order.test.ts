import { describe, expect, it } from "vitest";
import type { ApprovalItem, CheckItem, QuestionItem, ReportItem } from "../api";
import { applyCheckEvent, sortCheckItems, withoutKeys } from "./order";

const base = { subtitle: null, agent: null, askId: null, opened: false };
const report = (key: string, at: string): ReportItem => ({ ...base, key, title: key, at, kind: "report", reportKind: "task", failed: false, dryRun: false, body: null, lines: [], link: { askId: null, rehearsalRunId: null } });
const question = (key: string, at: string): QuestionItem => ({ ...base, key, title: key, at, kind: "question", source: "ask_question", question: { text: key, choices: [], allowFreeText: true }, reason: "", intentId: null });
const approval = (key: string, at: string, open = false): ApprovalItem => ({
  ...base,
  key,
  title: key,
  at,
  kind: "approval",
  approval: { openReason: open ? { code: "widen", text: "", emphasis: null, limitText: null } : null } as ApprovalItem["approval"],
});
const keys = (items: CheckItem[]) => items.map((i) => i.key);

describe("見てほしいものの並び順", () => {
  it("送る前の確認 → 質問 → 報告、同じ種類の中は新しい順", () => {
    const sorted = sortCheckItems([report("r-old", "2026-10-03T01:00:00Z"), question("q", "2026-10-03T02:00:00Z"), report("r-new", "2026-10-03T03:00:00Z"), approval("a-old", "2026-10-03T00:00:00Z"), approval("a-new", "2026-10-03T00:30:00Z")]);
    expect(keys(sorted)).toEqual(["a-new", "a-old", "q", "r-new", "r-old"]);
  });
  it("開いた状態の確認が3つ以上あるとき、確認の中でそれらを先にする", () => {
    const items = [approval("closed-new", "2026-10-03T09:00:00Z"), approval("o1", "2026-10-03T01:00:00Z", true), approval("o2", "2026-10-03T02:00:00Z", true), approval("o3", "2026-10-03T03:00:00Z", true)];
    expect(keys(sortCheckItems(items))).toEqual(["o3", "o2", "o1", "closed-new"]);
  });
  it("開いた確認が2つ以下なら新しい順のまま", () => {
    const items = [approval("closed-new", "2026-10-03T09:00:00Z"), approval("o1", "2026-10-03T01:00:00Z", true)];
    expect(keys(sortCheckItems(items))).toEqual(["closed-new", "o1"]);
  });
  it("元の配列を変えない・同時刻はキー順", () => {
    const items = [report("b", "2026-10-03T01:00:00Z"), report("a", "2026-10-03T01:00:00Z")];
    const copy = [...items];
    expect(keys(sortCheckItems(items))).toEqual(["a", "b"]);
    expect(items).toEqual(copy);
  });
});

describe("SSE の畳み込み", () => {
  it("check.upsert：増えた行は並び順に入り、変わった行は置き換わる", () => {
    const a = report("r1", "2026-10-03T01:00:00Z");
    const added = applyCheckEvent([a], "check.upsert", { item: approval("a1", "2026-10-03T00:00:00Z") });
    expect(keys(added)).toEqual(["a1", "r1"]);
    const changed = applyCheckEvent(added, "check.upsert", { item: { ...a, title: "変わった" } });
    expect(changed.find((i) => i.key === "r1")?.title).toBe("変わった");
    expect(changed).toHaveLength(2);
  });
  it("check.remove：消える。知らない事象・壊れた本文は何もしない", () => {
    const items = [report("r1", "2026-10-03T01:00:00Z")];
    expect(applyCheckEvent(items, "check.remove", { key: "r1" })).toEqual([]);
    expect(applyCheckEvent(items, "check.counts", { attention: 1 })).toEqual(items);
    expect(applyCheckEvent(items, "check.upsert", null)).toEqual(items);
  });
  it("withoutKeys：消した行を隠す", () => {
    expect(keys(withoutKeys([report("a", "x"), report("b", "x")], new Set(["a"])))).toEqual(["b"]);
  });
});
