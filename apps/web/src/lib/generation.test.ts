import { describe, expect, it } from "vitest";
import type { AskEvent, AskSummary, FormationView } from "../api";
import { askCreatedAfterGiveUp, generationReducer as reduce, initialGen, TIMEOUT_FAILURE, isGenerationEvent, type GenAction, type GenState } from "./generation";

const ask = (over: Partial<AskSummary> = {}): AskSummary => ({
  id: "a1",
  text: "x",
  status: "generating",
  shape: null,
  shapeLine: null,
  trigger: null,
  question: null,
  failure: null,
  answerPreview: null,
  createdAt: "",
  updatedAt: "",
  ...over,
});

const formation: FormationView = {
  shape: "chain",
  shapeLine: "受信箱係 → 仕入れ係 の順に進めて、仕入れ係が答えます",
  notes: [],
  members: [
    { memberId: "m2", agentId: "g2", agentName: "仕入れ係", isNew: true, summary: "在庫を見て発注する", position: 2, dependsOn: [1], isAggregator: false, isSpokesperson: true },
    { memberId: "m1", agentId: "g1", agentName: "受信箱係", isNew: false, summary: "仕入れ先のメールを読む", position: 1, dependsOn: [], isAggregator: false, isSpokesperson: false },
  ],
};

const run = (actions: GenAction[], from: GenState = initialGen) => actions.reduce(reduce, from);
const formed: AskEvent = { type: "ask.formed", askId: "a1", formation, trigger: null };

describe("生成中の畳み込み", () => {
  it("送ると生成中になり、編成ができたら段の順に担当を出す", () => {
    const s = run([{ type: "submit", text: "メールを読んで" }, { type: "accepted", ask: ask() }, { type: "event", event: formed }]);
    expect(s.phase).toBe("shown");
    expect(s.members.map((m) => m.agentName)).toEqual(["受信箱係", "仕入れ係"]);
    expect(s.members[0]?.isNew).toBe(false);
    expect(s.shapeLine).toContain("→");
  });
  it("依頼の ID が分かる前に届いた事象は、分かってから流し直す", () => {
    const s = run([{ type: "submit", text: "t" }, { type: "event", event: formed }, { type: "accepted", ask: ask() }]);
    expect(s.phase).toBe("shown");
  });
  it("別の依頼の事象は無視する", () => {
    const s = run([{ type: "submit", text: "t" }, { type: "accepted", ask: ask() }, { type: "event", event: { ...formed, askId: "other" } }]);
    expect(s.phase).toBe("generating");
  });
  it("質問 → 答える → 生成中に戻る", () => {
    const q = { text: "どちらの店舗？", choices: [{ id: "1", label: "本店" }], allowFreeText: false };
    const s1 = run([{ type: "submit", text: "t" }, { type: "accepted", ask: ask() }, { type: "event", event: { type: "ask.question", askId: "a1", question: q } }]);
    expect(s1.phase).toBe("question");
    expect(reduce(s1, { type: "answered" }).phase).toBe("generating");
  });
  it("作れなかった：理由の1行を出し、送った文を残す", () => {
    const s = run([{ type: "submit", text: "元の文" }, { type: "accepted", ask: ask() }, { type: "event", event: { type: "ask.failed", askId: "a1", reason: "timeout", message: "時間切れでした" } }]);
    expect(s.phase).toBe("failed");
    expect(s.message).toBe("時間切れでした");
    expect(s.sentText).toBe("元の文");
  });
  it("30 秒の打ち切りは混雑の1行（言い方を変えるよう促さない）", () => {
    const s = run([{ type: "submit", text: "t" }, { type: "slow" }, { type: "timeout" }]);
    expect(s.message).toBe(TIMEOUT_FAILURE);
  });
  it("10 秒の印は生成中だけ", () => {
    expect(run([{ type: "submit", text: "t" }, { type: "slow" }]).slow).toBe(true);
    expect(reduce(initialGen, { type: "slow" }).slow).toBe(false);
  });
  it("取りこぼしても GET の結果（編成・失敗）で追いつく", () => {
    const base = run([{ type: "submit", text: "t" }, { type: "accepted", ask: ask() }]);
    const detail = { ask: ask({ status: "running" }), formation } as never;
    expect(reduce(base, { type: "detail", detail }).phase).toBe("shown");
    const bad = { ask: ask({ status: "failed", failure: { reason: "planner_error", message: "作れませんでした" } }), formation: null } as never;
    expect(reduce(base, { type: "detail", detail: bad }).message).toBe("作れませんでした");
  });
  it("見せたあとの事象では動かない", () => {
    const s = run([{ type: "submit", text: "t" }, { type: "accepted", ask: ask() }, { type: "event", event: formed }, { type: "event", event: { type: "ask.failed", askId: "a1", reason: "x", message: "m" } }]);
    expect(s.phase).toBe("shown");
  });
  it("生成に関わらない種類の事象（ask.answered など）が届いても状態を保つ（F-045）", () => {
    const base = run([{ type: "submit", text: "t" }, { type: "accepted", ask: ask() }]);
    const stray = { type: "ask.answered", askId: "a1", answerPreview: "x" } as unknown as AskEvent;
    const s = reduce(base, { type: "event", event: stray });
    expect(s).toBeDefined();
    expect(s.phase).toBe("generating");
    // 依頼の ID が分かる前に届いて流し直すときも同じ
    const early = run([{ type: "submit", text: "t" }, { type: "event", event: stray }, { type: "accepted", ask: ask() }]);
    expect(early.phase).toBe("generating");
  });
});

describe("isGenerationEvent", () => {
  it("生成に関わる5種だけ通す", () => {
    expect(isGenerationEvent({ type: "ask.formed", askId: "a1" })).toBe(true);
    expect(isGenerationEvent({ type: "ask.status", askId: "a1" })).toBe(true);
    expect(isGenerationEvent({ type: "ask.answered", askId: "a1" })).toBe(false);
    expect(isGenerationEvent({ type: "ask.message.posted", askId: "a1" })).toBe(false);
    expect(isGenerationEvent({ type: "check.changed", askId: "a1" })).toBe(false);
  });
  it("askId のない事象は通さない", () => {
    expect(isGenerationEvent({ type: "ask.formed" })).toBe(false);
  });
});

describe("askCreatedAfterGiveUp", () => {
  it("依頼の ID が分からなければ確かめずに null", async () => {
    const fetchAsk = async () => ({});
    expect(await askCreatedAfterGiveUp(null, fetchAsk)).toBeNull();
  });
  it("GET が通れば（依頼は作られていた）依頼の ID を返し、1回だけ確かめる", async () => {
    const calls: string[] = [];
    const fetchAsk = async (id: string) => {
      calls.push(id);
      return {};
    };
    expect(await askCreatedAfterGiveUp("a1", fetchAsk)).toBe("a1");
    expect(calls).toEqual(["a1"]);
  });
  it("GET が失敗すれば（作られていない・確かめられない）null", async () => {
    const fetchAsk = async () => {
      throw new Error("404");
    };
    expect(await askCreatedAfterGiveUp("a1", fetchAsk)).toBeNull();
  });
});
