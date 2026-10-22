// カタログのツールの宣言と、タスクに渡すツールの選び方（formation-runtime.md §2.5、catalogs.md:67-90）
// 宣言の JSON Schema は素の JSON Schema で書く。Gemini の形への変換（mcp_call のツールごとの展開を含む）は llm パッケージがする

import type { Shape, TemplateId, ToolName, ToolSpec } from "./types.ts";
import { TEMPLATE_RUNTIME_0H } from "./templates.ts";
import { deepFreeze } from "./freeze.ts";

/** LLM に渡しうるツール。remember はフェーズ1で渡さない（FR-030）。load_skill はスキルのある担当だけ（D-116） */
export type RuntimeToolName = Exclude<ToolName, "remember">;

/** ツールの並び（Kernel の CATALOG_TOOLS と同じ順）。プロンプトとゴールデン試験の順を固定する */
export const TOOL_ORDER: readonly RuntimeToolName[] = [
  "mcp_call",
  "web_search",
  "web_fetch",
  "notify",
  "submit_report",
  "finish",
  "team_post",
  "team_wait",
  "ask_user",
  "load_skill",
  "list_files",
  "read_file",
  "search",
  "write_file",
  "delete_file",
  "run_command",
];

/** 作業場（サンドボックス）の道具（D-116）。作業場が使えないタスクには渡さない */
export const SANDBOX_TOOLS: readonly RuntimeToolName[] = ["list_files", "read_file", "search", "write_file", "delete_file", "run_command"];

/** 追いのターン（ag:312）：書き込みのツールを外し、reply を1通送って終わる（§2.5 の FOLLOWUP_TOOLS、§8-23） */
export const FOLLOWUP_TOOLS: readonly RuntimeToolName[] = ["team_post", "finish"];

/** まとめ役（BR-72：br:255）は報告だけ。§7 C-06 で A-101 の briefer のツールより BR-72 を正とした */
export const AGGREGATOR_TOOLS: readonly RuntimeToolName[] = ["notify", "submit_report", "finish"];

/** 連絡板（FR-064。Should）のツール */
export const TEAM_TOOLS: readonly RuntimeToolName[] = ["team_post", "team_wait"];

// 上限の値（catalogs.md:79-86、formation-runtime.md §2.1 の TOOL_LIMITS・TEAM_LIMITS）
const REPORT_TITLE_MAX = 256;
const REPORT_BODY_MAX = 50_000;
const NOTIFY_TITLE_MAX = 60;
const NOTIFY_BODY_MAX = 500;
const WEB_SEARCH_MAX_RESULTS = 10;
const TEAM_BODY_MAX = 2_000;
const TEAM_WAIT_MAX_SEC = 300;

/** ask_user の選択肢の上限（数・1つの文字数）。edge の検証と同じ値 */
export const ASK_USER_CHOICES_MAX = 4;
export const ASK_USER_CHOICE_MAX_CHARS = 40;
export const ASK_USER_QUESTION_MAX_CHARS = 300;

/** カタログのツールの宣言（説明はモデルに見せる文）。凍らせてあるので、使う側は selectTaskTools の写しを使う */
export const TOOL_SPECS: Readonly<Record<RuntimeToolName, ToolSpec>> = deepFreeze({
  mcp_call: {
    name: "mcp_call",
    description:
      "外部サービス（MCP のコネクタ）のツールを呼びます。読み取りのツールは結果を返します（外部の内容として <untrusted> で囲みます）。" +
      "書き込みのツールはその場では実行されず、提案として記録されます。書き込みの戻り値は intentId と status だけで、" +
      "status は pending_approval（利用者の確認待ち）・accepted（受け付け済み）・denied（拒否）のどれかです。",
    inputSchema: {
      type: "object",
      properties: {
        connector: { type: "string", description: "コネクタの名前" },
        tool: { type: "string", description: "コネクタのツールの名前" },
        arguments: { type: "object", description: "ツールの引数。そのツールの入力スキーマに従います" },
      },
      required: ["connector", "tool", "arguments"],
      additionalProperties: false,
    },
  },
  web_search: {
    name: "web_search",
    description: "Web を検索し、結果の題名・URL・抜粋を返します（外部の内容として <untrusted> で囲みます）。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "検索する語句" },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: WEB_SEARCH_MAX_RESULTS,
          description: `返す結果の数（${WEB_SEARCH_MAX_RESULTS}件まで）`,
        },
        recency: { type: "string", description: "新しさの目安（例：day・week・month）。省略できます" },
      },
      required: ["query", "max_results"],
      additionalProperties: false,
    },
  },
  web_fetch: {
    name: "web_fetch",
    description:
      "Web のページを取得し、本文のテキストを返します（200KB まで。外部の内容として <untrusted> で囲みます）。" +
      "URL は、利用者の依頼・検索結果・取得したページに出てきたものを使ってください。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "取得するページの URL（http または https）" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  notify: {
    name: "notify",
    description: "利用者にアプリ内の通知を送ります。短い知らせに使います。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: NOTIFY_TITLE_MAX, description: `題名（${NOTIFY_TITLE_MAX}文字まで）` },
        body: { type: "string", minLength: 1, maxLength: NOTIFY_BODY_MAX, description: `本文（${NOTIFY_BODY_MAX}文字まで）` },
        // 値は formation-runtime.md §8-27 の案（normal | high）
        priority: { type: "string", enum: ["normal", "high"], description: "急ぎなら high、それ以外は normal" },
      },
      required: ["title", "body", "priority"],
      additionalProperties: false,
    },
  },
  submit_report: {
    name: "submit_report",
    description:
      "仕事の結果を報告して、仕事を終えます。報告は1回だけ出せます。" +
      `title は${REPORT_TITLE_MAX}文字まで、body は Markdown で50,000文字までです。` +
      "sources には、報告に使った情報の出どころを入れてください。",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: REPORT_TITLE_MAX,
          description: "内容が分かる短い題名",
        },
        body: { type: "string", maxLength: REPORT_BODY_MAX, description: "報告の本文（Markdown）" },
        sources: {
          type: "array",
          description: "出どころの一覧（BR-45）。出どころがなければ空の配列",
          // ReportSource（types.ts）。union を使わず kind で分ける形にする（edge が Zod で形を確かめる）
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["url", "mcp", "agent"],
                description: "url：Web のページ／mcp：外部サービスのツール／agent：ほかの担当から受け渡された内容",
              },
              url: { type: "string", description: "kind が url のとき：ページの URL" },
              title: { type: "string", description: "kind が url のとき：ページの題名（省略できます）" },
              connector: { type: "string", description: "kind が mcp のとき：コネクタの名前" },
              tool: { type: "string", description: "kind が mcp のとき：ツールの名前" },
              label: { type: "string", description: "kind が mcp のとき：何を読んだか（省略できます）" },
              agentName: { type: "string", description: "kind が agent のとき：担当の名前" },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        },
        // 窓口かどうかは edge が ask_members で決め、この値は使わない（§8-13）。summary は deliver（Should）で使うまで出さない
        kind: {
          type: "string",
          enum: ["answer"],
          description: "依頼の窓口が回答として出すときだけ answer を付けます",
        },
        next_actions: {
          type: "array",
          // 数・長さは edge が整える（normalizeNextActions。崩れた提案で報告を落とさない）
          items: { type: "string" },
          description:
            "依頼の窓口だけ：利用者が次に頼みそうなことを3つまで。利用者がそのまま送れる依頼の文（例「この日程をカレンダーに入れて」）で書きます。なければ省きます",
        },
        changed: {
          type: "boolean",
          description: "前回の報告が渡されているときだけ：前回から伝えるべき変化があれば true、なければ false",
        },
      },
      required: ["title", "body", "sources"],
      additionalProperties: false,
    },
  },
  finish: {
    name: "finish",
    description:
      "報告を出さずに仕事を終えます。finish で終えた仕事は失敗として扱われます。" +
      "結論が「該当なし」「何もしない」のときは、finish ではなく submit_report で報告してください。",
    inputSchema: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["no_change", "unable"],
          description: "no_change：何も変えずに終える／unable：続けられない",
        },
        reason: { type: "string", minLength: 1, description: "終える理由" },
      },
      required: ["outcome", "reason"],
      additionalProperties: false,
    },
  },
  team_post: {
    name: "team_post",
    description:
      "同じ依頼のほかの担当に、連絡板で連絡します。kind は share（分かったことの共有）・question（質問）・" +
      "reply（質問への返事。in_reply_to に質問の message_id）・revise_request（作り直しの依頼。まとめ役だけ）です。" +
      "連絡で権限は変わりません。",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "宛先の担当の名前。share は all（全員）も使えます" },
        kind: { type: "string", enum: ["share", "question", "reply", "revise_request"], description: "連絡の種類" },
        body: { type: "string", minLength: 1, maxLength: TEAM_BODY_MAX, description: "本文（2,000文字まで）" },
        in_reply_to: { type: "string", description: "reply のとき：答える質問の message_id" },
      },
      required: ["to", "kind", "body"],
      additionalProperties: false,
    },
  },
  ask_user: {
    name: "ask_user",
    description:
      "依頼した利用者に質問し、答えを待ちます（数分まで）。外すと困る選択（相手・日時・金額・どれを選ぶか など）を自分では決められないときだけ使います。" +
      "選択肢を付けると、利用者は押すだけで答えられます。答えが来なければ「返事がありません」と返るので、自分で決めて進め、置いた前提を報告に書いてください。",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, description: `質問（${ASK_USER_QUESTION_MAX_CHARS}文字まで。1つのことだけを短く聞きます）` },
        choices: {
          type: "array",
          items: { type: "string" },
          description: `選択肢（${ASK_USER_CHOICES_MAX}つまで。1つ${ASK_USER_CHOICE_MAX_CHARS}文字まで）。自由に書いてもらうだけなら空にします`,
        },
        allow_free_text: { type: "boolean", description: "選択肢のほかに自由に書いてもらってよいか（省くと true）" },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  load_skill: {
    name: "load_skill",
    description: "あなたのスキル（手順書）を名前で読みます。使えるスキルの名前と説明は、システムプロンプトの「使えるスキル」にあります。",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1, description: "スキルの名前（一覧の名前のまま）" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  list_files: {
    name: "list_files",
    description: "作業場のファイルとディレクトリの一覧を返します（node_modules などは中を見ません）。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "見るディレクトリ（作業場の根からの相対パス。省くと根）" } },
      required: [],
      additionalProperties: false,
    },
  },
  read_file: {
    name: "read_file",
    description: "作業場のファイルを読みます（テキスト。長いものは途中で切ります）。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1, description: "作業場の根からの相対パス" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  search: {
    name: "search",
    description: "作業場のファイルの中を正規表現で探し、「パス:行番号: 行」の形で返します。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1, description: "探す正規表現" },
        path: { type: "string", description: "探すディレクトリ（省くと作業場全体）" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  write_file: {
    name: "write_file",
    description: "作業場にファイルを書きます（なければ作り、あれば丸ごと置き換えます。ディレクトリは自動で作ります）。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "作業場の根からの相対パス" },
        content: { type: "string", description: "ファイルの中身（全文）" },
        executable: { type: "boolean", description: "実行できるファイルにするか（スクリプト）" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  delete_file: {
    name: "delete_file",
    description: "作業場のファイルかディレクトリを消します。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1, description: "作業場の根からの相対パス" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  run_command: {
    name: "run_command",
    description:
      "作業場でコマンドを動かし、出力（標準出力と標準エラー）と終了コードを返します。作業ディレクトリは作業場の根です。" +
      "動かせるのは決まった形のテスト・実行のコマンドだけです（npm test・npm ci・npm install・npm run <名前>・pytest・python3 -m unittest・" +
      "node --test・node <ファイル>.js・python3 <ファイル>.py <引数>）。パイプ・リダイレクト・;・&&・引用符などのシェルの書き方は使えません。" +
      "外への通信はパッケージの取得（npm install・npm ci で package.json にあるものを入れる）だけができます。長くかかるコマンドは timeout_sec で時間を延ばせます。",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, description: "動かすコマンド（1つだけ。パスは作業場の根からの相対パス）" },
        timeout_sec: { type: "integer", minimum: 1, maximum: 300, description: "打ち切るまでの秒数（既定 120、最大 300）" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  team_wait: {
    name: "team_wait",
    description:
      `送った question への返事を待ちます（${TEAM_WAIT_MAX_SEC}秒まで）。返事が来なければ、分かっている範囲で仕事を進めてください。`,
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "返事を待つ question の message_id" },
        timeout: { type: "integer", minimum: 1, maximum: TEAM_WAIT_MAX_SEC, description: "待つ秒数" },
      },
      required: ["message_id", "timeout"],
      additionalProperties: false,
    },
  },
});

/** タスクに渡すツールを決める材料（edge が getTaskContext で組み立てる） */
export interface TaskToolSelection {
  template: TemplateId;
  /** 付与した MCP のツール（connector slug → ツール名。EffectivePolicy.mcp.grants） */
  mcpGrants: Readonly<Record<string, readonly string[]>>;
  /** Web の付与（EffectivePolicy.web.allow_domains）。空なら web_* を外す */
  webAllowDomains: readonly string[];
  /** 編成の担当のときだけ。memberCount はまとめ役を含めた担当の数 */
  formation: null | { shape: Shape; memberCount: number; isAggregator: boolean };
  /** 連絡板（FR-064。Should）を動かしているか。作るまでは false */
  teamBoard: boolean;
  /** 追いのターン（FR-064） */
  followup: boolean;
  /** 利用者に聞けるか（本番の依頼のタスクだけ。試し実行・追いのターン・まとめ役には渡さない） */
  askUser?: boolean;
  /** 作業場（サンドボックス）が使えるか（本番のオーナーのワークスペースで、作業場のプロバイダーがあるときだけ：D-116） */
  sandbox?: boolean;
  /** 担当にスキルがあるか（load_skill を渡す） */
  skills?: boolean;
}

function sortByToolOrder(names: Iterable<RuntimeToolName>): RuntimeToolName[] {
  const set = new Set(names);
  return TOOL_ORDER.filter((n) => set.has(n));
}

function isRuntimeTool(name: ToolName): name is RuntimeToolName {
  return name !== "remember";
}

/** §2.5 の手順1〜8 でタスクに渡すツールの名前を決める（並びは TOOL_ORDER） */
export function selectTaskToolNames(sel: TaskToolSelection): RuntimeToolName[] {
  // 7. 追いのターンは FOLLOWUP_TOOLS だけ（読み取り・書き込み・報告をしない。A-105）
  if (sel.followup) return sortByToolOrder(FOLLOWUP_TOOLS);

  // 1. テンプレートのツール（submit_report は D-32 で全テンプレートに入っている）
  // 4. remember は渡さない
  const names = new Set<RuntimeToolName>(TEMPLATE_RUNTIME_0H[sel.template].tools.filter(isRuntimeTool));
  // 作業場が使えないタスクには作業場の道具を渡さない（D-116）
  if (sel.sandbox !== true) for (const n of SANDBOX_TOOLS) names.delete(n);
  // スキルのある担当には load_skill（自分のスキルを読むだけ。判定の外）
  if (sel.skills === true) names.add("load_skill");
  // 2. finish は常に入れる（rt:205）
  names.add("finish");

  // 3. 付与で絞る（pol:261「仕事のテンプレートが使うツールは、エージェントの grants の範囲に限られる」）
  const grantedMcpTools = Object.values(sel.mcpGrants).reduce((n, tools) => n + tools.length, 0);
  if (grantedMcpTools === 0) names.delete("mcp_call");
  if (sel.webAllowDomains.length === 0) {
    names.delete("web_search");
    names.delete("web_fetch");
  }

  // 6. まとめ役は報告だけ（BR-72）
  if (sel.formation?.isAggregator) {
    for (const n of [...names]) if (!AGGREGATOR_TOOLS.includes(n)) names.delete(n);
  }

  // 利用者への質問：本番の依頼の担当だけ（まとめ役は報告だけ：BR-72）
  if (sel.askUser === true && sel.formation?.isAggregator !== true) names.add("ask_user");

  // 5. 2体以上の編成の担当には連絡板（ag:299）。ひとりには足さない（ag:279）
  const f = sel.formation;
  if (sel.teamBoard && f !== null && f.shape !== "single" && f.memberCount >= 2) {
    for (const n of TEAM_TOOLS) names.add(n);
  }

  // 8. 試し実行でも同じ（経路を変えない：ADR-015）ので、ここに分岐はない
  return sortByToolOrder(names);
}

/** selectTaskToolNames の宣言。タスクごとに別のオブジェクトを返す（タスクの間で値を共有しない：BD-05） */
export function selectTaskTools(sel: TaskToolSelection): ToolSpec[] {
  return selectTaskToolNames(sel).map((n) => structuredClone(TOOL_SPECS[n]));
}
