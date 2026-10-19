// 承認・チェック・counts・セッションの応答の契約（フロント apps/web が合わせる1か所。zod のスキーマと型）
// 06 ask-and-check.md（SCR-019）・09_api/approvals.md（API-017・019）・tasks.md（API-016）・15 §ゲストのワークスペース
// - ここは「応答の形」だけ。文言は reasons.ts が reasonCode から固定の文で作る（LLM に書かせない）
// - 行のキー（item key）は '<種類>:<UUID>'。報告は check_marks のキーと同じ（answer / rehearsal / incident_added / task）。
//   承認は approval:<approvalId>、質問は ask_question:<askId> / unknown_outcome:<intentId>
// - 時刻はすべて ISO 8601（UTC）。金額・数量は表示用の文字列を持たず、値のまま出す（画面が整える）。ただし「理由の文」は文で返す
// - SSE（EP-45 /workspaces/:id/stream）の事象は CHECK_EVENT_TYPES：check.upsert（行が増えた・変わった）、check.remove（行が消えた）、
//   check.counts（件数）。画面は GET /check で取り直せば同じ状態になる（事象は取りこぼしてもよい）

import { z } from "zod";

const Id = z.string();
const Iso = z.string();
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

// ---- 共通の部品 ----

export const AgentRef = z.object({ id: Id, name: z.string() });
export type AgentRef = z.infer<typeof AgentRef>;

/** BR-70：行を開いた状態で出す理由。text は reasonCode から決まった文 */
export const OPEN_REASON_CODES = ["guard_exceeded", "unknown_outcome_pending", "widen", "first_destination"] as const;
export const OpenReason = z.object({
  code: z.enum(OPEN_REASON_CODES),
  text: z.string(),
  /** 太字にする値（guard_exceeded は超えた値、first_destination は宛先）。なければ null */
  emphasis: z.string().nullable(),
  /** guard_exceeded：上限（「いつもの上限（20個）」の 20個）。他は null */
  limitText: z.string().nullable(),
});
export type OpenReason = z.infer<typeof OpenReason>;

/** 引数の1項目（宛先・中身・その他）。label は表示名（既知の仕入れ先の名前など。なければ null） */
export const ArgView = z.object({ arg: z.string(), value: z.unknown(), label: z.string().nullable(), text: z.string() });
export type ArgView = z.infer<typeof ArgView>;

/**
 * 予定の登録（mcp.gcal.create_event）の確認カードの中身。title・when・location は引数のとおり（when は資格情報の時間帯で、なければ Asia/Tokyo）。
 * inviteNote：招待する人がいるときの一文（「2人に招待を送らずに登録します」。招待メールは送らない）。予定の登録以外は null
 */
export const CalendarCard = z.object({
  title: z.string().nullable(),
  when: z.string().nullable(),
  location: z.string().nullable(),
  attendees: z.array(z.string()),
  inviteNote: z.string().nullable(),
});
export type CalendarCard = z.infer<typeof CalendarCard>;

/**
 * GitHub の書き込み（mcp.github.push_commit・create_pull_request）の確認カード（18 §3.7）。
 * branch は push_commit のブランチ・PR の head、base は元にする（PR を出す先の）ブランチ（省略は既定のブランチ）。
 * protectedNote：main・master に直接書き込むときの一文（それ以外は null）
 */
export const GithubCard = z.object({
  kind: z.enum(["push_commit", "create_pull_request"]),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  base: z.string().nullable(),
  files: z.array(z.string()),
  deletes: z.array(z.string()),
  protectedNote: z.string().nullable(),
});
export type GithubCard = z.infer<typeof GithubCard>;

export const TaintSourceView = z.object({
  kind: z.enum(["mcp_read", "web_search", "web_fetch", "sandbox_run", "skill", "handoff", "team_message", "workspace_snapshot"]),
  /** 「受信箱（メール）を読んだ」「受信箱係から受け取った」の固定の文 */
  text: z.string(),
});
export type TaintSourceView = z.infer<typeof TaintSourceView>;

// ---- 承認（API-017・019） ----

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;

/** [以後も許可]：出せるか。固定される値の確認（fixed）を見せ、その hash を decision に載せ返してもらう */
export const RememberView = z.object({
  offered: z.boolean(),
  /** 出せないときの理由（15 §以後も許可を出す条件の番号。'limit' はルールの上限） */
  failedConditions: z.array(z.union([z.number(), z.literal("limit")])),
  /** ルールで固定される値（宛先とその他の引数すべて。BR-69） */
  fixed: z.array(ArgView),
  /** 「毎回変わってよい」にできる option の引数名 */
  freeCandidates: z.array(z.string()),
  /** fixed の hash。remember の確定で rememberFixedHash に載せる（見た値と固めた値がずれない） */
  fixedHash: Hex64.nullable(),
  /**
   * 外部の内容を読んだ後（汚染されたタスク）の書き込みから作るルールか（SG-09）。true なら [以後も許可] の確認に注意を1行出す。
   * ルールは作れる（BR-57 は変えない）。出せないとき（offered: false）は false
   */
  taintedOrigin: z.boolean(),
});
export type RememberView = z.infer<typeof RememberView>;

/** 送る前の確認に出す前例（同じ仕事・同じ action のリハーサル）。text は precedent.ts が決めた文。前例が0件なら行に付けない */
export const Precedent = z.object({
  trials: z.number().int(),
  /** 影（統制なし）で承認したときの損害の最大。影を走らせていない試験しかなければ null */
  maxShadowDamageJpy: z.number().nullable(),
  text: z.string(),
});
export type Precedent = z.infer<typeof Precedent>;

export const ApprovalView = z.object({
  id: Id,
  status: z.enum(APPROVAL_STATUSES),
  taskId: Id,
  intentId: Id,
  /** 画面に出した内容の指紋。decision に必ず付ける（ADR-005）。違えば 409 INTENT_CHANGED */
  intentHash: Hex64,
  /** 1行目：何を送るか（固定の文） */
  title: z.string(),
  /** 2行目：宛先（destination の値を並べたもの）。なければ null */
  subtitle: z.string().nullable(),
  action: z.string(),
  agent: AgentRef.nullable(),
  /** 依頼（SCR-021）。依頼から動いたものだけ */
  askId: Id.nullable(),
  createdAt: Iso,
  expiresAt: Iso,
  /** 自分が承認者か（false なら「〇〇さんの確認待ち」と表示だけ） */
  canDecide: z.boolean(),
  /** 承認者の名前（canDecide が false のとき「〇〇さんの確認待ち」に使う） */
  approvers: z.array(AgentRef),
  /** 開いた状態で出す理由（BR-70）。閉じたままなら null */
  openReason: OpenReason.nullable(),
  /** 閉じたままの行の2行目に足す「〇〇を読んだあとの送信です」（汚染。開いた行では null） */
  taintNote: z.string().nullable(),
  destination: z.array(ArgView),
  content: z.array(ArgView),
  options: z.array(ArgView),
  /** 予定の登録のときだけ（それ以外は付けない・null）。既存の形は変えない（追加だけ） */
  calendar: CalendarCard.nullable().optional(),
  /** GitHub の書き込みのときだけ（それ以外は付けない・null）。追加だけ */
  github: GithubCard.nullable().optional(),
  taint: z.object({ tainted: z.boolean(), sources: z.array(TaintSourceView) }),
  /** ルールによる判定（reasonCode と、そこから作った決まった文）。AI の要約とは別の枠 */
  rule: z.object({ reasonCode: z.string(), matchedRule: z.string().nullable(), text: z.string() }),
  risk: z.object({ level: z.enum(["low", "medium", "high"]), reasons: z.array(z.object({ code: z.string(), points: z.number(), detail: z.string().nullable() })) }),
  remember: RememberView,
  /** 同じ仕事・同じ action のリハーサルの前例（任意。0件なら付けない） */
  precedent: Precedent.optional(),
  /** 決定済みのとき */
  decidedAt: Iso.nullable(),
  decisionComment: z.string().nullable(),
});
export type ApprovalView = z.infer<typeof ApprovalView>;

/** API-017：GET /api/v1/approvals?status=&askId=&taskId=&limit=（既定は pending。新しい順） */
export const ApprovalListResponse = z.object({ items: z.array(ApprovalView) });
export type ApprovalListResponse = z.infer<typeof ApprovalListResponse>;

/** API-019：POST /api/v1/approvals/:approvalId/decision */
export const DecisionBody = z
  .strictObject({
    decision: z.enum(["approve", "reject"]),
    /** 画面に出した ApprovalView.intentHash（ADR-005） */
    intentHash: Hex64,
    comment: z.string().max(1000).optional(),
    /** [以後も許可]。decision = approve のときだけ。rememberFixedHash が要る */
    remember: z.boolean().optional(),
    rememberFixedHash: Hex64.optional(),
    /** 「毎回変わってよい」にする option（RememberView.freeCandidates の中） */
    freeOptions: z.array(z.string().max(120)).max(20).optional(),
  })
  .refine((b) => b.remember !== true || (b.decision === "approve" && b.rememberFixedHash !== undefined), {
    message: "remember は approve と、固定される値の確認（rememberFixedHash）が要ります",
  });
export type DecisionBody = z.infer<typeof DecisionBody>;

/** 承認のあとの実行の結果（approve のとき。executeIntent の結果。呼べなかったときは not_started） */
export const ExecutionView = z.object({
  status: z.enum(["executed", "failed", "unknown_outcome", "expired", "approved", "not_started"]),
  failReason: z.string().nullable(),
  expiredReason: z.string().nullable(),
  /** 予定の登録が実行できたとき（status = executed）の「カレンダーで開く」のリンク（https の Google カレンダーだけ）。なければ null・付けない */
  calendarLink: z.string().nullable().optional(),
});
export type ExecutionView = z.infer<typeof ExecutionView>;

export const RuleView = z.object({
  id: z.string(),
  action: z.string(),
  match: z.record(z.string(), z.unknown()),
  free: z.array(z.string()),
  labels: z.record(z.string(), z.string()).nullable(),
});
export type RuleView = z.infer<typeof RuleView>;

export const DecisionResponse = z.object({
  approval: ApprovalView,
  /** remember = true のとき、作ったルール */
  rule: RuleView.nullable(),
  /** approve のとき（reject は null） */
  execution: ExecutionView.nullable(),
  /** 却下を回帰の試験にしたとき、報告の行に出す文（BR-80）。しなかったら null */
  incidentLine: z.string().nullable(),
});
export type DecisionResponse = z.infer<typeof DecisionResponse>;

// ---- チェック（SCR-019。GET /check・POST /check/:itemId・GET /done） ----

const ItemBase = {
  /** 行のキー（POST /check/:itemId・?item= で使う） */
  key: z.string(),
  /** 1行目 */
  title: z.string(),
  /** 2行目（担当 · 時刻 など）。なければ null */
  subtitle: z.string().nullable(),
  agent: AgentRef.nullable(),
  askId: Id.nullable(),
  at: Iso,
  /** ?item= で来たとき・BR-70 の4つのとき true（画面は開いた状態で出す） */
  opened: z.boolean(),
};

export const ApprovalItem = z.object({ ...ItemBase, kind: z.literal("approval"), approval: ApprovalView });

export const QuestionItem = z.object({
  ...ItemBase,
  kind: z.literal("question"),
  /** ask_question：エージェントの聞き返し（asks.question）。unknown_outcome：届いたか分からない書き込みの確定 */
  source: z.enum(["ask_question", "unknown_outcome"]),
  question: z.object({
    text: z.string(),
    choices: z.array(z.object({ id: z.string(), label: z.string() })),
    allowFreeText: z.boolean(),
  }),
  /** 開いたときの「聞き返した理由」。unknown_outcome の選択肢 id は executed | failed に固定し、POST /api/v1/intents/:intentId/resolve（別名 /outcome）の { outcome } にそのまま送る */
  reason: z.string(),
  /** unknown_outcome のとき */
  intentId: Id.nullable(),
});

export const REPORT_KINDS = ["answer", "rehearsal", "incident_added", "task"] as const;
export const ReportItem = z.object({
  ...ItemBase,
  kind: z.literal("report"),
  reportKind: z.enum(REPORT_KINDS),
  /** 失敗の報告（1行目の頭に「失敗：」を付けて赤字にする） */
  failed: z.boolean(),
  /** 試しに走らせた結果（「試しに走らせました（送っていません）」＋ DryRunBanner）。今の経路では常に false */
  dryRun: z.boolean(),
  /** 開いたときの本文（結論・誰が何をしたか）。なければ null */
  body: z.string().nullable(),
  lines: z.array(z.string()),
  /** 「この依頼のページ」（SCR-021）へのリンク用 */
  link: z.object({ askId: Id.nullable(), rehearsalRunId: Id.nullable() }),
  /** 回答の報告のとき、その回答が答えた「頼んだこと」（返事の実行は返事の文。秘密情報はマスク済み）。ほかの報告は null */
  request: z.string().nullable(),
});

export const CheckItem = z.discriminatedUnion("kind", [ApprovalItem, QuestionItem, ReportItem]);
export type CheckItem = z.infer<typeof CheckItem>;
export type ApprovalItem = z.infer<typeof ApprovalItem>;
export type QuestionItem = z.infer<typeof QuestionItem>;
export type ReportItem = z.infer<typeof ReportItem>;

/** やっていること（動いている仕事。1件1行：「仕入れ係 · 在庫の確認中」） */
export const RunningItem = z.object({
  taskId: Id,
  agent: AgentRef,
  askId: Id.nullable(),
  status: z.enum(["queued", "provisioning", "running", "awaiting_approval", "executing"]),
  /** 「在庫の確認中」「待っています」など（固定の文） */
  text: z.string(),
  startedAt: Iso.nullable(),
  /** 取り消せるか（依頼者本人か owner。API-016） */
  canCancel: z.boolean(),
});
export type RunningItem = z.infer<typeof RunningItem>;

export const CheckCounts = z.object({
  /** 見てほしいもの（承認 + 質問 + 未チェックの報告） */
  attention: z.number().int(),
  /** やっていること */
  running: z.number().int(),
  /** 送る前の確認があるか（入口の件数の数字をアクセント色にする） */
  hasApproval: z.boolean(),
});
export type CheckCounts = z.infer<typeof CheckCounts>;

/** GET /api/v1/check?item=<key> */
export const CheckResponse = z.object({
  /** 送る前の確認 → 質問 → 報告の順（同じ種類の中は新しい順。BR-70 の開いた行は、3つ以上あるときだけ送る前の確認の中で先） */
  items: z.array(CheckItem),
  running: z.array(RunningItem),
  counts: CheckCounts,
  killSwitch: z.object({ engaged: z.boolean() }),
  /** ?item= で指した行（なければ null。すでにチェック済み・消えているときも null） */
  focus: z.string().nullable(),
});
export type CheckResponse = z.infer<typeof CheckResponse>;

/** GET /api/v1/counts（SCR-020 の入口の件数） */
export const CountsResponse = CheckCounts;
export type CountsResponse = CheckCounts;

/** POST /api/v1/check/:itemId（報告の ○）。承認・質問は 409 CHECK_ITEM_NOT_CHECKABLE */
export const CheckMarkResponse = z.object({ key: z.string(), checkedAt: Iso, counts: CheckCounts });
export type CheckMarkResponse = z.infer<typeof CheckMarkResponse>;

/** GET /api/v1/done?limit=&cursor=（済んだもの。新しい順） */
export const DoneItem = z.object({
  key: z.string(),
  kind: z.enum(["report", "approval"]),
  title: z.string(),
  subtitle: z.string().nullable(),
  /** 承認の行：approved / rejected / expired。報告は null */
  outcome: z.enum(["approved", "rejected", "expired"]).nullable(),
  askId: Id.nullable(),
  doneAt: Iso,
  /** 予定の登録が実行されたときの「カレンダーで開く」のリンク（承認の行だけ。それ以外は null・付けない） */
  calendarLink: z.string().nullable().optional(),
});
export type DoneItem = z.infer<typeof DoneItem>;
export const DoneResponse = z.object({ items: z.array(DoneItem), nextCursor: z.string().nullable() });
export type DoneResponse = z.infer<typeof DoneResponse>;

/** API-016：POST /api/v1/tasks/:taskId/cancel */
export const CancelTaskResponse = z.object({
  taskId: Id,
  status: z.literal("cancelled"),
  /** 取り消した時に期限切れにした送る前の確認の数 */
  expiredApprovals: z.number().int(),
});
export type CancelTaskResponse = z.infer<typeof CancelTaskResponse>;

// ---- SSE（workspace_events の type と data） ----

export const CHECK_EVENT_TYPES = { upsert: "check.upsert", remove: "check.remove", counts: "check.counts" } as const;
export const CheckUpsertEvent = z.object({ item: CheckItem });
export const CheckRemoveEvent = z.object({ key: z.string() });
export const CheckCountsEvent = CheckCounts;

// ---- セッション（EP-01 の応答の拡張。EP-02 の signed_in にも同じ項目） ----

/**
 * POST /api/v1/entry の応答。ゲスト（審査員）は firstAskId に用意した依頼の ID が入り、next は /asks/<firstAskId>（D-69）。
 * オーナーと、Cookie で戻ったとき（既存のセッション）は firstAskId = null・next = "/"（A-102）
 */
export const EntryResponse = z.object({
  state: z.literal("signed_in"),
  workspaceKind: z.enum(["owner", "guest"]),
  next: z.string(),
  /** 最初に開く依頼（SCR-021）。ゲストを作ったときだけ */
  firstAskId: Id.nullable(),
  /** ゲストを今作った（デモ用のデータを入れた）か */
  created: z.boolean(),
});
export type EntryResponse = z.infer<typeof EntryResponse>;

/** GET /api/v1/session（signed_in）。firstAskId は入口の直後だけでなく、用意した依頼の ID を常に返す（画面の「最初の依頼へ」用） */
export const SessionSignedIn = z.object({
  state: z.literal("signed_in"),
  workspaceKind: z.enum(["owner", "guest"]),
  csrfToken: z.string(),
  firstAskId: Id.nullable(),
});
export type SessionSignedIn = z.infer<typeof SessionSignedIn>;
