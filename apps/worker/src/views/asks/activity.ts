// 依頼のページの「やったこと」（担当の段の進み具合。apps/app/src/asks/activity.ts の WorkspaceDO 版）。policy_decisions の tool_call を、決まった文の1行にする。
// LLM の文は入れない（ツールの名詞は manifest、結果は Kernel の判定から作る：D-59 と同じ考え）

import { KNOWN_CONNECTORS } from "../connectors/known.ts";
import type { ToolActivityRow } from "../../db/repo/asks.ts";
import type { StageActivityView } from "./contract.ts";

/** 段ごとに返す件数（新しいものから） */
export const ACTIVITY_PER_TASK = 6;

/** MCP 以外のツール（runner の ToolName）の言い方 */
const BUILTIN_LABELS: Readonly<Record<string, string>> = {
  submit_report: "報告をまとめる",
  team_post: "仲間に連絡",
  team_wait: "仲間の返事を待つ",
  ask_user: "あなたに質問",
  notify: "通知",
  remember: "覚えておく",
  finish: "終える",
  web_search: "Web の検索",
  web_fetch: "Web のページを読む",
  load_skill: "スキルを読む",
  list_files: "作業場のファイルを見る",
  read_file: "ファイルを読む",
  search: "ファイルの中を探す",
  write_file: "ファイルを書く",
  delete_file: "ファイルを消す",
  run_command: "コマンドを動かす",
};

/** 'mcp.gcal.create_event' → manifest の操作名。manifest にないツールはツール名のまま、MCP 以外は固定の言い方 */
export function activityLabel(action: string | null): string {
  if (action === null) return "ツールの呼び出し";
  const m = /^mcp\.([a-z0-9][a-z0-9-]*)\.(.+)$/.exec(action);
  if (m === null) return BUILTIN_LABELS[action] ?? action;
  const tool = KNOWN_CONNECTORS.find((c) => c.slug === m[1])?.tools.find((t) => t.name === m[2]);
  return tool?.actionNoun ?? m[2]!;
}

/** Kernel の判定 → 画面の結果（approve＝あなたの確認へ、deny・handoff＝統制が止めた、halt＝安全装置で止めた） */
export function activityOutcome(decision: string): StageActivityView["outcome"] {
  switch (decision) {
    case "allow":
      return "done";
    case "approve":
      return "approval";
    case "halt":
      return "halted";
    default:
      return "denied";
  }
}

/** どの担当も必ず通る手順。通ったときは「やったこと」に出さない（止まったときだけ出す） */
const ROUTINE = new Set(["submit_report", "finish"]);

/** タスクごとの「やったこと」（古い順） */
export function activityByTask(rows: readonly ToolActivityRow[]): Map<string, StageActivityView[]> {
  const out = new Map<string, StageActivityView[]>();
  for (const r of rows) {
    if (r.action !== null && ROUTINE.has(r.action) && r.decision === "allow") continue;
    const list = out.get(r.task_id) ?? [];
    list.push({ label: activityLabel(r.action), outcome: activityOutcome(r.decision), at: r.created_at.toISOString() });
    out.set(r.task_id, list);
  }
  return out;
}
