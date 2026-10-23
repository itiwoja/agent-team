// 実効ポリシーの要約（packages/edge/src/policy-summary.ts の写し。TaskContext.policySummary。FR-025「このエージェントにできること」の固定の文テンプレート：ab:103、si:49）。
// LLM を使わない。文の形は scripts/measure の policySummaryLines と同じ並び（読み取り → 書き込み → 予算）にした。
// measure は manifest の actionNoun（「発注」など）を使うが、本番の DB（connector_tools）には actionNoun がないので
// '<コネクタ>.<ツール>' の名前で書く（プロンプトの「外部サービスのツール」の一覧と同じ名前）。共通の置き場は contract_issues

import type { EffectivePolicy } from "@open-team/kernel";
import type { McpToolSpec } from "@open-team/runner";
import { compareText } from "./util.ts";

function usd2(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** 名前に使えない文字は ? にする（外から来た名前をシステムの指示に入れるため。runner の safeToolName と同じ考え方） */
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "?").slice(0, 128);
}

/** 付与された MCP のツール（mcpTools）と実効ポリシーから、固定の文の要約を作る */
export function policySummaryLines(policy: EffectivePolicy, mcpTools: readonly McpToolSpec[]): string[] {
  const reads: string[] = [];
  const writes: string[] = [];
  for (const t of [...mcpTools].sort((a, b) => compareText(`${a.connector}.${a.tool}`, `${b.connector}.${b.tool}`))) {
    const name = `${safeName(t.connector)}.${safeName(t.tool)}`;
    // 未分類は書き込みとして扱う（ADR-022）
    (t.classification === "read" ? reads : writes).push(name);
  }
  const lines: string[] = [];
  if (reads.length > 0) lines.push(`${reads.join("・")} で読み取りができます`);
  if (writes.length === 0 || policy.mcp.llmWrite !== true) {
    lines.push("外部のサービスには書き込めません");
  } else {
    const list = writes.join("・");
    const hasRule = policy.rules.enabled === true && policy.rules.items.length > 0;
    switch (policy.autonomy.mcp_write) {
      case "approve":
        lines.push(
          hasRule
            ? `${list} は、ルールに一致すれば確認なしで、ほかは利用者の確認のあとで実行されます`
            : `${list} は、利用者の確認のあとで実行されます`,
        );
        break;
      case "handoff":
        lines.push(`${list} は、利用者に引き継ぎます`);
        break;
      case "auto":
        // mcp_write の auto は Hard Ceiling で approve になる（decide の手順8）。ルール経由だけ確認なし
        lines.push(`${list} は、ルールに一致すれば確認なしで、ほかは利用者の確認のあとで実行されます`);
        break;
      default:
        lines.push(`${list} はできません`);
        break;
    }
  }
  lines.push(`1回あたり最大 ${usd2(policy.budget.per_task_usd)}、1日 ${usd2(policy.budget.agent_day_usd ?? policy.budget.per_day_usd)} まで`);
  return lines;
}
