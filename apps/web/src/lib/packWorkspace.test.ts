import { describe, expect, it } from "vitest";
import { canMuse, clip, deskStateOf, matchMembers, musingAt, musingsOf, pickSpeakers, reactionOf, type DeskInput } from "./packWorkspace";

const grader = { name: "採点ロボ先生", summary: "解答の CSV を採点し、設問ごとの正答率を出す", template: "dev-coder", skills: ["採点の手順"], files: ["samples/answers.csv", "grade.py"] };
const examples = ["中学2年の「一次関数」の授業プリントを作って", "この小テストの解答を採点して、正答率の低い問題を教えて"];

describe("musingsOf（独り言の候補）", () => {
  it("スキル・スクリプト・例の依頼から組み立てる（スクリプトを先に）", () => {
    const m = musingsOf(grader, examples);
    expect(m[0]).toBe("『採点の手順』を読み返しています");
    expect(m[1]).toBe("grade.py を確かめています");
    expect(m[2]).toBe("answers.csv を眺めています");
    expect(m.some((s) => s.startsWith("次の「") && s.endsWith("」に備えています"))).toBe(true);
    // 例の依頼の「」は『』にして、吹き出しの鉤括弧と入れ子にしない
    expect(m.some((s) => s.includes("『一次関数』"))).toBe(true);
    expect(m.some((s) => /「[^」]*「/.test(s))).toBe(false);
  });
  it("重なりがない", () => {
    const m = musingsOf({ ...grader, skills: ["採点の手順", "採点の手順"] }, [...examples, ...examples]);
    expect(new Set(m).size).toBe(m.length);
  });
  it("持ち物も例も無くても 3 つはある", () => {
    const m = musingsOf({ name: "だれか", summary: "", template: "unknown", skills: [], files: [] }, []);
    expect(m.length).toBeGreaterThanOrEqual(3);
    expect(new Set(m).size).toBe(m.length);
  });
  it("長い例は切る", () => {
    const m = musingsOf({ ...grader, skills: [], files: [] }, ["あいうえおかきくけこさしすせそたちつてと"]);
    expect(m).toContain("次の「あいうえおかきくけこさしすせ…」に備えています");
  });
  it("同じ担当ならいつも同じ（決定論）", () => {
    expect(musingsOf(grader, examples)).toEqual(musingsOf(grader, examples));
  });
});

describe("musingAt", () => {
  it("tick で順に回り、空なら null", () => {
    const m = ["a", "b", "c"];
    const seen = new Set([0, 1, 2].map((t) => musingAt(m, "x", t)));
    expect(seen).toEqual(new Set(m));
    expect(musingAt([], "x", 0)).toBeNull();
  });
});

describe("pickSpeakers（独り言を話す担当）", () => {
  const names = ["プリント錬金術師", "採点ロボ先生", "学級だより記者"];
  it("1〜2人で、候補の中から選ぶ", () => {
    for (let t = 0; t < 20; t++) {
      const s = pickSpeakers(names, t);
      expect(s.length).toBeGreaterThanOrEqual(1);
      expect(s.length).toBeLessThanOrEqual(2);
      expect(new Set(s).size).toBe(s.length);
      for (const n of s) expect(names).toContain(n);
    }
  });
  it("同じ tick なら同じ（決定論）・並び順に依らない", () => {
    expect(pickSpeakers(names, 7)).toEqual(pickSpeakers([...names].reverse(), 7));
  });
  it("tick を進めると全員に順番が回る", () => {
    const all = new Set(Array.from({ length: names.length }, (_, t) => pickSpeakers(names, t)).flat());
    expect(all).toEqual(new Set(names));
  });
  it("max を守る・空なら空", () => {
    for (let t = 0; t < 10; t++) expect(pickSpeakers(names, t, 1)).toHaveLength(1);
    expect(pickSpeakers([], 3)).toEqual([]);
    expect(pickSpeakers(["ひとり"], 5)).toEqual(["ひとり"]);
  });
});

describe("reactionOf（頼まれた瞬間の反応）", () => {
  it("型ごとの文から seed で決める（決定論）", () => {
    expect(reactionOf("researcher", 0)).toBe(reactionOf("researcher", 0));
    expect(reactionOf("researcher", 0)).not.toBe(reactionOf("researcher", 1));
  });
  it("知らない型・負の seed でも文を返す", () => {
    expect(reactionOf("unknown", -3)).toMatch(/\S/);
  });
});

const base: DeskInput = { installed: true, activity: "idle", askText: null, phase: "idle", joined: false, reaction: "見ます！", musing: null };

describe("deskStateOf（机の表示）", () => {
  it("入れていないときは静かな案内（待っている顔）", () => {
    expect(deskStateOf({ ...base, installed: false, phase: "generating" })).toEqual({ mood: "waiting", bubble: "この作業場に来る担当です", kind: "guide", glow: false });
  });
  it("待機中は独り言（話さない tick は吹き出しなし）", () => {
    expect(deskStateOf({ ...base, musing: "grade.py を確かめています" })).toMatchObject({ mood: "idle", kind: "ambient", bubble: "grade.py を確かめています" });
    expect(deskStateOf(base)).toMatchObject({ mood: "idle", kind: "none", bubble: null });
  });
  it("送った瞬間は全員が動き出して反応する", () => {
    expect(deskStateOf({ ...base, phase: "generating", musing: "x" })).toMatchObject({ mood: "running", kind: "reaction", bubble: "見ます！" });
    expect(deskStateOf({ ...base, activity: "running", phase: "generating" })).toMatchObject({ kind: "reaction" });
  });
  it("質問のあいだは手を挙げる", () => {
    expect(deskStateOf({ ...base, phase: "question" })).toMatchObject({ mood: "approval", kind: "reaction" });
  });
  it("編成に入った担当は光る。入らなかった担当はいつもの様子に戻る", () => {
    expect(deskStateOf({ ...base, phase: "shown", joined: true })).toEqual({ mood: "running", bubble: "この依頼に入りました", kind: "joined", glow: true });
    // 編成に入った担当が本当に動き出したら、その様子を出す（机は光ったまま）
    expect(deskStateOf({ ...base, phase: "shown", joined: true, activity: "running", askText: "a" })).toEqual({ mood: "running", bubble: "動いています：a", kind: "status", glow: true });
    expect(deskStateOf({ ...base, phase: "shown", joined: true, activity: "awaiting_approval" })).toMatchObject({ mood: "approval", kind: "status", glow: true });
    expect(deskStateOf({ ...base, phase: "shown", musing: "m" })).toMatchObject({ kind: "ambient", glow: false });
  });
  it("本当に動いている・確認待ちは固定の文（独り言より先）", () => {
    expect(deskStateOf({ ...base, activity: "running", askText: "小テストを採点して", musing: "m" })).toMatchObject({ mood: "running", kind: "status", bubble: "動いています：小テストを採点して" });
    expect(deskStateOf({ ...base, activity: "awaiting_approval" })).toMatchObject({ mood: "approval", kind: "status", bubble: "確認待ちです" });
  });
  it("止めた担当は生成中でも止めたまま", () => {
    expect(deskStateOf({ ...base, activity: "disabled", phase: "generating" })).toMatchObject({ mood: "stopped", kind: "status" });
  });
  it("失敗したら（failed）いつもの様子に戻る", () => {
    expect(deskStateOf({ ...base, phase: "failed", musing: "m" })).toMatchObject({ mood: "idle", kind: "ambient" });
  });
});

describe("canMuse", () => {
  it("入れてあって待機中のときだけ", () => {
    expect(canMuse(base)).toBe(true);
    expect(canMuse({ ...base, activity: null })).toBe(true);
    expect(canMuse({ ...base, installed: false })).toBe(false);
    expect(canMuse({ ...base, activity: "running" })).toBe(false);
    expect(canMuse({ ...base, phase: "generating" })).toBe(false);
    expect(canMuse({ ...base, phase: "shown", joined: true })).toBe(false);
    expect(canMuse({ ...base, phase: "shown" })).toBe(true);
  });
});

describe("matchMembers（机に当たる担当と応援）", () => {
  const desks = [
    { name: "プリント錬金術師", agentId: "a1" },
    { name: "採点ロボ先生", agentId: "a2" },
    { name: "学級だより記者", agentId: null },
  ];
  it("agentId で机に当て、新しく作った担当は応援にする", () => {
    const r = matchMembers(
      [
        { key: "m1", agentName: "採点ロボ先生", summary: "採点する", isNew: false, agentId: "a2" },
        { key: "m2", agentName: "要約くん", summary: "まとめる", isNew: true, agentId: "n1" },
      ],
      desks,
    );
    expect(r.joined).toEqual({ 採点ロボ先生: "採点する" });
    expect(r.helpers).toEqual([{ key: "m2", agentName: "要約くん", summary: "まとめる", isNew: true }]);
  });
  it("ID が分からなければ名前で当てる", () => {
    const r = matchMembers([{ key: "m1", agentName: "学級だより記者", summary: "書く", isNew: false, agentId: "zz" }], desks);
    expect(r.joined).toEqual({ 学級だより記者: "書く" });
    const r2 = matchMembers([{ key: "m1", agentName: "プリント錬金術師", summary: "作る", isNew: false }], desks);
    expect(r2.joined).toEqual({ プリント錬金術師: "作る" });
  });
  it("ID が食い違えば同じ名前でも机に当てない（ほかの担当）", () => {
    const r = matchMembers([{ key: "m1", agentName: "採点ロボ先生", summary: "x", isNew: false, agentId: "other" }], desks);
    expect(r.joined).toEqual({});
    expect(r.helpers).toHaveLength(1);
  });
  it("同じ名前の新顔は机に当てない", () => {
    const r = matchMembers([{ key: "m1", agentName: "採点ロボ先生", summary: "x", isNew: true }], desks);
    expect(r.joined).toEqual({});
    expect(r.helpers[0]?.isNew).toBe(true);
  });
});

describe("clip", () => {
  it("n 文字を超えたら切る・空白をまとめる", () => {
    expect(clip("あいう", 3)).toBe("あいう");
    expect(clip("あいうえ", 3)).toBe("あいう…");
    expect(clip(" a\n b ", 10)).toBe("a b");
  });
});
