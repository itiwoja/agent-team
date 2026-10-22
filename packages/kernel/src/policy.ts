// ポリシーの形（KC §2.2〜2.5）：Hard Ceiling・ワークスペースのポリシー・エージェント定義 v2・操作カタログ・テンプレート
// compose()（compose.ts）・classify()（classify.ts）の入力。保存の前に validateAgentDefinition（Zod v4）で検証し、
// normalizeAgentDefinition で正規化する（KC §3.1）。Rule・Guard・ToolInfo の形は types.ts が正（M-02・M-03）
// 純粋：I/O・時刻・乱数を使わない

import { z } from "zod";
import { argRoleAt, normalizeForMatch, parseArgPath } from "./args.ts";
import { CATALOG_TOOLS, OPERATION_TYPES } from "./types.ts";
import type { ArgPath, AutonomyLevel, CatalogToolName, Guard, Json, OperationType, Rule, ToolInfo } from "./types.ts";

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 重複を除いて UTF-16 のコード単位の昇順（KC §3.1-3） */
function uniqueSorted(list: Iterable<string>): string[] {
  return [...new Set(list)].sort(compareText);
}

/** 共有の定数を書き換えられないようにする（Hard Ceiling を実行中に緩められない） */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// ---- 自律度（KC §2.1・§3.2） ----

/** 厳しさの昇順 */
export const AUTONOMY_LEVELS = ["auto", "approve", "handoff", "deny"] as const satisfies readonly AutonomyLevel[];

/** 厳しさ（大きいほど厳しい）。deny > handoff > approve > auto（handoff の位置は Q-29 で未決。KC §8 #1） */
export const AUTONOMY_STRICTNESS: Readonly<Record<AutonomyLevel, number>> = deepFreeze({ auto: 0, approve: 1, handoff: 2, deny: 3 });

export function isAutonomyLevel(v: unknown): v is AutonomyLevel {
  return typeof v === "string" && Object.hasOwn(AUTONOMY_STRICTNESS, v);
}

/** 厳しい方（KC §3.2 の stricter） */
export function stricterAutonomy(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return AUTONOMY_STRICTNESS[a] >= AUTONOMY_STRICTNESS[b] ? a : b;
}

// ---- Hard Ceiling（BR-06・KC §2.2） ----

/** Hard Ceiling の版（M-59：コードの定数。PLATFORM_CEILINGS の環境変数での上書きは 0-H では作らない。KC §8 #26） */
// 2026-10-14.1：run_shell（SG-07。書ける値は approve・deny）を足した。実効ポリシーに autonomy.run_shell が入り、policyHash が変わる
export const CEILINGS_VERSION = "2026-10-14.1";

export interface Ceilings {
  /** ceilings_version。スナップショットに残す（NFR-036） */
  version: string;
  /** 操作ごとに「ポリシー・定義に書ける値」。deny はどの操作でも書ける（KC §8 #2） */
  autonomy: Readonly<Record<OperationType, readonly AutonomyLevel[]>>;
  budget: { per_task_usd: number; per_day_usd: number; max_steps: number; max_minutes: number };
  breakers: { same_action_repeat: number; denied_attempts_max: number; step_cost_usd_max: number };
  max_intents_per_task: number;
  max_runs_per_day: number;
  max_fetches_per_task: number;
  /** 常に拒否するドメイン（実体の私的アドレスの判定は Web 取得プロキシ。ADR-023） */
  web_always_deny: readonly string[];
  /** watcher は書き込みを持たない（BR-40）。compose がテンプレートの指定にかかわらず llmWrite・deliverWrite を false にする */
  watcherNoWrite: true;
}

export const DEFAULT_CEILINGS: Ceilings = deepFreeze({
  version: CEILINGS_VERSION,
  autonomy: {
    read: ["auto", "deny"], // サンドボックス内の操作は auto か deny（BR-06）
    edit_code: ["auto", "deny"],
    run_tests: ["auto", "deny"],
    // 作業場の任意のコマンド（SG-07）。auto には書けない：形の許可リストにない・汚染のあとのコマンドを人の確認なしで動かさない
    run_shell: ["approve", "deny"],
    shell_network: ["deny"], // 常に deny（BR-06）
    open_pr: ["approve", "auto", "deny"], // auto は必ずドラフト（BR-06）
    merge: ["deny"], // 常に deny（BR-06）
    memory_write: ["auto", "deny"],
    web_read: ["auto", "deny"],
    mcp_read: ["auto", "approve", "deny"],
    mcp_write: ["approve", "handoff", "deny"], // auto はルール経由だけ。ポリシーには書けない（KC §7 C-16）
    notify: ["auto", "deny"],
    payment: ["handoff", "deny"], // handoff のみ（BR-36）＋ deny
  },
  // per_task_usd・max_steps は BR-06、per_day_usd 200 は policy.yaml の範囲の上端。
  // max_minutes は BR-06 の 60 ではなく 55（M-59：外側の60分の打ち切りと同時に切れると halted(timeout) が記録されない）
  budget: { per_task_usd: 20, per_day_usd: 200, max_steps: 200, max_minutes: 55 },
  breakers: { same_action_repeat: 20, denied_attempts_max: 20, step_cost_usd_max: 5 }, // policy.yaml の範囲の上端
  max_intents_per_task: 20, // A-85
  max_runs_per_day: 50, // A-37
  max_fetches_per_task: 30, // A-77
  web_always_deny: ["*.internal", "localhost"],
  watcherNoWrite: true,
});

/** その操作に書ける値（Hard Ceiling ∪ deny）。厳しさの昇順 */
export function writableAutonomy(op: OperationType, ceilings: Ceilings): AutonomyLevel[] {
  const listed = Object.hasOwn(ceilings.autonomy, op) ? ceilings.autonomy[op] : undefined;
  return AUTONOMY_LEVELS.filter((l) => l === "deny" || (Array.isArray(listed) && listed.includes(l)));
}

/**
 * 自律度を Hard Ceiling に切り詰める（KC §3.2）。書ける値ならそのまま、そうでなければ書ける値のうち
 * より厳しい中で最も緩いもの（deny は常に書けるので必ず見つかる）。知らない値は deny（判定できないなら許可しない）
 * 例：mcp_write auto → approve、web_read approve → deny、mcp_read handoff → deny
 */
export function clampAutonomyToCeiling(level: unknown, op: OperationType, ceilings: Ceilings): AutonomyLevel {
  if (!isAutonomyLevel(level)) return "deny";
  const allowed = writableAutonomy(op, ceilings);
  if (allowed.includes(level)) return level;
  return allowed.find((x) => AUTONOMY_STRICTNESS[x] > AUTONOMY_STRICTNESS[level]) ?? "deny";
}

// ---- 操作カタログ（catalogs.md:47-61） ----

/** ワークスペースのポリシーが省略した操作の既定値（catalogs.md の「既定値」列） */
export const CATALOG_DEFAULT_AUTONOMY: Readonly<Record<OperationType, AutonomyLevel>> = deepFreeze({
  read: "auto",
  edit_code: "auto",
  run_tests: "auto",
  // SG-07：既定は deny（厳しい側）。approve にしても、いまは MCP の書き込み以外を人の確認に回す経路（Intent・承認の行）がなく、
  // runner は書き込みでない approve を実行しない（runner/harness.ts）ので、承認カードは出ずに断るだけになる
  run_shell: "deny",
  shell_network: "deny",
  open_pr: "approve",
  merge: "deny",
  memory_write: "auto",
  web_read: "auto",
  mcp_read: "auto",
  mcp_write: "approve",
  notify: "auto",
  payment: "handoff",
});

/** ワークスペースのポリシーに breakers がないときの値（KC §8 #20。policy.yaml の例。F-07 を止めるのに要る） */
export const DEFAULT_BREAKERS: Readonly<Ceilings["breakers"]> = deepFreeze({
  same_action_repeat: 5,
  denied_attempts_max: 3,
  step_cost_usd_max: 0.5,
});

/** ワークスペースのポリシーに max_intents_per_task がないときの値（A-85） */
export const DEFAULT_MAX_INTENTS_PER_TASK = 5;

/** 'mcp.<connector>.<tool>'。connector は '.' を含まず、tool は残り全部（KC §8 #7。decide の手順4-5と同じ読み方） */
export function parseMcpAction(action: string): { connector: string; tool: string } | null {
  if (typeof action !== "string" || !action.startsWith("mcp.")) return null;
  const rest = action.slice(4);
  const i = rest.indexOf(".");
  if (i <= 0 || i === rest.length - 1) return null;
  return { connector: rest.slice(0, i), tool: rest.slice(i + 1) };
}

// ---- テンプレート（policy-and-schema.md:322-334、D-32、FR-029。KC §2.5） ----

export const TEMPLATE_NAMES = ["researcher", "briefer", "watcher", "assistant", "dev-coder", "reviewer", "triager"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];
/** 0-H の仕事に書けるテンプレート（汎用の4つ。開発3つはフェーズ1でスキーマが拒否：KC §6.3 C-49） */
export const GENERAL_TEMPLATE_NAMES = ["researcher", "briefer", "watcher", "assistant", "dev-coder", "reviewer"] as const satisfies readonly TemplateName[];

export interface TemplateSpec {
  name: TemplateName;
  /** LLM に渡すツールの上限（実際は付与で絞る：KC §3.3 J1） */
  tools: readonly CatalogToolName[];
  /** LLM が mcp_call で呼べる分類 */
  mcpLlm: "none" | "read" | "read_write";
  /** 仕事の deliver で MCP の書き込みを置けるか */
  mcpDeliverWrite: boolean;
  /** 全体計画のフェーズ（FR-029）。assistant は 1 だが 0-H でも使う（KC §7 C-6）。0-H で選べるかは GENERAL_TEMPLATE_NAMES */
  phase: 0 | 1;
}

/** remember・load_skill は 0-H のどのテンプレートにも入れない（メモリ・Skill はフェーズ1：KC §7 C-20） */
export const TEMPLATES: Readonly<Record<TemplateName, TemplateSpec>> = deepFreeze({
  researcher: {
    name: "researcher",
    tools: ["web_search", "web_fetch", "mcp_call", "submit_report", "notify", "finish"],
    mcpLlm: "read", // mcp_call は読み取りのみ
    mcpDeliverWrite: true,
    phase: 0,
  },
  briefer: {
    name: "briefer",
    tools: ["web_search", "web_fetch", "mcp_call", "submit_report", "notify", "finish"],
    mcpLlm: "read",
    mcpDeliverWrite: true,
    phase: 0,
  },
  // 書き込み系を持たない（BR-40 Hard Ceiling）。submit_report は D-32 で追加
  watcher: {
    name: "watcher",
    // web_search は読み取り（見張る先を探す・ニュースの変化を見る）。書き込み系は持たない
    tools: ["web_search", "web_fetch", "mcp_call", "notify", "submit_report", "finish"],
    mcpLlm: "read",
    mcpDeliverWrite: false,
    phase: 0,
  },
  // 読み書きすべての MCP（書き込みは Intent）。0-H の仕入れ係は LLM が数量を決めて place_order を呼ぶ（KC §8 #6）
  assistant: {
    name: "assistant",
    tools: ["mcp_call", "web_search", "web_fetch", "notify", "submit_report", "finish"],
    mcpLlm: "read_write",
    mcpDeliverWrite: true,
    phase: 1,
  },
  // 実装（10/14・D-116）：作業場（サンドボックス）のファイルを読み書きし、コマンドを動かす。外への書き込み（MCP）は持たない
  "dev-coder": {
    name: "dev-coder",
    tools: ["list_files", "read_file", "search", "write_file", "delete_file", "run_command", "web_search", "web_fetch", "notify", "submit_report", "finish"],
    mcpLlm: "none",
    mcpDeliverWrite: false,
    phase: 1,
  },
  // 見る係：作業場のファイルを読み、テストを動かす。書き換えない
  reviewer: {
    name: "reviewer",
    tools: ["list_files", "read_file", "search", "run_command", "web_search", "web_fetch", "notify", "submit_report", "finish"],
    mcpLlm: "none",
    mcpDeliverWrite: false,
    phase: 1,
  },
  triager: { name: "triager", tools: [], mcpLlm: "none", mcpDeliverWrite: false, phase: 1 },
});

// ---- ワークスペースのポリシー（ADR-021・TBL-026。KC §2.3） ----

export interface WorkspacePolicy {
  version: 1;
  /** 省略したキーはカタログの既定。Hard Ceiling を超える値は compose が切り詰める（NFR-056） */
  autonomy: Readonly<Partial<Record<OperationType, AutonomyLevel>>>;
  budget: { per_task_usd: number; per_day_usd: number; max_steps: number; max_minutes: number };
  /** 省略は DEFAULT_BREAKERS */
  breakers?: { same_action_repeat?: number; denied_attempts_max?: number; step_cost_usd_max?: number };
  web: { deny_domains: readonly string[]; max_fetches_per_task: number };
  /** 有効なコネクタの slug。付与はこの部分集合（BR-20） */
  connectors: { enabled: readonly string[] };
  /** false なら [以後も許可] を出さず既存のルールも効かない（mcp-and-web.md:125） */
  rules: { enabled: boolean; max_per_agent: number };
  /** 空＝BR-14 の既定（依頼者本人と owner）。0-H は単一ユーザーで空 */
  approvers: readonly string[];
  /** 省略は 5（A-85）。定義には書けない（KC §7 C-23） */
  max_intents_per_task?: number;
}

const levelSchema = z.enum(AUTONOMY_LEVELS);
const nonNegative = z.number().nonnegative();
const nonNegativeInt = z.int().nonnegative();

/**
 * ワークスペースのポリシーの形だけを見る（Hard Ceiling を超える値の拒否は未設計：Q-30。compose が切り詰める）。
 * 0-H は固定の値を投入するだけで編集の画面はない
 */
export const workspacePolicySchema = z.strictObject({
  version: z.literal(1),
  autonomy: z.strictObject({
    read: levelSchema.optional(),
    edit_code: levelSchema.optional(),
    run_tests: levelSchema.optional(),
    run_shell: levelSchema.optional(),
    shell_network: levelSchema.optional(),
    open_pr: levelSchema.optional(),
    merge: levelSchema.optional(),
    memory_write: levelSchema.optional(),
    web_read: levelSchema,
    mcp_read: levelSchema,
    mcp_write: levelSchema,
    notify: levelSchema,
    payment: levelSchema.optional(),
  }),
  budget: z.strictObject({ per_task_usd: nonNegative, per_day_usd: nonNegative, max_steps: nonNegativeInt, max_minutes: nonNegativeInt }),
  breakers: z
    .strictObject({
      same_action_repeat: nonNegativeInt.optional(),
      denied_attempts_max: nonNegativeInt.optional(),
      step_cost_usd_max: nonNegative.optional(),
    })
    .optional(),
  web: z.strictObject({ deny_domains: z.array(z.string().min(1)), max_fetches_per_task: nonNegativeInt }),
  connectors: z.strictObject({ enabled: z.array(z.string().min(1)) }),
  rules: z.strictObject({ enabled: z.boolean(), max_per_agent: nonNegativeInt }),
  approvers: z.array(z.string().min(1)),
  max_intents_per_task: nonNegativeInt.optional(),
});

/** 日の区切り（per_day_usd の「当日」）。すべてのワークスペース（オーナーも）を Asia/Tokyo で作る（M-59） */
export const DAY_BOUNDARY_TIMEZONE = "Asia/Tokyo";

/**
 * 0-H で投入するワークスペースのポリシー（KC §2.3。例の値は policy-and-schema.md:43-65）。
 * オーナーとゲストの差は per_day_usd だけ（オーナー 10：M-59、ゲスト 4：BR-62・D-105・D-106。edge のゲスト1日 $4 と同じ値）。
 * ゲストの Web は BR-64 で gateway・edge が別に拒否するのでここは変えない。全体 $15 は compose の外（M-19・D-104・D-106）
 */
export function defaultWorkspacePolicy(
  kind: "owner" | "guest",
  enabledConnectors: readonly string[] = [],
): WorkspacePolicy {
  return {
    version: 1,
    autonomy: { web_read: "auto", notify: "auto", mcp_read: "auto", mcp_write: "approve", open_pr: "approve", memory_write: "auto" },
    budget: { per_task_usd: 0.5, per_day_usd: kind === "owner" ? 10 : 4, max_steps: 40, max_minutes: 15 },
    breakers: { ...DEFAULT_BREAKERS },
    web: { deny_domains: ["*.internal", "localhost"], max_fetches_per_task: 30 },
    connectors: { enabled: uniqueSorted(enabledConnectors.map((c) => c.trim())) },
    rules: { enabled: true, max_per_agent: 20 },
    approvers: [],
    max_intents_per_task: DEFAULT_MAX_INTENTS_PER_TASK,
  };
}

// ---- エージェント定義 v2（ADR-028、policy-and-schema.md:212-261。KC §2.4） ----

/** 推測した役割（A-83）。権限に影響しない（BR-48） */
export const AGENT_ROLES = ["research", "watch", "brief", "assist", "dev"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** 順番・まとめの定期実行は編成（asks）が持つので、担当の仕事は null（KC §2.4）。最短間隔は1時間（BR-25） */
export type JobTrigger =
  | { type: "manual" }
  | { type: "schedule"; cron: string; timezone: string }
  | { type: "watch"; interval: string; targets: readonly string[] };

/** 届け先（BR-58）。宛先は定義が決め、LLM は中身だけ。to は 'notify' か 'mcp.<connector>.<tool>' */
export interface JobDeliver {
  to: string;
  /** destination と option（定義で固定） */
  args?: Readonly<Record<ArgPath, Json>>;
  /** content の引数。使える変数は report.title / summary / body / sources_markdown だけ（mcp-and-web.md:176） */
  content?: Readonly<Record<ArgPath, string>>;
}

export interface AgentJobInput {
  /** slug。^[a-z0-9-]{2,40}$、エージェントの中で一意 */
  id: string;
  kind: "once" | "recurring" | "watch";
  template: TemplateName;
  instructions: string;
  /** 自己調整の欄（BR-52） */
  tuning?: string;
  trigger?: JobTrigger | null;
  deliver?: readonly JobDeliver[];
  /** job_guards（D-57）。正本はここ（KC §7 C-13） */
  guards?: readonly Guard[];
  notify?: { quiet_if_normal?: boolean };
}
export interface AgentJob extends AgentJobInput {
  trigger: JobTrigger | null;
  deliver: readonly JobDeliver[];
  guards: readonly Guard[];
}

/** 保存されている形のルール（free の欠けは []：M-03） */
export type RuleInput = Omit<Rule, "free"> & { free?: readonly ArgPath[] };

export interface AgentGrants {
  /** ['*'] はワークスペースの範囲内すべて。省略＝Web を付与しない（KC §8 #22） */
  web?: { allow_domains: readonly string[] };
  /** connector slug → 付与する MCP ツール（読み取りも書き込みも） */
  connectors: Readonly<Record<string, { grant: readonly string[] }>>;
}

/** compose・classify が受け取る形（DB の jsonb のままでよい。入口で正規化する） */
export interface AgentDefinitionInput {
  version: 2;
  name: string;
  role?: AgentRole | null;
  appearance?: { icon?: string; color?: string };
  grants?: { web?: { allow_domains: readonly string[] }; connectors?: Readonly<Record<string, { grant: readonly string[] }>> };
  /** 省略したキーはワークスペースのポリシーを引き継ぐ */
  autonomy?: Readonly<Partial<Record<OperationType, AutonomyLevel>>>;
  /** 「以後も許可」。承認カードからだけ足す（BR-57） */
  rules?: readonly RuleInput[];
  budget?: { per_task_usd?: number; per_day_usd?: number; max_steps?: number; max_minutes?: number };
  breakers?: { same_action_repeat?: number; denied_attempts_max?: number; step_cost_usd_max?: number };
  /** 1〜50。全トリガーの合計。省略は 10（最初の境界） */
  max_runs_per_day?: number;
  /** 公開するプロフィールの項目（BR-41・50） */
  profile?: readonly string[];
  /** 0-H は Won't */
  memory?: { enabled: boolean; max_items: number };
  /** 0-H は Won't（単一ユーザー） */
  approvers?: readonly string[];
  /** 0〜10 */
  jobs?: readonly AgentJobInput[];
}

/** 正規化した定義（KC §3.1）。欠けたキーを埋め、集合は重複なしの昇順、仕事とルールは id の昇順 */
export interface AgentDefinition {
  version: 2;
  name: string;
  role: AgentRole | null;
  appearance?: { icon?: string; color?: string };
  grants: AgentGrants;
  autonomy: Readonly<Partial<Record<OperationType, AutonomyLevel>>>;
  rules: readonly Rule[];
  budget: { per_task_usd?: number; per_day_usd?: number; max_steps?: number; max_minutes?: number };
  breakers?: { same_action_repeat?: number; denied_attempts_max?: number; step_cost_usd_max?: number };
  max_runs_per_day: number;
  profile: readonly string[];
  memory?: { enabled: boolean; max_items: number };
  approvers?: readonly string[];
  jobs: readonly AgentJob[];
}

/**
 * 最初の境界（agents.md:61-70、A-79）。ワークスペースのポリシーより低い場合はそちらに合わせる（initialAgentDefinition）。
 * guest_per_day_usd：ゲストのワークスペースで作る担当の1日（D-105・D-106）。ゲストのワークスペースの1日（4）と同じ。オーナーは budget.per_day_usd（1）のまま
 */
export const INITIAL_AGENT_BOUNDARY = deepFreeze({
  autonomy: { web_read: "auto", memory_write: "auto" } satisfies Partial<Record<OperationType, AutonomyLevel>>,
  budget: { per_task_usd: 0.2, per_day_usd: 1 },
  guest_per_day_usd: 4,
  max_runs_per_day: 10,
});

function normalizeGuard(g: Guard): Guard {
  const out: Guard = { ...g };
  if (Array.isArray(g.in)) out.in = uniqueSorted(g.in.map((c) => (typeof c === "string" ? c.trim() : c)));
  return out;
}

function normalizeRule(r: RuleInput): Rule {
  const match = r.match !== null && typeof r.match === "object" ? r.match : {};
  return {
    ...r,
    // 文字列は前後の空白を除き、配列は並べ替えるが重複は残す（M-09）
    match: Object.fromEntries(Object.entries(match).map(([k, v]) => [k, normalizeForMatch(v)])),
    free: uniqueSorted(Array.isArray(r.free) ? r.free : []),
  };
}

function normalizeDomains(list: readonly string[]): string[] {
  return uniqueSorted(list.map((d) => d.trim().toLowerCase()).filter((d) => d !== ""));
}

/**
 * 定義の正規化（KC §3.1。保存の前と compose の入口で1回）。入力は変えず、写しを返す。
 * - 前後の空白を除く：ルールの match の値・ガードの in・コネクタ名・ツール名・ドメイン（ドメインは小文字にも）
 * - 集合は重複を除いて昇順：grant・allow_domains・profile・approvers・ルールの free・ガードの in。
 *   ルールの match の配列は並べ替えるが重複は除かない（M-09：多重集合）
 * - grant が空のコネクタは消す。欠けたキーを埋める（rules・profile・jobs・deliver・guards・trigger・max_runs_per_day 10）
 * - 仕事とルールは id の昇順
 * version 2 以外は例外（v1 の読み替えは 0-H では作らない）
 */
export function normalizeAgentDefinition(input: AgentDefinitionInput): AgentDefinition {
  if (input === null || typeof input !== "object" || input.version !== 2) {
    throw new TypeError("normalizeAgentDefinition: version 2 の定義だけ扱える");
  }
  const def = structuredClone(input);
  const connectors = new Map<string, string[]>();
  for (const [rawName, g] of Object.entries(def.grants?.connectors ?? {})) {
    const name = rawName.trim();
    const tools = (Array.isArray(g?.grant) ? g.grant : []).map((t) => t.trim()).filter((t) => t !== "");
    connectors.set(name, uniqueSorted([...(connectors.get(name) ?? []), ...tools]));
  }
  const grants: AgentGrants = {
    connectors: Object.fromEntries(
      [...connectors.entries()]
        .filter(([name, tools]) => name !== "" && tools.length > 0)
        .sort((a, b) => compareText(a[0], b[0]))
        .map(([name, tools]) => [name, { grant: tools }]),
    ),
  };
  if (def.grants?.web !== undefined) grants.web = { allow_domains: normalizeDomains(def.grants.web.allow_domains ?? []) };

  const autonomy: Partial<Record<OperationType, AutonomyLevel>> = {};
  for (const op of OPERATION_TYPES) {
    const v = def.autonomy !== undefined && Object.hasOwn(def.autonomy, op) ? def.autonomy[op] : undefined;
    if (v !== undefined) autonomy[op] = v;
  }

  const jobs: AgentJob[] = (def.jobs ?? []).map((j) => ({
    ...j,
    trigger: j.trigger ?? null,
    deliver: j.deliver ?? [],
    guards: (j.guards ?? []).map(normalizeGuard),
  }));
  jobs.sort((a, b) => compareText(a.id, b.id));
  const rules = (def.rules ?? []).map(normalizeRule);
  rules.sort((a, b) => compareText(a.id, b.id));

  const out: AgentDefinition = {
    version: 2,
    name: def.name,
    role: def.role ?? null,
    grants,
    autonomy,
    rules,
    budget: { ...def.budget },
    max_runs_per_day: def.max_runs_per_day ?? INITIAL_AGENT_BOUNDARY.max_runs_per_day,
    profile: uniqueSorted(def.profile ?? []),
    jobs,
  };
  if (def.appearance !== undefined) out.appearance = def.appearance;
  if (def.breakers !== undefined) out.breakers = def.breakers;
  if (def.memory !== undefined) out.memory = def.memory;
  if (def.approvers !== undefined) out.approvers = uniqueSorted(def.approvers);
  return out;
}

/**
 * 新しく作るエージェントの最初の境界（agents.md:61-70、API-060。BR-74：編成で作る担当もここから）。
 * 各値は min(初期値, ワークスペースの値)、自律度は厳しい方（A-79）。1日の初期値はゲスト 2・オーナー 1（D-105）。notify・submit_report はテンプレートの組み込み。
 * Web の付与はオーナーだけ ['*']（ゲストは BR-64 で使えないので「できること」に出さない：KC §8 #22）
 */
export function initialAgentDefinition(input: {
  name: string;
  role?: AgentRole | null;
  workspacePolicy: WorkspacePolicy;
  workspaceKind: "owner" | "guest";
  ceilings?: Ceilings;
}): AgentDefinition {
  const ceilings = input.ceilings ?? DEFAULT_CEILINGS;
  const ws = input.workspacePolicy;
  const wsLevel = (op: OperationType) => clampAutonomyToCeiling(ws.autonomy[op] ?? CATALOG_DEFAULT_AUTONOMY[op], op, ceilings);
  const ib = INITIAL_AGENT_BOUNDARY;
  return normalizeAgentDefinition({
    version: 2,
    name: input.name,
    role: input.role ?? null,
    grants: { ...(input.workspaceKind === "owner" ? { web: { allow_domains: ["*"] } } : {}), connectors: {} },
    autonomy: {
      web_read: stricterAutonomy(ib.autonomy.web_read, wsLevel("web_read")),
      memory_write: stricterAutonomy(ib.autonomy.memory_write, wsLevel("memory_write")),
    },
    rules: [],
    budget: {
      per_task_usd: Math.min(ib.budget.per_task_usd, ws.budget.per_task_usd, ceilings.budget.per_task_usd),
      per_day_usd: Math.min(input.workspaceKind === "guest" ? ib.guest_per_day_usd : ib.budget.per_day_usd, ws.budget.per_day_usd, ceilings.budget.per_day_usd),
    },
    max_runs_per_day: Math.min(ib.max_runs_per_day, ceilings.max_runs_per_day),
    profile: [],
    jobs: [],
  });
}

// ---- 定義の検証（FR-022 の AGENT_SCHEMA_INVALID。KC §2.2 の範囲・§4・§8 #10・#27・#28・#29） ----

/** コネクタの slug（KC §8 #7：点を含まない） */
const CONNECTOR_SLUG = /^[a-z0-9-]+$/;
const JOB_SLUG = /^[a-z0-9-]{2,40}$/;
/** content に使える変数（mcp-and-web.md:176） */
const REPORT_VARIABLES: ReadonlySet<string> = new Set(["report.title", "report.summary", "report.body", "report.sources_markdown"]);

/** コード単位ではなく文字（コードポイント）で数える */
function charCount(s: string): number {
  return [...s].length;
}

/** cron のフィールド1つを値の集合に展開する（'*'・'a'・'a-b'・'*\/n'・'a-b/n'・','）。読めなければ null */
function expandCronField(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (m === null) return null;
    const [, range, stepText] = m;
    const step = stepText === undefined ? 1 : Number(stepText);
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range!.split("-");
      lo = Number(a);
      hi = b === undefined ? (stepText === undefined ? lo : max) : Number(b);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || step < 1 || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? [...out].sort((a, b) => a - b) : null;
}

/** 日・月・曜日のフィールド（数字・名前・'*'・'/'・'-'・','）。中身の範囲までは見ない */
const CRON_DAY_FIELD = /^[0-9A-Za-z*,/-]+$/;

/** 5つのフィールドの cron の分と時（分 時 日 月 曜日）。読めなければ null */
export function parseCronSchedule(cron: string): { minutes: number[]; hours: number[] } | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (![dom, month, dow].every((f) => CRON_DAY_FIELD.test(f))) return null;
  const minutes = expandCronField(minute, 0, 59);
  const hours = expandCronField(hour, 0, 23);
  return minutes === null || hours === null ? null : { minutes, hours };
}

/** 見張りの間隔（'30m'・'1h'・'1d'）を分に。読めなければ null */
export function parseWatchIntervalMinutes(interval: string): number | null {
  const m = /^(\d+)(m|h|d)$/.exec(interval.trim());
  if (m === null) return null;
  const n = Number(m[1]);
  const minutes = m[2] === "m" ? n : m[2] === "h" ? n * 60 : n * 1440;
  return minutes > 0 ? minutes : null;
}

function isIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function usesOnlyReportVariables(text: string): boolean {
  for (const m of text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) if (!REPORT_VARIABLES.has(m[1] ?? "")) return false;
  return true;
}

const argPathKey = z.string().refine((p) => parseArgPath(p) !== null, "引数のパスは 'name' か 'name[].field'（1段だけ）");
const mcpActionSchema = z
  .string()
  .refine((a) => {
    const p = parseMcpAction(a);
    return p !== null && CONNECTOR_SLUG.test(p.connector) && !/\s/.test(p.tool);
  }, "操作名は 'mcp.<connector>.<tool>'（connector は英小文字・数字・'-'）");
const usd = (min: number, max: number) => z.number().min(min).max(max);
const intIn = (min: number, max: number) => z.int().min(min).max(max);
const C = DEFAULT_CEILINGS;

const guardSchema = z
  .strictObject({
    action: mcpActionSchema,
    arg: argPathKey,
    min: z.number().optional(),
    max: z.number().optional(),
    max_digits: z.int().min(1).optional(),
    in: z.array(z.string()).optional(),
  })
  .superRefine((g, ctx) => {
    const numeric = g.min !== undefined || g.max !== undefined || g.max_digits !== undefined;
    // 1つのガードは数値の範囲か候補のどちらか（BR-61 の「か」。両方は拒否：KC §2.4）
    if (numeric && g.in !== undefined) ctx.addIssue({ code: "custom", message: "ガードは数値の範囲（min・max・max_digits）か候補（in）のどちらか一方" });
    if (!numeric && g.in === undefined) ctx.addIssue({ code: "custom", message: "ガードに条件（min・max・max_digits・in）がない" });
  });

const ruleSchema = z.strictObject({
  // policy_decisions.matched_rule_id の CHECK（1〜128 文字）と揃える（SG-09）
  id: z.string().min(1).max(128),
  action: mcpActionSchema,
  match: z.record(argPathKey, z.json()),
  free: z.array(argPathKey).optional(),
  labels: z.record(argPathKey, z.string()).optional(),
  // tool_hash だけ 'sha256:' つき（M-07）
  tool_hash: z.templateLiteral(["sha256:", z.string().regex(/^[0-9a-f]{64}$/)]),
  added_by: z.string().min(1),
  added_at: z.iso.datetime({ offset: true }),
  source_intent_id: z.string().min(1).optional(),
  // 出どころの記録（SG-09）。照合・合成・classify には使わない。ないルール（記録より前）も受ける
  created_while_tainted: z.boolean().optional(),
});

const triggerSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("manual") }),
  z.strictObject({
    type: z.literal("schedule"),
    // 最短間隔1時間（BR-25）：分のフィールドが1つの値のときだけ（1時間に2回以上起きない）
    cron: z.string().refine((c) => parseCronSchedule(c)?.minutes.length === 1, "cron は5つのフィールドで、分は1つの値（最短間隔は1時間：BR-25）"),
    timezone: z.string().refine(isIanaTimeZone, "タイムゾーンは IANA の名前"),
  }),
  z.strictObject({
    type: z.literal("watch"),
    interval: z.string().refine((i) => (parseWatchIntervalMinutes(i) ?? 0) >= 60, "間隔は '1h' のような形で1時間以上（BR-25）"),
    targets: z.array(z.string().min(1)).min(1),
  }),
]);

const deliverSchema = z.strictObject({
  to: z.union([z.literal("notify"), mcpActionSchema]),
  args: z.record(argPathKey, z.json()).optional(),
  content: z
    .record(argPathKey, z.string().refine(usesOnlyReportVariables, "使える変数は report.title・summary・body・sources_markdown だけ"))
    .optional(),
});

const jobSchema = z.strictObject({
  id: z.string().regex(JOB_SLUG, "仕事の id は ^[a-z0-9-]{2,40}$"),
  kind: z.enum(["once", "recurring", "watch"]),
  // 開発テンプレートはフェーズ1（C-49）
  template: z.enum(GENERAL_TEMPLATE_NAMES),
  instructions: z.string().refine((s) => charCount(s) <= 8000, "指示は 8,000 文字まで"),
  tuning: z.string().optional(),
  trigger: triggerSchema.nullable().optional(),
  deliver: z.array(deliverSchema).optional(),
  guards: z.array(guardSchema).optional(),
  notify: z.strictObject({ quiet_if_normal: z.boolean().optional() }).optional(),
});

/**
 * エージェント定義 v2 のスキーマ（0-H）。範囲は KC §2.2 の表（上端は Hard Ceiling と同じ。max_minutes は 55：M-59）。
 * 未知のキー・カタログにない自律度のキー（browser_submit：KC §8 #29）・開発テンプレートは拒否
 */
export const agentDefinitionSchema = z
  .strictObject({
    version: z.literal(2),
    name: z.string().refine((s) => s.trim() !== "" && charCount(s) <= 40, "名前は1〜40文字"),
    role: z.enum(AGENT_ROLES).nullable().optional(),
    appearance: z.strictObject({ icon: z.string().optional(), color: z.string().optional() }).optional(),
    grants: z
      .strictObject({
        web: z
          .strictObject({ allow_domains: z.array(z.string().refine((d) => d.trim() !== "" && !/\s/.test(d.trim()), "ドメインに空白は使えない")) })
          .optional(),
        connectors: z.record(z.string(), z.strictObject({ grant: z.array(z.string()) })).optional(),
      })
      .optional(),
    autonomy: z.partialRecord(z.enum(OPERATION_TYPES), levelSchema).optional(),
    rules: z.array(ruleSchema).optional(),
    budget: z
      .strictObject({
        per_task_usd: usd(0.1, C.budget.per_task_usd).optional(),
        per_day_usd: usd(0.1, C.budget.per_day_usd).optional(),
        max_steps: intIn(1, C.budget.max_steps).optional(),
        max_minutes: intIn(5, C.budget.max_minutes).optional(),
      })
      .optional(),
    breakers: z
      .strictObject({
        same_action_repeat: intIn(2, C.breakers.same_action_repeat).optional(),
        denied_attempts_max: intIn(1, C.breakers.denied_attempts_max).optional(),
        step_cost_usd_max: usd(0.01, C.breakers.step_cost_usd_max).optional(),
      })
      .optional(),
    max_runs_per_day: intIn(1, C.max_runs_per_day).optional(),
    profile: z.array(z.string().min(1)).optional(),
    memory: z.strictObject({ enabled: z.boolean(), max_items: intIn(1, 200) }).optional(),
    approvers: z.array(z.string().min(1)).optional(),
    jobs: z.array(jobSchema).max(10, "仕事は1エージェント10個まで（A-81）").optional(),
  })
  .superRefine((def, ctx) => {
    const seenJobs = new Set<string>();
    (def.jobs ?? []).forEach((j, i) => {
      if (seenJobs.has(j.id)) ctx.addIssue({ code: "custom", path: ["jobs", i, "id"], message: `仕事の id「${j.id}」が重複している` });
      seenJobs.add(j.id);
    });
    const seenRules = new Set<string>();
    (def.rules ?? []).forEach((r, i) => {
      if (seenRules.has(r.id)) ctx.addIssue({ code: "custom", path: ["rules", i, "id"], message: `ルールの id「${r.id}」が重複している` });
      seenRules.add(r.id);
    });
    const granted = new Map<string, Set<string>>();
    for (const [name, g] of Object.entries(def.grants?.connectors ?? {})) {
      const slug = name.trim();
      if (!CONNECTOR_SLUG.test(slug)) {
        ctx.addIssue({ code: "custom", path: ["grants", "connectors", name], message: "コネクタの slug は英小文字・数字・'-'" });
      }
      g.grant.forEach((t, k) => {
        if (t.trim() === "" || /\s/.test(t.trim())) {
          ctx.addIssue({ code: "custom", path: ["grants", "connectors", name, "grant", k], message: "ツール名が空、または空白を含む" });
        }
      });
      const set = granted.get(slug) ?? new Set<string>();
      for (const t of g.grant) set.add(t.trim());
      granted.set(slug, set);
    }
    (def.jobs ?? []).forEach((j, i) => {
      (j.deliver ?? []).forEach((d, k) => {
        if (d.to === "notify") return;
        const p = parseMcpAction(d.to);
        if (p === null) return; // 形の誤りは deliverSchema が出す
        // watcher は MCP に届けられない（BR-40 の趣旨。KC §8 #28）
        if (j.template === "watcher") {
          ctx.addIssue({ code: "custom", path: ["jobs", i, "deliver", k, "to"], message: "watcher の仕事は notify にだけ届けられる（BR-40）" });
        }
        // 付与していないツールへの届け先は、実行時に必ず not_granted になる（KC §8 #27）
        if (!granted.get(p.connector)?.has(p.tool)) {
          ctx.addIssue({ code: "custom", path: ["jobs", i, "deliver", k, "to"], message: `届け先 ${d.to} は付与されていない` });
        }
      });
    });
  });


/** 定義の検証の項目（09 common.md:144 の形。file・line は アプリ内モードでは持たない） */
export interface DefinitionIssue {
  code: "AGENT_SCHEMA_INVALID";
  /** 'jobs[0].deliver[1].to' のような元の定義の位置 */
  path: string;
  message: string;
}
export type DefinitionValidation = { ok: true; definition: AgentDefinition } | { ok: false; issues: DefinitionIssue[] };

/** コネクタの slug → 接続の状態とツール（ツール名 → 判定の時点の情報。M-02） */
export type ConnectorCatalog = Readonly<Record<string, { connected: boolean; tools: Readonly<Record<string, ToolInfo>> }>>;

const JA = z.locales.ja();

function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else {
      const key = String(seg);
      out += /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? (out === "" ? key : `.${key}`) : `[${JSON.stringify(key)}]`;
    }
  }
  return out;
}

/**
 * 保存の前の検証（FR-022）。スキーマ（範囲・形・未知のキー・仕事11個目・間隔・届け先・watcher）を通ったら正規化して返す。
 * tools（判定の時点のツールの情報）を渡すと、ガードを option 以外に付けたもの（KC §8 #10）と、
 * 届け先の content に content 以外の引数を書いたもの（宛先・option を報告の本文で埋めない：mcp-and-web.md:176）も拒否する。
 * ワークスペースのポリシー・Hard Ceiling との比較（AGENT_EXCEEDS_POLICY）は compose の violations
 */
export function validateAgentDefinition(raw: unknown, opts: { tools?: ConnectorCatalog } = {}): DefinitionValidation {
  const parsed = agentDefinitionSchema.safeParse(raw, { error: JA.localeError });
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ code: "AGENT_SCHEMA_INVALID", path: formatPath(i.path), message: i.message })),
    };
  }
  const issues: DefinitionIssue[] = [];
  if (opts.tools !== undefined) {
    const catalog = opts.tools;
    /** 'mcp.<connector>.<tool>' の判定の時点の情報。ないときは undefined（見ない） */
    const toolInfoOf = (action: string): ToolInfo | undefined => {
      const p = parseMcpAction(action);
      const connector = p !== null && Object.hasOwn(catalog, p.connector) ? catalog[p.connector] : undefined;
      return p !== null && connector !== undefined && Object.hasOwn(connector.tools, p.tool) ? connector.tools[p.tool] : undefined;
    };
    (parsed.data.jobs ?? []).forEach((j, i) => {
      (j.guards ?? []).forEach((g, k) => {
        const tool = toolInfoOf(g.action);
        if (tool === undefined) return; // ツールの情報がないときは見ない
        const role = argRoleAt(tool.argRoles, g.arg);
        if (role !== "option") {
          issues.push({
            code: "AGENT_SCHEMA_INVALID",
            path: formatPath(["jobs", i, "guards", k, "arg"]),
            message: `ガードは option の引数にだけ付けられる（${g.arg} は ${role ?? "destination（役割なし：BR-56）"}。BR-61）`,
          });
        }
      });
      (j.deliver ?? []).forEach((d, k) => {
        const tool = d.to === "notify" ? undefined : toolInfoOf(d.to);
        if (tool === undefined) return;
        for (const arg of Object.keys(d.content ?? {})) {
          const role = argRoleAt(tool.argRoles, arg);
          if (role === "content") continue;
          issues.push({
            code: "AGENT_SCHEMA_INVALID",
            path: formatPath(["jobs", i, "deliver", k, "content", arg]),
            message: `content には content の引数だけを書ける（${arg} は ${role ?? "destination（役割なし：BR-56）"}。宛先・option は args に固定する：mcp-and-web.md:176）`,
          });
        }
      });
    });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, definition: normalizeAgentDefinition(parsed.data) };
}

/** ワークスペースのポリシーの形の検証（範囲は見ない） */
export function parseWorkspacePolicy(raw: unknown): WorkspacePolicy {
  return workspacePolicySchema.parse(raw, { error: JA.localeError });
}

/** カタログのツール名か */
export function isCatalogToolName(name: unknown): name is CatalogToolName {
  return typeof name === "string" && (CATALOG_TOOLS as readonly string[]).includes(name);
}
