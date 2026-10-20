// 編成の進め方の決定（plan.ts）の試験：形ごとの動かし方・受け渡し・失敗時の扱い（FR-062）
import type { TaskStatus } from "@open-team/db";
import { describe, expect, it } from "vitest";
import { AGGREGATOR_WAIT_MS, evaluateRun, phaseOf, type PlanMember, type Shape } from "./plan.ts";

const NOW = new Date("2026-10-14T01:00:00Z");
const m = (id: string, position: number | null, status: TaskStatus | null, o: { report?: boolean; aggregator?: boolean } = {}): PlanMember => ({
  memberId: id,
  position,
  isAggregator: o.aggregator ?? false,
  task: status === null ? null : { id: `t-${id}`, status, hasReport: o.report ?? (status === "succeeded" || status === "completed") },
});
const run = (shape: Shape, members: PlanMember[], o: { first?: Date | null; now?: Date } = {}) =>
  evaluateRun({ shape, members, now: o.now ?? NOW, firstStartedAt: o.first === undefined ? NOW : o.first });

describe("phaseOf", () => {
  it("状態を4つに分ける", () => {
    expect(phaseOf(null)).toBe("none");
    for (const s of ["queued", "provisioning", "running", "executing"] as const) expect(phaseOf(s)).toBe("active");
    expect(phaseOf("awaiting_approval")).toBe("awaiting");
    for (const s of ["succeeded", "completed"] as const) expect(phaseOf(s)).toBe("ok");
    for (const s of ["rejected", "failed", "cancelled", "halted"] as const) expect(phaseOf(s)).toBe("stopped");
  });
});

describe("single", () => {
  it("まだ始まっていなければ担当を始める", () => {
    expect(run("single", [m("a", 1, null)])).toMatchObject({ start: [{ memberId: "a", inputTaskIds: [] }], status: "running", answerReady: false });
  });
  it("済み → done・回答を出せる。失敗 → failed（回答は止まった旨）", () => {
    expect(run("single", [m("a", 1, "succeeded")])).toMatchObject({ start: [], status: "done", answerReady: true });
    expect(run("single", [m("a", 1, "failed")])).toMatchObject({ start: [], status: "failed", answerReady: true });
  });
  it("確認待ちでも報告があれば回答を出せる（確認を待たない）。実行の状態はまだ running", () => {
    expect(run("single", [m("a", 1, "awaiting_approval", { report: true })])).toMatchObject({ status: "running", answerReady: true });
    expect(run("single", [m("a", 1, "running", { report: false })])).toMatchObject({ status: "running", answerReady: false });
  });
});

describe("parallel", () => {
  it("全員を同時に始め、受け渡しはしない", () => {
    const r = run("parallel", [m("a", 1, null), m("b", 2, null), m("c", 3, null)]);
    expect(r.start.map((s) => s.memberId)).toEqual(["a", "b", "c"]);
    expect(r.start.every((s) => s.inputTaskIds.length === 0)).toBe(true);
  });
  it("1人が失敗してもほかは続く。全員終われば done（1人でも済みがあれば）、全員失敗なら failed", () => {
    expect(run("parallel", [m("a", 1, "failed"), m("b", 2, "running")])).toMatchObject({ status: "running", answerReady: false });
    expect(run("parallel", [m("a", 1, "failed"), m("b", 2, "succeeded")])).toMatchObject({ status: "done", answerReady: true });
    expect(run("parallel", [m("a", 1, "failed"), m("b", 2, "halted")])).toMatchObject({ status: "failed", answerReady: true });
  });
  it("回答は全員が終わる（確認待ちを含む）か A-100 の待ち時間を過ぎたとき", () => {
    expect(run("parallel", [m("a", 1, "succeeded"), m("b", 2, "awaiting_approval")])).toMatchObject({ answerReady: true });
    const slow = [m("a", 1, "succeeded"), m("b", 2, "running", { report: false })];
    expect(run("parallel", slow).answerReady).toBe(false);
    expect(run("parallel", slow, { now: new Date(NOW.getTime() + AGGREGATOR_WAIT_MS) }).answerReady).toBe(true);
  });
});

describe("aggregate", () => {
  const workers = (a: TaskStatus | null, b: TaskStatus | null) => [m("a", 1, a), m("b", 2, b)];
  it("担当を同時に始め、まとめ役はまだ始めない", () => {
    const r = run("aggregate", [...workers(null, null), m("g", 3, null, { aggregator: true })]);
    expect(r.start.map((s) => s.memberId)).toEqual(["a", "b"]);
  });
  it("全員が終わったらまとめ役を始め、全担当の結果を渡す（報告を出した失敗の担当も入れる）", () => {
    const ms = [m("a", 1, "succeeded"), m("b", 2, "failed", { report: true }), m("g", 3, null, { aggregator: true })];
    const r = run("aggregate", ms);
    expect(r.start).toEqual([{ memberId: "g", inputTaskIds: ["t-a", "t-b"] }]);
    expect(r.status).toBe("running");
  });
  it("報告のないタスク（失敗で本文なし）は、まとめ役の入力に入れない", () => {
    const r = run("aggregate", [...workers("succeeded", "failed"), m("g", 3, null, { aggregator: true })]);
    expect(r.start).toEqual([{ memberId: "g", inputTaskIds: ["t-a"] }]);
  });
  it("待ち時間を過ぎても、動作中で報告のないタスクはまとめ役の入力に入れない（報告済みの分だけ）", () => {
    const ms = [...workers("succeeded", "running"), m("g", 3, null, { aggregator: true })];
    const late = run("aggregate", ms, { now: new Date(NOW.getTime() + AGGREGATOR_WAIT_MS + 1) });
    expect(late.start).toEqual([{ memberId: "g", inputTaskIds: ["t-a"] }]);
  });
  it("待ち時間を過ぎて報告がひとつもなければ、まとめ役は動かさず failed（入力0件のまとめ役は作らない）", () => {
    const ms = [m("a", 1, "running"), m("b", 2, "queued"), m("g", 3, null, { aggregator: true })];
    const late = run("aggregate", ms, { now: new Date(NOW.getTime() + AGGREGATOR_WAIT_MS) });
    expect(late).toMatchObject({ start: [], status: "failed", answerReady: true });
  });
  it("終わっていない担当がいれば待つ。待ち時間（A-100）を過ぎたら終わった分でまとめる", () => {
    const ms = [...workers("succeeded", "running"), m("g", 3, null, { aggregator: true })];
    expect(run("aggregate", ms).start).toEqual([]);
    const late = run("aggregate", ms, { now: new Date(NOW.getTime() + AGGREGATOR_WAIT_MS + 1) });
    expect(late.start.map((s) => s.memberId)).toEqual(["g"]);
  });
  it("全員が失敗したらまとめ役は動かさず failed（回答は止まった旨）", () => {
    const r = run("aggregate", [...workers("failed", "halted"), m("g", 3, null, { aggregator: true })]);
    expect(r).toMatchObject({ start: [], status: "failed", answerReady: true });
  });
  it("まとめ役が終われば done。回答はまとめ役の報告", () => {
    const ms = [...workers("succeeded", "succeeded"), m("g", 3, "succeeded", { aggregator: true })];
    expect(run("aggregate", ms)).toMatchObject({ start: [], status: "done", answerReady: true });
    const ongoing = [...workers("succeeded", "succeeded"), m("g", 3, "running", { aggregator: true, report: false })];
    expect(run("aggregate", ongoing)).toMatchObject({ status: "running", answerReady: false });
  });
});

describe("chain（同時に動く担当がいる段取り）", () => {
  const d = (id: string, position: number, status: TaskStatus | null, dependsOn: number[]) => ({ ...m(id, position, status), dependsOn });
  it("依存のない担当を同時に始め、依存がすべて済んだ担当に全員の結果を渡す", () => {
    expect(run("chain", [d("w", 1, null, []), d("g", 2, null, []), d("i", 3, null, [1, 2])]).start).toEqual([
      { memberId: "w", inputTaskIds: [] },
      { memberId: "g", inputTaskIds: [] },
    ]);
    expect(run("chain", [d("w", 1, "succeeded", []), d("g", 2, "running", []), d("i", 3, null, [1, 2])])).toMatchObject({ start: [], status: "running" });
    expect(run("chain", [d("w", 1, "succeeded", []), d("g", 2, "succeeded", []), d("i", 3, null, [1, 2])]).start).toEqual([
      { memberId: "i", inputTaskIds: ["t-w", "t-g"] },
    ]);
  });
  it("依存が済んだ担当は、ほかの枝が動いている間に始める", () => {
    const r = run("chain", [d("a", 1, "succeeded", []), d("b", 2, null, [1]), d("c", 3, "running", []), d("e", 4, null, [2, 3])]);
    expect(r).toMatchObject({ start: [{ memberId: "b", inputTaskIds: ["t-a"] }], status: "running" });
  });
  it("1人が止まっても、同時に動く担当は続ける。動く担当がいなくなったら waiting_input（止まった担当）", () => {
    expect(run("chain", [d("w", 1, "failed", []), d("g", 2, "running", []), d("i", 3, null, [1, 2])])).toMatchObject({ start: [], status: "running", stoppedMemberId: null });
    expect(run("chain", [d("w", 1, "failed", []), d("g", 2, "succeeded", []), d("i", 3, null, [1, 2])])).toMatchObject({ start: [], status: "waiting_input", stoppedMemberId: "w" });
  });
  it("全員が済めば done・回答を出せる", () => {
    expect(run("chain", [d("w", 1, "succeeded", []), d("g", 2, "succeeded", []), d("i", 3, "completed", [1, 2])])).toMatchObject({ status: "done", answerReady: true });
  });
});

describe("chain", () => {
  it("1段目から始め、前の段が済みになったら次を始める（前の段のタスクを渡す）", () => {
    expect(run("chain", [m("a", 1, null), m("b", 2, null)]).start).toEqual([{ memberId: "a", inputTaskIds: [] }]);
    expect(run("chain", [m("a", 1, "succeeded"), m("b", 2, null)]).start).toEqual([{ memberId: "b", inputTaskIds: ["t-a"] }]);
    expect(run("chain", [m("a", 1, "completed"), m("b", 2, null)]).start).toEqual([{ memberId: "b", inputTaskIds: ["t-a"] }]);
  });
  it("前の段が動いている・確認待ちのあいだは次を始めない", () => {
    expect(run("chain", [m("a", 1, "running"), m("b", 2, null)])).toMatchObject({ start: [], status: "running" });
    expect(run("chain", [m("a", 1, "awaiting_approval", { report: true }), m("b", 2, null)])).toMatchObject({ start: [], status: "running" });
  });
  it("段が止まったら次を始めず waiting_input（止まった担当を示す）。最後の段が止まっても同じ", () => {
    expect(run("chain", [m("a", 1, "failed"), m("b", 2, null)])).toMatchObject({ start: [], status: "waiting_input", stoppedMemberId: "a", answerReady: false });
    expect(run("chain", [m("a", 1, "succeeded"), m("b", 2, "halted")])).toMatchObject({ status: "waiting_input", stoppedMemberId: "b" });
    expect(run("chain", [m("a", 1, "rejected"), m("b", 2, null)])).toMatchObject({ status: "waiting_input", stoppedMemberId: "a" });
  });
  it("やり直し：止まった段に新しいタスクがあれば（最新が動いている）また running", () => {
    expect(run("chain", [m("a", 1, "succeeded"), m("b", 2, "queued")])).toMatchObject({ status: "running", start: [] });
  });
  it("最後の段の報告があれば回答を出せる（確認待ちでも）。全段済みなら done", () => {
    expect(run("chain", [m("a", 1, "succeeded"), m("b", 2, "awaiting_approval", { report: true })])).toMatchObject({ status: "running", answerReady: true });
    expect(run("chain", [m("a", 1, "succeeded"), m("b", 2, "succeeded")])).toMatchObject({ status: "done", answerReady: true });
  });
  it("position の順に並べ直して判定する", () => {
    expect(run("chain", [m("b", 2, null), m("a", 1, "succeeded")]).start).toEqual([{ memberId: "b", inputTaskIds: ["t-a"] }]);
  });
});
