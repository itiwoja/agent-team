// Harness テンプレート（FR-029：rt:202「フェーズの並び・各フェーズのシステムプロンプト・使えるツール・出力の種類」）
// 汎用テンプレートの表は pol:322-327。ツールの上限は kernel-compose-classify.md の TEMPLATES と同じにする
// フェーズの文は本番で使う指示。障害を狙い撃ちした防御の文は入れない・弱めない（D-54、R-43。計測も同じ文を使う：15:144）

import type { LlmPhase, TaskContext, TemplateId, ToolName } from "./types.ts";
import { deepFreeze } from "./freeze.ts";

export interface TemplatePhase {
  /** 画面に出すフェーズの名前（phase_started の payload） */
  name: string;
  /** LLM Proxy の phase（Router がモデルを選ぶ）。日本語のフェーズとの対応は §8-7 の案 */
  llmPhase: LlmPhase;
  /** そのフェーズでの指示（buildSystemPrompt が「進め方」の区画の「いまは〇〇のフェーズです」の後に入れる） */
  systemPrompt: string;
}

export interface TemplateRuntime {
  id: TemplateId;
  phases: readonly TemplatePhase[];
  /** 付与で絞る前の上限（selectTaskTools が絞る） */
  tools: readonly ToolName[];
  /** LLM が mcp_call で呼べる分類 */
  mcpByLlm: "none" | "read" | "read_write";
  output: "report" | "notify" | "intent_and_report";
  /** 0-H の編成で使うか（§8-1。watcher は枠だけで、validateFormation の TEMPLATES_0H にない） */
  in0H: boolean;
}

/** 0-H の汎用テンプレート。researcher（受信箱係）・assistant（仕入れ係）・briefer（まとめ役。Should）、watcher は枠 */
export const TEMPLATE_RUNTIME_0H: Readonly<Record<TemplateId, TemplateRuntime>> = deepFreeze({
  // 調査 → 整理 → 要約（pol:324）
  researcher: {
    id: "researcher",
    phases: [
      {
        name: "調査",
        llmPhase: "investigate",
        systemPrompt:
          "依頼と仕事の指示、タスクの入力を読み、答えるのに必要な情報を、使えるツールで集めてください。" +
          "観点や言い方を変えて何度か調べ、大事な出典は中身を開いて確かめてください。" +
          "調べた内容と、その出どころ（URL やツールの名前）を控えておいてください。",
      },
      {
        name: "整理",
        llmPhase: "plan",
        systemPrompt:
          "集めた情報を、依頼に答える形に整理してください。" +
          "重なりを除き、確かめられたことと確かめられなかったことを分け、それぞれの出どころを対応づけてください。" +
          "足りない情報があれば、読み取りのツールで補ってかまいません。",
      },
      {
        name: "要約",
        llmPhase: "report",
        systemPrompt:
          "整理した内容をもとに報告を書き、submit_report で提出してください。" +
          "title は内容が分かる短い題名にし、body は結論を先に書き、要点だけを短い箇条書きにしてください。",
      },
    ],
    tools: ["web_search", "web_fetch", "mcp_call", "submit_report", "notify", "finish"],
    mcpByLlm: "read",
    output: "report",
    in0H: true,
  },
  // 収集 → 要約（短く）（pol:325）。まとめ役に使う（A-101）。まとめ役のツールは BR-72 で selectTaskTools が絞る
  briefer: {
    id: "briefer",
    phases: [
      {
        name: "収集",
        llmPhase: "investigate",
        systemPrompt:
          "依頼と仕事の指示、タスクの入力を読み、まとめるのに必要な情報を集めてください。" +
          "使えるツールがあれば使い、情報の出どころを控えておいてください。",
      },
      {
        name: "要約",
        llmPhase: "report",
        systemPrompt:
          "集めた内容を短くまとめ、submit_report で提出してください。担当どうしで重なる内容は1つにし、要点だけを、短い文で書いてください。",
      },
    ],
    tools: ["web_search", "web_fetch", "mcp_call", "submit_report", "notify", "finish"],
    mcpByLlm: "read",
    output: "report",
    in0H: true,
  },
  // 取得 → 前回と比較 → 変化があれば要約（pol:326）。書き込み系を持たない（BR-40）。10/14 から定期の見張りの依頼で使う
  watcher: {
    id: "watcher",
    phases: [
      {
        name: "取得",
        llmPhase: "investigate",
        systemPrompt: "仕事の指示にある対象を、読み取りのツールで取得してください。対象が決まっていなければ、まず調べて見張る先を見つけてください。",
      },
      {
        name: "比較",
        llmPhase: "plan",
        systemPrompt:
          "取得した内容を、タスクの入力にある前回の報告と比べ、利用者に伝えるべき変化があるかを判断してください。" +
          "前回の報告がないとき（初めての回）は、いまの状態を控えるだけにします。",
      },
      {
        name: "要約",
        llmPhase: "report",
        systemPrompt:
          "submit_report で報告してください。前回の報告があるときは changed に変化の有無（true / false）を入れます。" +
          "変化があれば、何がどう変わったかを先に書きます。変化がなければ、本文は「前回から変化はありません」と1〜2行で書きます。" +
          "初めての回は、いまの状態を短く書き、changed は付けません。",
      },
    ],
    tools: ["web_search", "web_fetch", "mcp_call", "notify", "submit_report", "finish"],
    mcpByLlm: "read",
    output: "notify",
    in0H: true,
  },
  // 実装（D-116）：作業場（サンドボックス）でファイルを書き、コマンドで動かして確かめる。外への書き込み（MCP）は持たない
  "dev-coder": {
    id: "dev-coder",
    phases: [
      {
        name: "計画",
        llmPhase: "plan",
        systemPrompt:
          "依頼と仕事の指示、タスクの入力を読み、作るものと確かめ方を決めてください。" +
          "list_files で作業場にあるもの（前回の成果・パックのスクリプト）を確かめ、要るなら read_file で読んでください。",
      },
      {
        name: "実装",
        llmPhase: "implement",
        systemPrompt:
          "write_file でファイルを書き、run_command で動かして確かめてください。失敗したら出力を読んで直し、動くまで繰り返してください。" +
          "テストや試しの実行で、依頼どおりに動くことを確かめてから次に進みます。" +
          "コマンドが「ここでは動かせません」と断られたら、同じことを繰り返さず、動かせなかったことと理由を報告に書いてください。",
      },
      {
        name: "報告",
        llmPhase: "report",
        systemPrompt:
          "submit_report で報告してください。作ったもの・確かめた結果（実行した結果の要点）・使い方を短く書き、作業場に作ったファイルの名前を挙げてください。" +
          "作業場のファイルは、利用者が画面からダウンロードできます。",
      },
    ],
    tools: ["list_files", "read_file", "search", "write_file", "delete_file", "run_command", "web_search", "web_fetch", "notify", "submit_report", "finish"],
    mcpByLlm: "none",
    output: "report",
    in0H: true,
  },
  // 見る係（D-116）：作業場のファイルを読み、テストを動かして確かめる。書き換えない
  reviewer: {
    id: "reviewer",
    phases: [
      {
        name: "確認",
        llmPhase: "review",
        systemPrompt:
          "作業場のファイルを list_files・read_file・search で読み、run_command でテストや実行を動かして、依頼どおりか・誤りや危ないところがないかを確かめてください。" +
          "コマンドが「ここでは動かせません」と断られたら、同じことを繰り返さず、動かせなかったことと理由を報告に書いてください。",
      },
      {
        name: "報告",
        llmPhase: "report",
        systemPrompt: "submit_report で、確かめたこと・見つけた問題（ファイルと行）・直し方の提案を短く報告してください。",
      },
    ],
    tools: ["list_files", "read_file", "search", "run_command", "web_search", "web_fetch", "notify", "submit_report", "finish"],
    mcpByLlm: "none",
    output: "report",
    in0H: true,
  },
  // 計画 → 実行（pol:327）。全体計画ではフェーズ1だが、0-H の仕入れ係に使う（§7 C-03）
  assistant: {
    id: "assistant",
    phases: [
      {
        name: "計画",
        llmPhase: "plan",
        systemPrompt:
          "依頼と仕事の指示、タスクの入力を読み、何をするかを決めてください。" +
          "必要な情報は読み取りのツールで確かめてください。" +
          "書き込み（送信・登録・発注など）が必要かどうかと、必要ならその内容を決めます。",
      },
      {
        name: "実行",
        llmPhase: "implement",
        systemPrompt:
          "計画に沿ってツールを呼んでください。結果を見て、足りなければ手を足してください。" +
          "終わったら submit_report で、したこと（提案した書き込みと、その status を含む）と、その理由を報告してください。",
      },
    ],
    tools: ["mcp_call", "web_search", "web_fetch", "notify", "submit_report", "finish"],
    mcpByLlm: "read_write",
    output: "intent_and_report",
    in0H: true,
  },
});

/** TaskContext.phases に入れる形（タスクごとに別の配列を返す） */
export function templatePhases(template: TemplateId): TaskContext["phases"] {
  return TEMPLATE_RUNTIME_0H[template].phases.map((p) => ({ ...p }));
}
