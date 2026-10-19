// API の薄いラッパ（fetch）。CSRF トークン・Idempotency-Key・エラーの形・SSE の購読をここに集める。
//
// 型は手書き。設計書の表示項目から起こしたもので、契約（zod）が出たら突き合わせる：
// - 依頼（API-072〜077）：apps/app/src/asks/contract.ts
// - 承認・チェック（API-017・019、/check・/done・/counts）：apps/app/src/check/contract.ts
// - リハーサル・セッション・ワークスペース：apps/app/src/routes/{rehearsal,rehearsal-cases,rehearsal-user-cases,rehearsal-tighten,session,workspace}.ts（こちらは実装済みの形に合わせた）
// 契約にない呼び出し（unknown_outcome の確定）は api の中で「仮のパス」と書いてある。

import { subscribeSse } from "./lib/sse";
import type { CheckPrecedentView } from "./components/CheckPrecedent";

const BASE = "/api/v1";

// ---------------------------------------------------------------------------
// エラー

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | undefined;
  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

/** 画面に出す 1 行（コードごとの決まった文。サーバーの message は技術的なので出さない） */
export function describeError(e: unknown): string {
  if (!(e instanceof ApiError)) return "うまくいきませんでした。もう一度試してください";
  switch (e.code) {
    case "NETWORK":
      return "つながっていません";
    case "UNAUTHORIZED":
      return "もう一度入り直してください";
    case "KILL_SWITCH_ENGAGED":
      return "全部止めているので、いまはできません";
    case "APPROVAL_NOT_PENDING":
      return "すでに決まっているか、期限が切れました";
    case "INTENT_CHANGED":
      return "内容が変わったので、開き直して確かめてください";
    case "RULE_NOT_ALLOWED":
      return "この送り先は「以後も許可」にできません";
    case "USER_CASE_DAILY_LIMIT":
      return "今日はここまでです（1日5件まで）";
    case "NOT_IN_CATALOG":
      return "カタログにない障害です";
    case "RATE_LIMITED":
      return "少し待ってからもう一度試してください";
    case "FORBIDDEN":
      return "この操作はできません";
    case "NOT_FOUND":
      return "見つかりませんでした";
    case "WORKSPACE_IN_USE":
      return "この担当はいま作業場で動いています。終わってからもう一度試してください";
    case "GUEST_LIMIT_REACHED":
      return "いまは新しく始められません（試用の枠がいっぱいです）。いまの画面はそのまま使えます。しばらくしてからもう一度試してください";
    default:
      if (e.status === 404) return "見つかりませんでした";
      return e.status >= 500 ? "サーバーでうまくいきませんでした。時間をおいて試してください" : "うまくいきませんでした。もう一度試してください";
  }
}

// ---------------------------------------------------------------------------
// 共通の呼び出し

let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null): void => {
  csrfToken = t;
};

const unauthorizedListeners = new Set<() => void>();
/** 401 を受けたら呼ぶ（入口に戻す） */
export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export const newKey = (): string => crypto.randomUUID();

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** POST の Idempotency-Key（同じ操作のやり直しには同じ値を渡す） */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

function url(path: string, query?: RequestOptions["query"]): string {
  if (!query) return `${BASE}${path}`;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `${BASE}${path}?${s}` : `${BASE}${path}`;
}

async function toError(res: Response): Promise<ApiError> {
  let code = "HTTP_ERROR";
  let message = res.statusText;
  let details: unknown;
  let requestId: string | undefined;
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown; requestId?: string } };
    if (j.error) {
      code = j.error.code ?? code;
      message = j.error.message ?? message;
      details = j.error.details;
      requestId = j.error.requestId;
    }
  } catch {
    // JSON でない応答
  }
  return new ApiError(res.status, code, message, details, requestId);
}

function init(method: string, opts: RequestOptions, accept?: string): RequestInit {
  const headers: Record<string, string> = {};
  if (accept) headers.accept = accept;
  const changing = method !== "GET" && method !== "HEAD";
  if (changing) {
    headers["content-type"] = "application/json";
    if (csrfToken) headers["x-csrf-token"] = csrfToken;
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  }
  const out: RequestInit = { method, headers, credentials: "same-origin" };
  if (changing) out.body = JSON.stringify(opts.body ?? {});
  if (opts.signal) out.signal = opts.signal;
  return out;
}

async function send(method: string, path: string, opts: RequestOptions, accept?: string, retried = false): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url(path, opts.query), init(method, opts, accept));
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "NETWORK", "つながっていません");
  }
  if (res.ok) return res;
  const err = await toError(res);
  if (err.code === "CSRF_TOKEN_INVALID" && !retried) {
    // トークンが古い（別のタブで入り直したなど）。取り直して1回だけやり直す
    await api.session().catch(() => undefined);
    return send(method, path, opts, accept, true);
  }
  if (err.status === 401) unauthorizedListeners.forEach((fn) => fn());
  throw err;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(method, path, opts, "application/json");
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// セッション・ワークスペース（実装済み：routes/session.ts・workspace.ts）

export type SessionState =
  | { state: "signed_out"; /** ローカルの起動ならトークンなしで入れる（POST /entry/local） */ localEntry?: boolean }
  | { state: "setup_required"; missing: string[] }
  | { state: "signed_in"; workspaceKind: "owner" | "guest"; csrfToken: string; firstAskId?: string | null };

export interface WorkspaceView {
  id: string;
  kind: "owner" | "guest";
  role: "owner" | "maintainer" | "viewer" | string;
  timezone: string;
  maxConcurrentTasks: number;
  killSwitch: { engaged: boolean; engagedAt: string | null; engagedBy: string | null; reason: string | null };
  guest: { expiresAt: string; daysLeft: number } | null;
  budget: { todayCostUsd: string; perDayUsd: string; remainingUsd: string };
  seedVersion: string | null;
  /** Google カレンダー（available＝この環境で使えるか。connected・email＝つながっているか） */
  google: { available: boolean; connected: boolean; email: string | null };
  /**
   * GitHub（18 §3.6）。available＝この環境で使えるか、connected・login＝つながっているか、
   * allowProtectedWrite＝main・既定のブランチへの直接の書き込みを許しているか、settingsUrl＝対象のリポジトリを変える GitHub の画面
   */
  github: { available: boolean; connected: boolean; login: string | null; allowProtectedWrite: boolean; settingsUrl: string | null };
}

export interface Me {
  user: { id: string; login: string; name: string | null };
  csrfToken: string;
  workspace: WorkspaceView;
}

// ---------------------------------------------------------------------------
// 依頼（SCR-020・021）。契約：apps/app/src/asks/contract.ts（型は手で写した。ここだけ合わせ直せばよい）

export type AskShape = "single" | "parallel" | "aggregate" | "chain";
export type AskStatus = "generating" | "running" | "waiting_input" | "done" | "failed" | "cancelled";

export interface AskQuestionView {
  text: string;
  choices: Array<{ id: string; label: string }>;
  allowFreeText: boolean;
}

export interface AskTriggerView {
  type: "schedule";
  cron: string;
  timezone: string;
  /** 「毎日18時」（固定の文） */
  label: string;
  /** 次に動く時刻（古いサーバーの応答にはない） */
  nextRunAt?: string | null;
}

export interface FormationMemberView {
  memberId: string;
  agentId: string;
  agentName: string;
  isNew: boolean;
  summary: string;
  position: number | null;
  dependsOn: number[];
  isAggregator: boolean;
  isSpokesperson: boolean;
}

export interface FormationView {
  shape: AskShape;
  /** 形の 1 行（固定の文。ひとりは null） */
  shapeLine: string | null;
  members: FormationMemberView[];
  notes: string[];
}

export interface AskSummary {
  id: string;
  text: string;
  status: AskStatus;
  shape: AskShape | null;
  shapeLine: string | null;
  trigger: AskTriggerView | null;
  question: AskQuestionView | null;
  failure: { reason: string; message: string } | null;
  answerPreview: string | null;
  /** 接続が要る言い方のとき（"gcal"＝Google カレンダー、"github"＝GitHub）。未接続のときだけ画面が案内する */
  needsConnection?: "gcal" | "github" | null;
  createdAt: string;
  updatedAt: string;
}

export interface AskAnswerView {
  conclusion: string;
  spokesperson: { agentId: string; agentName: string } | null;
  memberLines: Array<{ agentName: string; text: string; failed: boolean }>;
  /** declinedLine：送る前の確認で「送らない」にしたものの1行（0件なら null。古いサーバーの応答にはない） */
  needsYou: { pendingApprovals: number; line: string | null; stoppedMembers: string[]; declinedWrites?: number; declinedLine?: string | null };
  intermediate: Array<{ agentName: string; body: string }>;
  taintNote: string | null;
  /** 窓口の「次の手の提案」（押すと返事として頼める。古いサーバーの応答にはない） */
  nextActions?: string[];
  /** 見張り：前回から変化なし（古いサーバーの応答にはない） */
  unchanged?: boolean;
  answeredAt: string;
  updatedAt: string;
}

export type StageState = "waiting" | "running" | "awaiting_approval" | "done" | "failed" | "stopped";

export interface StageView {
  memberId: string;
  agentId: string;
  agentName: string;
  position: number | null;
  isAggregator: boolean;
  summary: string;
  state: StageState;
  /** 固定の文：待っています／動いています／済み／確認待ち／失敗：〇〇／止めました */
  stateText: string;
  taskId: string | null;
  report: { title: string; body: string } | null;
  tainted: boolean;
  /** 担当のタスクが動き出した・終わった時刻（古いサーバーの応答にはない） */
  startedAt?: string | null;
  finishedAt?: string | null;
  /** やったこと（ツールの呼び出しの判定。新しいものから6件を古い順に。古いサーバーの応答にはない） */
  activity?: StageActivity[];
  /** 作業場で作ったファイル（D-116。GET /tasks/{taskId}/files）。古いサーバーの応答にはない */
  files?: { count: number; bytes: number } | null;
  /** この依頼で新しく作った担当か・使い回しの1行（古いサーバーの応答にはない） */
  isNew?: boolean;
  reuseLine?: string | null;
}

export interface StageActivity {
  /** 「受信箱の確認」「発注」「報告をまとめる」（決まった文） */
  label: string;
  /** done＝済み、approval＝あなたの確認へ、denied＝統制が止めた、halted＝安全装置で止めた */
  outcome: "done" | "approval" | "denied" | "halted";
  at: string;
}

export interface HandoffView {
  fromPosition: number | null;
  toPosition: number | null;
  fromAgentName: string;
  toAgentName: string;
  label: string;
  /** 「外部の内容を含む」（汚染のときだけ） */
  taintMark: string | null;
}

/** 止めた規則の貢献（防いだ額の降順）。一度も発動しなかったガードは実効ポリシーと照合できたときだけ */
export interface RehearsalAttribution {
  contributions: Array<{ ruleLabel: string; reasonCode: string; stoppedCount: number; preventedDamageJpy: number }>;
  unfiredGuards: string[] | null;
}

export interface AskRehearsalView {
  runId: string;
  status: string;
  certificate: "valid" | "none";
  /** 現行の合格証（依頼単位）。revoked＝どれかが失効 */
  certificateState: "valid" | "revoked" | "none";
  certificateRevokeReason: "widen" | "tool_hash" | "model" | "case_added" | "superseded" | null;
  /** 失効の理由の固定文（「ツールの説明が変わったため」） */
  certificateRevokeText: string | null;
  certificateCaseCount: number | null;
  certificateIssuedAt: string | null;
  /** 担当の仕事の再リハーサル（合格証が切れたあとの自動の走行）が走っている */
  recertifying: boolean;
  /** どの規則が何円防いだか（apps/app の rehearsal/attribution.ts。走行がなければ省く） */
  attribution?: RehearsalAttribution | null;
  /** 切れたあとの再リハーサルが費用の上限で止まった（翌日に自動でやり直す：D-107） */
  recertifyStoppedByBudget?: boolean;
  preventedDamageJpy: number | null;
  damageJpy: number | null;
  createdAt: string;
  finishedAt: string | null;
}

/** 頼んだこと → 回答 の1往復（本番の実行1つ分）。kind：ask＝最初の依頼（やり直しも）、reply＝追加で頼んだこと、schedule＝定期の実行 */
export interface AskTurnView {
  runId: string;
  runNo: number;
  kind: "ask" | "reply" | "schedule";
  /** この実行で担当に渡した文（返事の実行は返事の文。最初・定期は依頼の文） */
  text: string;
  status: "running" | "waiting_input" | "done" | "failed" | "cancelled";
  answer: AskAnswerView | null;
  startedAt: string;
  finishedAt: string | null;
}

/** 担当から利用者への質問（ask_user）。答えるまで担当は待っている */
export interface AgentQuestionView {
  questionId: string;
  agentName: string;
  text: string;
  choices: Array<{ id: string; label: string }>;
  allowFreeText: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// パック（D-116）。契約：apps/app/src/packs/contract.ts

export interface PackAgentView {
  /** 入れていれば、その担当のライブラリ上の ID（入れていない・古いサーバーの応答は null） */
  agentId: string | null;
  name: string;
  summary: string;
  template: string;
  skills: string[];
  files: string[];
}

export interface PackView {
  id: string;
  version: number;
  name: string;
  tagline: string;
  description: string;
  audience: string;
  /** 棚の分類（古いサーバーの応答にはない） */
  category?: string;
  agents: PackAgentView[];
  skills: Array<{ name: string; description: string }>;
  examples: string[];
  needsSandbox: boolean;
  sandboxAvailable: boolean;
  installedAt: string | null;
}

export interface AskDetail {
  ask: AskSummary;
  formation: FormationView | null;
  run: { runId: string; runNo: number; status: string; triggerType: string; startedAt: string; finishedAt: string | null } | null;
  answer: AskAnswerView | null;
  answerPending: { spokespersonName: string | null } | null;
  /** 担当が答えを待っている質問（古いサーバーの応答にはない） */
  agentQuestions?: AgentQuestionView[];
  /** 頼んだこと → 回答 の履歴（古い順。最後が run・answer と同じ今の実行。古いサーバーの応答にはない） */
  turns?: AskTurnView[];
  stages: StageView[];
  handoffs: HandoffView[];
  pendingIntents: Array<{ intentId: string; approvalId: string | null; taskId: string; agentName: string; action: string; intentHash: string; taintLine: string | null; createdAt: string }>;
  rehearsal: AskRehearsalView | null;
  resume: { agentName: string; reason: string } | null;
  messageCount: number;
  /** 編成を作った Gemini の呼び出し（用意した依頼は null） */
  planner: PlannerView | null;
}

/** 編成を作った Gemini（モデル・呼び出し回数・合計の時間と費用） */
export interface PlannerView {
  model: string;
  calls: number;
  latencyMs: number;
  costUsd: string;
}

export interface AskMessageView {
  id: string;
  fromAgentName: string;
  toAgentName: string | null;
  kind: "share" | "question" | "reply" | "revise";
  body: string;
  inReplyTo: string | null;
  tainted: boolean;
  createdAt: string;
}

/** SSE の ask.* の事象（asks/contract.ts の AskEventData のうち画面が使うもの） */
export type AskEvent =
  | { type: "ask.created"; askId: string; text: string; status: "generating" }
  | { type: "ask.question"; askId: string; question: AskQuestionView }
  | { type: "ask.formed"; askId: string; formation: FormationView; trigger: AskTriggerView | null }
  | { type: "ask.failed"; askId: string; reason: string; message: string }
  | { type: "ask.status"; askId: string; status: AskStatus };

// ---------------------------------------------------------------------------
// チェック（SCR-019）。契約：apps/app/src/check/contract.ts

export interface AgentRef {
  id: string;
  name: string;
}

export interface ArgView {
  arg: string;
  value: unknown;
  label: string | null;
  text: string;
}

export interface OpenReason {
  code: "guard_exceeded" | "unknown_outcome_pending" | "widen" | "first_destination";
  /** reasonCode から決まった文 */
  text: string;
  /** 太字にする値 */
  emphasis: string | null;
  limitText: string | null;
}

export interface RememberView {
  offered: boolean;
  failedConditions: Array<number | "limit">;
  fixed: ArgView[];
  freeCandidates: string[];
  fixedHash: string | null;
  /** 外部の内容を読んだ後の書き込みから作るルールか（SG-09）。true なら [以後も許可] の確認に注意を出す */
  taintedOrigin: boolean;
}

/** 予定の登録（gcal の create_event）の確認の行の中身。予定の登録のときだけ（ほかは無し） */
/** GitHub の書き込みの確認カード（18 §3.7）。protectedNote は main・master に直接書き込むときの一文 */
export interface GithubCard {
  kind: "push_commit" | "create_pull_request";
  repo: string | null;
  branch: string | null;
  base: string | null;
  files: string[];
  deletes: string[];
  protectedNote: string | null;
}

export interface CalendarCard {
  title: string | null;
  /** 日時の1行（資格情報の時間帯。なければ Asia/Tokyo） */
  when: string | null;
  location: string | null;
  attendees: string[];
  /** 招待する人がいるときの一文（招待メールは送らない） */
  inviteNote: string | null;
}

export interface ApprovalView {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  taskId: string;
  intentId: string;
  /** 画面に出した内容の指紋。承認にそのまま付ける（ADR-005） */
  intentHash: string;
  title: string;
  subtitle: string | null;
  action: string;
  agent: AgentRef | null;
  askId: string | null;
  createdAt: string;
  /** 同じ仕事・同じ action のリハーサルの前例（なければ無し） */
  precedent?: CheckPrecedentView | null;
  expiresAt: string;
  canDecide: boolean;
  /** 承認者の名前（canDecide が false のとき「〇〇さんの確認待ち」） */
  approvers: AgentRef[];
  openReason: OpenReason | null;
  taintNote: string | null;
  destination: ArgView[];
  content: ArgView[];
  options: ArgView[];
  taint: { tainted: boolean; sources: Array<{ kind: string; text: string }> };
  rule: { reasonCode: string; matchedRule: string | null; text: string };
  risk: { level: "low" | "medium" | "high"; reasons: Array<{ code: string; points: number; detail: string | null }> };
  remember: RememberView;
  /** 予定の登録のときだけ（ほかは無し） */
  calendar?: CalendarCard | null;
  /** GitHub の書き込みのときだけ */
  github?: GithubCard | null;
  decidedAt: string | null;
  decisionComment: string | null;
}

interface ItemBase {
  key: string;
  title: string;
  subtitle: string | null;
  agent: AgentRef | null;
  askId: string | null;
  at: string;
  opened: boolean;
}

export interface ApprovalItem extends ItemBase {
  kind: "approval";
  approval: ApprovalView;
}

export interface QuestionItem extends ItemBase {
  kind: "question";
  source: "ask_question" | "unknown_outcome";
  question: { text: string; choices: Array<{ id: string; label: string }>; allowFreeText: boolean };
  reason: string;
  intentId: string | null;
}

export interface ReportItem extends ItemBase {
  kind: "report";
  reportKind: "answer" | "rehearsal" | "incident_added" | "task";
  failed: boolean;
  /** 試しに走らせた結果（DryRunBanner） */
  dryRun: boolean;
  body: string | null;
  lines: string[];
  link: { askId: string | null; rehearsalRunId: string | null };
  /** 回答の報告のとき、その回答が答えた「頼んだこと」（返事の実行は返事の文）。ほかは null（古いサーバーの応答にはない） */
  request?: string | null;
}

export type CheckItem = ApprovalItem | QuestionItem | ReportItem;

export interface RunningItem {
  taskId: string;
  agent: AgentRef;
  askId: string | null;
  status: "queued" | "provisioning" | "running" | "awaiting_approval" | "executing";
  text: string;
  startedAt: string | null;
  canCancel: boolean;
}

export interface CheckCounts {
  attention: number;
  running: number;
  hasApproval: boolean;
}

export interface CheckResponse {
  items: CheckItem[];
  running: RunningItem[];
  counts: CheckCounts;
  killSwitch: { engaged: boolean };
  focus: string | null;
}

export interface DoneItem {
  key: string;
  kind: "report" | "approval";
  title: string;
  subtitle: string | null;
  outcome: "approved" | "rejected" | "expired" | null;
  askId: string | null;
  doneAt: string;
  /** 予定の登録が実行されたときの「カレンダーで開く」のリンク（https の Google カレンダーだけ。なければ出さない） */
  calendarLink?: string | null;
}

export interface DecisionBody {
  decision: "approve" | "reject";
  intentHash: string;
  comment?: string;
  remember?: boolean;
  rememberFixedHash?: string;
  freeOptions?: string[];
}

export interface DecisionResponse {
  approval: ApprovalView;
  rule: unknown;
  execution: { status: string; failReason: string | null; expiredReason: string | null; calendarLink?: string | null } | null;
  incidentLine: string | null;
}

// ---------------------------------------------------------------------------
// エージェントの一覧（ライブラリ。SCR-014）。契約：apps/app/src/agents/contract.ts

export type AgentViewStatus = "idle" | "active" | "invalid" | "disabled";
export type AgentActivityState = "running" | "awaiting_approval" | "disabled" | "idle";

export interface AgentAskView {
  askId: string;
  text: string;
  status: AskStatus;
  /** その依頼でこの担当がすること（編成の1行） */
  summary: string;
  isNew: boolean;
  isSpokesperson: boolean;
  isAggregator: boolean;
  position: number | null;
  createdAt: string;
}

export interface AgentJobView {
  jobId: string;
  kind: "once" | "recurring" | "watch";
  kindLabel: string;
  template: "researcher" | "briefer" | "watcher" | "assistant" | "dev-coder" | "reviewer";
  templateLabel: string;
  status: "waiting_input" | "active" | "paused" | "done";
  createdAt: string;
}

export interface AgentLibraryItem {
  id: string;
  name: string;
  nameSource: "user" | "suggested";
  role: "research" | "watch" | "brief" | "assist" | "dev" | null;
  roleLabel: string | null;
  status: AgentViewStatus;
  activity: AgentActivityState;
  /** 固定の文：動いています／確認待ち／止めています／待機中 */
  activityText: string;
  disabledReason: string | null;
  jobCount: number;
  askCount: number;
  taskCount: number;
  lastActiveAt: string | null;
  createdAt: string;
  /** この担当が生まれた依頼（用意した担当は null） */
  bornAskId: string | null;
  /** 成長の1行（使い回し・以後も許可・権限を絞った・スキル。0 の項目は出ない。なければ null） */
  growthLine?: string | null;
  asks: AgentAskView[];
  jobs: AgentJobView[];
}

export interface AgentLibraryResponse {
  items: AgentLibraryItem[];
  limit: number;
  count: number;
}

/** POST /agents/{agentId}/workspace/reset（owner・maintainer）：担当の作業場を最初に戻す（SG-07）。契約：agents/contract.ts */
export interface ResetAgentWorkspaceResponse {
  agentId: string;
  snapshotId: string;
  /** パックのファイルに戻したか、空にしたか */
  origin: "pack" | "empty";
  files: string[];
  resetAt: string;
}

// ---------------------------------------------------------------------------
// リハーサル（実装済み：routes/rehearsal*.ts）

export type RunStatus = "queued" | "generating" | "running" | "done" | "failed" | "cancelled" | (string & {});

export interface RehearsalRun {
  id: string;
  jobId: string | null;
  askId: string | null;
  trigger: "seed" | "initial" | "retest" | "recertify" | "user_case" | (string & {});
  /** 台本で再現した結果か（Gemini を呼んでいない。seed は常に true。retest は GUEST_RETEST_MODE=replay のゲストの依頼で true） */
  scripted: boolean;
  status: RunStatus;
  seed: number;
  modelId: string;
  adaptRound: number;
  damageJpy: number | null;
  withoutControlDamageJpy: number | null;
  preventedDamageJpy: number | null;
  costUsd: string;
  budgetUsd: string;
  certificateId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RehearsalScenarioRow {
  id: string;
  caseId: string;
  ordinal: number;
  status: "queued" | "running" | "judging" | "done" | "cancelled" | "error" | (string & {});
  abortReason: string | null;
  faultIds: string[];
  verdict: "pass" | "fail" | null;
  /** kernel | agent | none */
  stoppedBy: string | null;
  stoppedByDecision: string | null;
  stoppedByReasonCode: string | null;
  stoppedByRule: string | null;
  damageJpy: number | null;
  withoutControlDamageJpy: number | null;
  preventedDamageJpy: number | null;
  /** 式と元の値（BR-79。rehearsal/damage-view.ts の DamageBreakdownView。形が合わない保存値は null） */
  damageBreakdown: DamageBreakdownView | null;
  /** 統制なし（影の走行）の分 */
  withoutControlDamageBreakdown: DamageBreakdownView | null;
  interpretation: unknown;
  costUsd: string;
  error: string | null;
  /** 却下した書き込みの試験で、同じ宛先・違う内容がルールで確認なしに送られたときの注記（D-110。合否は変えない）。自分の悪い日の行には付かない */
  incidentNote?: IncidentNote | null;
}

/** 注記の品目1行（apps/app/src/rehearsal/incident-note.ts の NoteItem） */
export interface IncidentNoteItem {
  sku: string | null;
  name: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
}

export interface IncidentNote {
  text: string;
  destination: string | null;
  ruleLabel: string | null;
  sent: IncidentNoteItem[];
  rejected: IncidentNoteItem[];
}

export interface DamageTerm {
  key: string;
  label: string;
  value: number | string;
  unit: "jpy" | "qty" | "text";
}

/** apps/app/src/rehearsal/damage-view.ts の DamageBreakdownView */
export interface DamageBreakdownView {
  totalJpy: number;
  items: Array<{
    kind: "wrong_payee" | "duplicate_order" | "over_order" | "overpriced";
    label: string;
    formula: string;
    applied: boolean;
    amountJpy: number;
    lines: Array<{ label: string; expression: string; terms: DamageTerm[]; amountJpy: number }>;
  }>;
  secretLeaks: { count: number; writes: Array<{ eventSeq: number; tool: string; canary: string }> };
}

/** 結果の userCases[]（自分の悪い日。routes/rehearsal.ts → rehearsal/user-case-results.ts） */
export interface UserCaseResult {
  id: string;
  text: string | null;
  status: string | null;
  /** 「こう解釈しました：」のあとの1行 */
  interpretation: string | null;
  caseId: string | null;
  faultIds: string[];
  runId: string;
  runStatus: string;
  damageJpy: number | null;
  withoutControlDamageJpy: number | null;
  preventedDamageJpy: number | null;
  createdAt: string;
  finishedAt: string | null;
  scenario: RehearsalScenarioRow | null;
}

/** packages/rehearsal の RehearsalCounts */
export interface RehearsalCounts {
  total: number;
  withoutControl: { harmed: number; damageJpy: number } | null;
  withControl: { slipped: number; damageJpy: number };
  afterTighten: { slipped: number; damageJpy: number } | null;
  stoppedByKernel: number;
  stoppedByAgent: number;
  byKernelRule: Record<string, number>;
}

/** 締める提案（result.proposals。id は POST …/tightening の proposalId） */
export interface TighteningProposal {
  id: string;
  jobId: string;
  /** 画面に出す 1 行（例：「1回の発注は20個まで」） */
  label: string;
  patch: Array<{ op: "add" | "replace" | "remove"; path: string; value?: unknown }>;
  /** 塞ぐ状況の caseId */
  fixes: string[];
}

export interface RehearsalResult {
  run: RehearsalRun;
  /** 悪い日を作った Gemini（用意した走行は null。費用の記録がなければ costUsd は null） */
  generator?: { model: string; costUsd: string | null; count?: number } | null;
  counts: RehearsalCounts | null;
  provisional: boolean;
  preventedDamageJpy: number | null;
  scenarios: RehearsalScenarioRow[];
  proposals: TighteningProposal[];
  userCases: UserCaseResult[];
}

export interface RehearsalCertificate {
  id: string;
  runId: string;
  policyHash: string;
  toolHashes: unknown;
  modelId: string;
  caseSetHash: string;
  caseCount: number;
  summary: unknown;
  certificateHash: string;
  auditSeq: number | null;
  issuedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface RehearsalCase {
  id: string;
  /** どの依頼の試験か（担当の仕事の試験は null） */
  askId: string | null;
  source: "generated" | "user" | "incident" | (string & {});
  title: string | null;
  faultIds: string[];
  userText: string | null;
}

export interface UserCaseStarted {
  userCase: { id: string; status: string; interpretation: string | null; faultIds: string[]; runId: string | null };
  run: RehearsalRun;
}

// ---------------------------------------------------------------------------
// 監査ログ（SCR-010。API-023・API-024 = EP-43・EP-44：apps/app/src/routes/audit.ts）

/** AS §2.10 の AuditLogItem */
export interface AuditLogItem {
  seq: number;
  occurredAt: string;
  eventType: string;
  actorType: "user" | "system" | "agent" | (string & {});
  actorId: string;
  taskId: string | null;
  payload: Record<string, unknown>;
  hash: string;
  prevHash: string;
  /** 影の走行の書き込みは false */
  enforced: boolean;
}

export interface AuditLogQuery {
  limit?: number;
  cursor?: string;
  /** カンマ区切りで複数 */
  eventType?: string;
  includeShadow?: boolean;
}

export interface AuditVerifyResult {
  ok: boolean;
  checkedCount: number;
  firstBrokenSeq: number | null;
  checkpointMatched: null;
}

// ---------------------------------------------------------------------------
// ワークスペースの SSE（EP-45）

/** 受ける事象の名前（check/contract.ts の CHECK_EVENT_TYPES・asks/contract.ts の ASK_EVENT_TYPES・リハーサル・Kill Switch） */
const EVENT_TYPES = [
  "killswitch",
  "reset",
  "check.upsert",
  "check.remove",
  "check.counts",
  "ask.created",
  "ask.question",
  "ask.formed",
  "ask.failed",
  "ask.status",
  "ask.step.started",
  "ask.step.finished",
  "ask.answered",
  "ask.answer.updated",
  "ask.message.posted",
  "rehearsal.scenario",
  "rehearsal.run",
  "rehearsal.phase",
];

/**
 * EventSource で購読する。事象の名前は event、本文は JSON。
 * ネットワークの切断はブラウザが Last-Event-ID つきでつなぎ直す。サーバーが非 200 で閉じた・Cloud Run が切ったとき（CLOSED）は
 * lib/sse.ts がバックオフして作り直す（直前に GET /session で入り直しが要るか確かめ、要るなら onUnauthorized の扱い）。
 * onDown は切れてから猶予（8 秒）の間につながらなかったとき。
 */
export function subscribeWorkspace(
  workspaceId: string,
  handlers: { onEvent: (type: string, data: unknown) => void; onOpen?: () => void; onDown?: () => void },
): () => void {
  return subscribeSse(
    {
      url: `${BASE}/workspaces/${workspaceId}/stream`,
      eventTypes: EVENT_TYPES,
      createEventSource: (u) => new EventSource(u),
      // 取れなければ（ネットワーク）true を返してつなぎ直しを続ける。401 は send() が unauthorizedListeners を呼ぶ
      checkSession: async () => {
        try {
          return (await api.session()).state === "signed_in";
        } catch (e) {
          return !(e instanceof ApiError && e.status === 401);
        }
      },
    },
    {
      onEvent: handlers.onEvent,
      onOpen: handlers.onOpen,
      onDown: handlers.onDown,
      onUnauthorized: () => unauthorizedListeners.forEach((fn) => fn()),
    },
  );
}

// ---------------------------------------------------------------------------
// API

const ws = (workspaceId: string) => `/workspaces/${workspaceId}`;
const enc = encodeURIComponent;

export const api = {
  // 入口・セッション
  session: async (): Promise<SessionState> => {
    const s = await request<SessionState>("GET", "/session");
    if (s.state === "signed_in") setCsrfToken(s.csrfToken);
    return s;
  },
  me: async (): Promise<Me> => {
    const me = await request<Me>("GET", "/me");
    setCsrfToken(me.csrfToken);
    return me;
  },
  enter: (token: string) => request<{ state: "signed_in"; workspaceKind: string; next: string; firstAskId: string | null; created: boolean }>("POST", "/entry", { body: { token } }),
  /** ローカルの起動だけ：トークンなしでオーナーとして入る */
  enterLocal: () => request<{ state: "signed_in"; workspaceKind: string; next: string; firstAskId: string | null; created: boolean }>("POST", "/entry/local", { body: {} }),
  logout: () => request<void>("POST", "/logout"),
  /** Google カレンダーを切断（DELETE /connect/google。接続のない状態で呼んでも何もしない） */
  disconnectGoogle: () => request<void>("DELETE", "/connect/google"),
  /** GitHub を切断（DELETE /connect/github。アンインストールは GitHub の画面で） */
  disconnectGithub: () => request<void>("DELETE", "/connect/github"),
  /** main・既定のブランチへの直接の書き込みの許可を切り替える */
  setGithubProtectedWrite: (allow: boolean) => request<{ allowProtectedWrite: boolean }>("PUT", "/connect/github/protected-write", { body: { allow } }),
  /** ゲストの [最初からやり直す]：新しいゲストを作ってから古いのを削除予約にする。新しい Cookie が出る */
  restartGuest: () => request<{ next: string; firstAskId: string }>("POST", "/guest/restart", { body: {} }),

  // 全部止める（EP-27）
  engageKillSwitch: (workspaceId: string, reason: string | null, idempotencyKey: string) =>
    request<unknown>("POST", `${ws(workspaceId)}/kill-switch`, { body: reason ? { reason } : {}, idempotencyKey }),

  // チェック・承認（check/contract.ts）
  counts: () => request<CheckCounts>("GET", "/counts"),
  check: (item?: string | null) => request<CheckResponse>("GET", "/check", { query: { item: item ?? undefined } }),
  done: () => request<{ items: DoneItem[]; nextCursor: string | null }>("GET", "/done", { query: { limit: 50 } }),
  /** 報告の ○（承認・質問は 409 CHECK_ITEM_NOT_CHECKABLE） */
  markChecked: (key: string) => request<unknown>("POST", `/check/${enc(key)}`),
  approvals: (query: { askId?: string; status?: "pending" }) => request<{ items: ApprovalView[] }>("GET", "/approvals", { query }),
  decide: (approvalId: string, body: DecisionBody, idempotencyKey: string) => request<DecisionResponse>("POST", `/approvals/${approvalId}/decision`, { body, idempotencyKey }),
  /** API-016 */
  cancelTask: (taskId: string) => request<unknown>("POST", `/tasks/${taskId}/cancel`),
  /** unknown_outcome の確定（[届いていた]＝executed／[届いていない]＝failed。選択肢の id がそのまま outcome） */
  resolveUnknownOutcome: (intentId: string, outcome: string) => request<unknown>("POST", `/intents/${intentId}/resolve`, { body: { outcome } }),

  // 依頼（asks/contract.ts）
  /** API-072：202。生成の結果はワークスペースの SSE（ask.*）で届く */
  /** opts.packId：パックの作業場から頼んだとき（そのパックの担当を優先して編成する） */
  createAsk: (text: string, idempotencyKey?: string, opts?: { packId?: string }) =>
    request<{ ask: AskSummary }>("POST", "/asks", { body: { text, ...(opts?.packId ? { packId: opts.packId } : {}) }, idempotencyKey }),
  /** API-073：生成中の質問に答える */
  answerAsk: (askId: string, answer: { choiceId: string } | { text: string }) => request<{ ask: AskSummary }>("POST", `/asks/${askId}/answer`, { body: answer }),
  /** API-074：順番の失敗から */
  resumeAsk: (askId: string, action: "retry" | "finish") => request<{ ask: AskSummary }>("POST", `/asks/${askId}/resume`, { body: { action } }),
  /** 最近の依頼（メニューの一覧）。limit は最大 50 */
  /** API-075 */
  ask: (askId: string) => request<AskDetail>("GET", `/asks/${askId}`),
  /** API-076 */
  askMessages: (askId: string) => request<{ messages: AskMessageView[] }>("GET", `/asks/${askId}/messages`),
  /** API-077 */
  replyAsk: (askId: string, text: string) => request<unknown>("POST", `/asks/${askId}/reply`, { body: { text } }),
  answerAgentQuestion: (askId: string, questionId: string, body: { choiceId?: string; text?: string }) =>
    request<unknown>("POST", `/asks/${askId}/questions/${questionId}/answer`, { body }),

  // エージェントの一覧（agents/contract.ts）
  /** 生成した担当のライブラリ（SCR-014） */
  agents: () => request<AgentLibraryResponse>("GET", "/agents"),
  /** 担当の作業場を最初に戻す（作業場が動いている間は 409 WORKSPACE_IN_USE） */
  resetAgentWorkspace: (agentId: string) => request<ResetAgentWorkspaceResponse>("POST", `/agents/${encodeURIComponent(agentId)}/workspace/reset`, { body: {} }),
  /** 依頼の一覧（新しい順。最大 50 件：asks/contract.ts の ListAsksQuerySchema） */
  asks: (limit = 50) => request<{ asks: AskSummary[] }>("GET", "/asks", { query: { limit } }),
  packs: () => request<{ categories?: string[]; packs: PackView[] }>("GET", "/packs"),
  installPack: (packId: string) => request<{ pack: PackView; agents: Array<{ agentId: string; name: string }> }>("POST", `/packs/${encodeURIComponent(packId)}/install`, { body: {} }),

  // リハーサル
  rehearsals: (workspaceId: string, askId: string) => request<{ items: RehearsalRun[] }>("GET", `${ws(workspaceId)}/rehearsals`, { query: { askId, limit: 20 } }),
  rehearsalResult: (workspaceId: string, runId: string) => request<RehearsalResult>("GET", `${ws(workspaceId)}/rehearsals/${runId}/result`),
  rehearsalCertificate: async (workspaceId: string, runId: string): Promise<RehearsalCertificate | null> => {
    try {
      return (await request<{ certificate: RehearsalCertificate }>("GET", `${ws(workspaceId)}/rehearsals/${runId}/certificate`)).certificate;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  rehearsalCases: (workspaceId: string, askId: string) => request<{ items: RehearsalCase[] }>("GET", `${ws(workspaceId)}/rehearsal-cases`, { query: { askId } }),
  /** 担当の仕事の試験（本番から足した試験は仕事に入る。依頼のページが自動の再リハーサルの行の題・印に使う） */
  jobRehearsalCases: (workspaceId: string, jobId: string) => request<{ items: RehearsalCase[] }>("GET", `${ws(workspaceId)}/rehearsal-cases`, { query: { jobId } }),
  startRehearsal: (workspaceId: string, askId: string) => request<{ run: RehearsalRun }>("POST", `${ws(workspaceId)}/rehearsals`, { body: { askId } }),
  applyTightening: (workspaceId: string, runId: string, proposalId: string, retest = true) =>
    request<{ run: RehearsalRun | null; retestError?: { code: string; message: string } }>("POST", `${ws(workspaceId)}/rehearsals/${runId}/tightening`, { body: retest ? { proposalId } : { proposalId, retest: false } }),
  startUserCase: (workspaceId: string, runId: string, text: string) => request<UserCaseStarted>("POST", `${ws(workspaceId)}/rehearsals/${runId}/user-cases`, { body: { text } }),
  cancelUserCase: (workspaceId: string, runId: string, inputId: string) => request<unknown>("DELETE", `${ws(workspaceId)}/rehearsals/${runId}/user-cases/${inputId}`),

  // 監査ログ（seq の降順。nextCursor が null なら終わり）
  auditLogs: (workspaceId: string, q: AuditLogQuery = {}) =>
    request<{ items: AuditLogItem[]; nextCursor: string | null }>("GET", `${ws(workspaceId)}/audit-logs`, {
      query: { limit: q.limit, cursor: q.cursor, eventType: q.eventType || undefined, includeShadow: q.includeShadow ? "true" : undefined },
    }),
  /** 全範囲のハッシュを計算し直す */
  verifyAuditLogs: (workspaceId: string) => request<AuditVerifyResult>("POST", `${ws(workspaceId)}/audit-logs/verify`, { body: {} }),
};

/** 作業場で作ったファイル（tar.gz）のダウンロードの URL（D-116。同じオリジンのセッションで取れる） */
export function taskFilesUrl(taskId: string): string {
  return `/api/v1/tasks/${encodeURIComponent(taskId)}/files`;
}
