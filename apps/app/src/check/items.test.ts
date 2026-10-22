// 「頼む・チェック」の報告の行（items.ts）のうち、練習（リハーサル）の行の文言
import type { AnswerRunRow, RehearsalReportRow } from "@open-team/db/check";
import { describe, expect, it } from "vitest";
import type { EvolutionReportRow } from "@open-team/db/check";
import { answerItem, evolutionItem, rehearsalItem, rehearsalLine } from "./items.ts";

function report(run: Partial<RehearsalReportRow["run"]>): RehearsalReportRow {
  return {
    run: { id: "r1", status: "done", trigger: "initial", certificate_id: null, ask_id: "a1", summary: null, created_at: new Date("2026-10-05T07:00:00Z"), finished_at: new Date("2026-10-05T07:01:00Z"), ...run } as RehearsalReportRow["run"],
    subjectName: "仕入れ係",
    agentId: "g1" as RehearsalReportRow["agentId"],
  };
}

describe("練習の行", () => {
  it("件数は「件」で数える", () => {
    expect(rehearsalLine(report({ summary: { counts: { total: 12, withControl: { slipped: 0 } } } as never })).title).toBe("仕入れ係の練習：12件の状況、すり抜けなし");
    expect(rehearsalLine(report({ summary: { counts: { total: 12, withControl: { slipped: 2 }, afterTighten: null } } as never })).title).toBe("仕入れ係の練習：12件中2件で穴があります");
    expect(rehearsalLine(report({ summary: { counts: { total: 12, withControl: { slipped: 2 }, afterTighten: { slipped: 1 } } } as never })).title).toBe("仕入れ係の練習：12件中2件で穴 → まだ1件残っています");
  });

  it("自分の言葉の悪い日の走行は安全チェック済みを出さない種類なので、「安全チェックはまだ」と書かない", () => {
    expect(rehearsalItem(report({ trigger: "user_case" })).subtitle).toMatch(/^自分の言葉の悪い日 · /);
    expect(rehearsalItem(report({ trigger: "initial" })).subtitle).toMatch(/^安全チェックはまだ · /);
    expect(rehearsalItem(report({ trigger: "retest", certificate_id: "c1" as never })).subtitle).toMatch(/^安全チェック済み · /);
  });
});

describe("回答の行", () => {
  const run = (over: Partial<AnswerRunRow["run"]> = {}): AnswerRunRow["run"] =>
    ({
      id: "r1",
      ask_id: "a1",
      status: "done",
      trigger_type: "initial",
      answer: { conclusion: "豆を20kg発注します。", memberLines: [], spokesperson: null, needsYou: { pendingApprovals: 0, stoppedMembers: [] }, intermediate: [], taintNote: null },
      answered_at: new Date("2026-10-05T07:00:00Z"),
      started_at: new Date("2026-10-05T06:59:00Z"),
      ...over,
    }) as unknown as AnswerRunRow["run"];
  it("どの頼みごとへの回答かを添える（最初の実行は依頼の文）", () => {
    expect(answerItem({ run: run(), askText: "在庫を見て発注して", requestText: "在庫を見て発注して" }).request).toBe("在庫を見て発注して");
    // 担当のタスクに prompt が残っていない（用意した依頼）ときも依頼の文を出す
    expect(answerItem({ run: run(), askText: "在庫を見て発注して", requestText: null }).request).toBe("在庫を見て発注して");
  });
  it("題は結論の1行目から記法を外したもの", () => {
    const r = run({ answer: { conclusion: "## 発注の数量を **25kg** に `変え` ました。[詳細](https://example.com/x)\n\n本文", memberLines: [], spokesperson: null, needsYou: { pendingApprovals: 0, stoppedMembers: [] }, intermediate: [], taintNote: null } as unknown as AnswerRunRow["run"]["answer"] });
    expect(answerItem({ run: r, askText: "x", requestText: null }).title).toBe("発注の数量を 25kg に 変え ました。詳細");
  });
  it("返事の実行は返事の文を添える", () => {
    expect(answerItem({ run: run({ trigger_type: "manual" }), askText: "在庫を見て発注して", requestText: "もう少し詳しく" }).request).toBe("もう少し詳しく");
  });
});

describe("整理の行", () => {
  const evt = (items: Array<{ type: "skill" | "rule"; label: string }>): EvolutionReportRow => ({
    event: { id: "e1", agent_id: "g1", items: items.map((i, n) => ({ ...i, id: `i${n}`, restoredAt: null })), created_at: new Date("2026-10-05T07:00:00Z") } as unknown as EvolutionReportRow["event"],
    agentName: "仕入れ係",
  });
  it("0件の種類は出さない", () => {
    expect(evolutionItem(evt([{ type: "skill", label: "a" }, { type: "skill", label: "b" }])).title).toBe("仕入れ係：使われていないスキル 2件を外しました（担当のページで戻せます）");
    expect(evolutionItem(evt([{ type: "rule", label: "r" }])).title).toBe("仕入れ係：ルール 1件を外しました（担当のページで戻せます）");
    const both = evolutionItem(evt([{ type: "skill", label: "a" }, { type: "rule", label: "r" }]));
    expect(both.title).toBe("仕入れ係：使われていないスキル 1件・ルール 1件を外しました（担当のページで戻せます）");
    expect(both.link).toEqual({ askId: null, rehearsalRunId: null, agentId: "g1" });
  });
});
