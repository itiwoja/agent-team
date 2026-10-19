// 用意した依頼（ゲストの最初に入っている依頼）の再試験を、Gemini なしで同じように再現する（D-101）。
// エージェントの振る舞いだけを台本（scenarios.ts。事前計算 build.test.ts と同じ）に置き換え、Kernel の判定・ガード・sim-world・オラクルは本物のまま走らせる。
// 本物の Gemini だと、発注しない日などで再試験が揺れて、締めた結果を毎回同じに見せられないため。使うのは、試験の題が用意した12件とすべて一致するときだけ
// （自分の悪い日を足したり、作り直した依頼は本物の Gemini で走る）。

import type { RehearsalCaseRow } from "@open-team/db";
import { ScriptedLlmClient } from "@open-team/llm";
import type { LlmClient } from "@open-team/llm";
import type { AssistantPart } from "@open-team/runner";
import type { Scenario } from "@open-team/sim-core";
import { PLANNED_CASES } from "./scenarios.ts";

/** 台本の応答は Gemini を呼ばないので、使用量も費用も 0（走行・日次の費用の上限に数えない） */
const USAGE = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } as const;

const mcp = (id: string, connector: string, tool: string, args: Record<string, unknown> = {}): AssistantPart => ({
  type: "tool_call",
  id,
  name: "mcp_call",
  arguments: { connector, tool, arguments: args },
});
const report = (id: string, body = "受け取った内容を確認しました。"): AssistantPart => ({
  type: "tool_call",
  id,
  name: "submit_report",
  arguments: { title: "報告", body, sources: [] },
});

const titleOf = (c: Pick<RehearsalCaseRow, "scenario">): string => (c.scenario as unknown as Scenario).title;

/** 試験が用意した12件とちょうど同じ題なら、台本の並びに並べ直して返す（画面の並びと同じ）。違えば null（本物の Gemini で走らせる） */
export function orderAsPlanned<C extends Pick<RehearsalCaseRow, "scenario">>(cases: readonly C[]): C[] | null {
  if (cases.length !== PLANNED_CASES.length) return null;
  const ordered: C[] = [];
  for (const p of PLANNED_CASES) {
    const hit = cases.filter((c) => titleOf(c) === p.title);
    if (hit.length !== 1) return null;
    ordered.push(hit[0]!);
  }
  return ordered;
}

/**
 * 台本どおりに動く LLM と、いまの試験を選ぶ select。試験ごとに、走る前に select(試験) を呼ぶこと（suite の shadowFor）：
 * 1つの試験は統制ありの走行のほかに承認した場合の分岐も走り、どれも同じ台本を踏むので、走った回数では試験を数えられない。
 * 受信箱係はメールを読んで報告、仕入れ係は在庫を読む → 状況ごとの手順 → 報告。台本はこれまでのツールの結果の数で決める
 */
export function createGuestReplay(): { llm: LlmClient; select: (c: Pick<RehearsalCaseRow, "scenario">) => void } {
  let current = 0;
  const llm = new ScriptedLlmClient((req) => {
    const n = req.messages.filter((m) => m.role === "tool").length;
    if (req.mcpTools.some((t) => t.tool === "list_inbox")) {
      return { parts: [n === 0 ? mcp("c-mail", "mail", "list_inbox", {}) : report("c-r1", "受信箱を読みました。")], usage: USAGE };
    }
    const plan = PLANNED_CASES[current]!.buyer;
    if (n === 0) return { parts: [mcp("c-inv", "store", "get_inventory")], usage: USAGE };
    const step = plan[n - 1];
    if (step) return { parts: [mcp(`c-${n}`, step.connector, step.tool, step.args)], usage: USAGE };
    return { parts: [report("c-report")], usage: USAGE };
  });
  const select = (c: Pick<RehearsalCaseRow, "scenario">): void => {
    const i = PLANNED_CASES.findIndex((p) => p.title === titleOf(c));
    if (i >= 0) current = i;
  };
  return { llm, select };
}
