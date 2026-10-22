// 依頼（asks）の API の契約（API-072〜077 と GET /asks）。リクエスト・レスポンスの zod スキーマと型をここ1か所に置く。
// フロント（apps/web）はこのファイルの型に合わせる。サーバーは routes/asks.ts がここのスキーマで入力を検証し、出力はここの型で組む。
// 約束：日時は ISO 8601（UTC）、金額は円の整数、ID は小文字の uuid。文言のうち「固定の文」（形の1行・段の状態・手が要るもの・汚染の印）は
// サーバーが作って返す（LLM に書かせない。画面はそのまま出す）。変えるときは理由をコミットに書く。
// パスは /api/v1 からの相対：
//   POST /asks                   API-072 依頼を作る（201。生成は裏で進み、SSE の ask.* で届く。Idempotency-Key を受ける）
//   POST /asks/:id/answer        API-073 生成中の質問に答える（200。Idempotency-Key を受ける）
//   POST /asks/:id/resume        API-074 順番の失敗から「やり直す」「ここまでで終える」（200）
//   GET  /asks/:id               API-075 依頼のページ（SCR-021）の表示用ビュー
//   GET  /asks/:id/messages      API-076 連絡板（FR-064。Should）
//   POST /asks/:id/reply         API-077 回答への返事（窓口へのお願い）（202）
//   GET  /asks                   入口（SCR-020）の一覧

import { z } from "zod";

export const ASK_SHAPES = ["single", "parallel", "aggregate", "chain"] as const;
export const AskShapeSchema = z.enum(ASK_SHAPES);
export type AskShape = z.infer<typeof AskShapeSchema>;

export const ASK_STATUSES = ["generating", "running", "waiting_input", "done", "failed", "cancelled"] as const;
export const AskStatusSchema = z.enum(ASK_STATUSES);
export type AskStatus = z.infer<typeof AskStatusSchema>;

/** 生成に失敗した理由（asks.failure_reason）と、画面に出す1行は message */
export const ASK_FAILURE_REASONS = ["formation_invalid", "timeout", "budget_exceeded", "kill_switch", "agent_limit", "planner_error"] as const;
export const AskFailureReasonSchema = z.enum(ASK_FAILURE_REASONS);
export type AskFailureReason = z.infer<typeof AskFailureReasonSchema>;

const Uuid = z.guid();
const Iso = z.string();

// ---- 入力 ----

/** API-072。mention は「@仕入れ係」で担当を指定したとき（担当の ID か名前。先頭の @ は付けても付けなくてもよい） */
export const CreateAskBodySchema = z.strictObject({
  text: z.string().trim().min(1).max(2000),
  mention: z.string().trim().min(1).max(100).optional(),
  /** パックの作業場（/packs/:packId）から出した依頼のとき、そのパックの id。入っているパックだけ（ほかは 400 VALIDATION_ERROR の packId）。設定プランナーはパックの担当を優先して使い回す */
  packId: z.string().trim().min(1).max(100).optional(),
});
export type CreateAskBody = z.infer<typeof CreateAskBodySchema>;

/** API-073。選択肢の id か、自分で書いた文のどちらか一方（選択肢が出ていないときの自由記述は allowFreeText のときだけ） */
export const AnswerAskBodySchema = z
  .strictObject({
    choiceId: z.string().min(1).max(64).optional(),
    text: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((b) => (b.choiceId === undefined) !== (b.text === undefined), { message: "choiceId か text のどちらか一方を指定してください", path: ["choiceId"] });
export type AnswerAskBody = z.infer<typeof AnswerAskBodySchema>;

/** API-074。retry＝止まった段からやり直す、finish＝ここまでで終える */
export const ResumeAskBodySchema = z.strictObject({ action: z.enum(["retry", "finish"]) });
export type ResumeAskBody = z.infer<typeof ResumeAskBodySchema>;

/** API-077。回答への一言（窓口の担当へのお願いとして次の実行に添える） */
export const ReplyAskBodySchema = z.strictObject({ text: z.string().trim().min(1).max(2000) });
export type ReplyAskBody = z.infer<typeof ReplyAskBodySchema>;

/** 担当からの質問（ask_user）に答える。choiceId か text のどちらか（両方なら text を足して送る） */
export const AnswerAgentQuestionBodySchema = z
  .strictObject({ choiceId: z.string().min(1).max(32).optional(), text: z.string().trim().min(1).max(500).optional() })
  .refine((b) => b.choiceId !== undefined || b.text !== undefined, { message: "choiceId か text のどちらかが要る" });
export type AnswerAgentQuestionBody = z.infer<typeof AnswerAgentQuestionBodySchema>;

export const ListAsksQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: AskStatusSchema.optional(),
});
export type ListAsksQuery = z.infer<typeof ListAsksQuerySchema>;

// ---- 部品 ----

export const AskQuestionViewSchema = z.object({
  text: z.string(),
  /** 最大4つ */
  choices: z.array(z.object({ id: z.string(), label: z.string() })).max(4),
  allowFreeText: z.boolean(),
});
export type AskQuestionView = z.infer<typeof AskQuestionViewSchema>;

export const AskTriggerViewSchema = z.object({
  type: z.literal("schedule"),
  cron: z.string(),
  timezone: z.string(),
  /** 「毎日18時」など画面に出す1行（固定の文） */
  label: z.string(),
  /** 次に動く時刻（決まっていなければ null） */
  nextRunAt: Iso.nullable(),
});
export type AskTriggerView = z.infer<typeof AskTriggerViewSchema>;

/** 編成の担当（SCR-020 の「担当の行」・SCR-021 の担当の段の元） */
export const FormationMemberViewSchema = z.object({
  memberId: Uuid,
  agentId: Uuid,
  agentName: z.string(),
  /** 新しく作った担当か、いつもの担当（使い回し）か */
  isNew: z.boolean(),
  /** その担当がすること（1行） */
  summary: z.string(),
  /** 順番の段の番号（1 始まり）。並列・まとめの担当・まとめ役は null のことがある */
  position: z.number().int().nullable(),
  dependsOn: z.array(z.number().int()),
  isAggregator: z.boolean(),
  isSpokesperson: z.boolean(),
});
export type FormationMemberView = z.infer<typeof FormationMemberViewSchema>;

export const FormationViewSchema = z.object({
  shape: AskShapeSchema,
  /** 形の1行（固定の文。ひとりは null） */
  shapeLine: z.string().nullable(),
  members: z.array(FormationMemberViewSchema),
  /** 計画のときに足りなかったもの（つながっていないコネクタなど）。止めずに作った印として出せる */
  notes: z.array(z.string()),
});
export type FormationView = z.infer<typeof FormationViewSchema>;

/**
 * 依頼の文が、接続が要るコネクタを使う言い方か（format.ts の needsConnectionOf。文の語で決まる）。接続の有無は見ない（画面が workspace.google で見る）。
 * "gcal"＝Google カレンダー、"github"＝GitHub（18 §3.6）。当てはまらなければ null
 */
export const NEEDS_CONNECTIONS = ["gcal", "github"] as const;
export const NeedsConnectionSchema = z.enum(NEEDS_CONNECTIONS);
export type NeedsConnection = z.infer<typeof NeedsConnectionSchema>;

export const AskSummarySchema = z.object({
  id: Uuid,
  text: z.string(),
  status: AskStatusSchema,
  shape: AskShapeSchema.nullable(),
  shapeLine: z.string().nullable(),
  trigger: AskTriggerViewSchema.nullable(),
  /** 生成中の質問（status が generating で質問が出ているとき） */
  question: AskQuestionViewSchema.nullable(),
  /** 生成に失敗したとき：理由の種類と、画面に出す1行 */
  failure: z.object({ reason: AskFailureReasonSchema, message: z.string() }).nullable(),
  /** 回答の結論の先頭（一覧用。回答がまだなら null） */
  answerPreview: z.string().nullable(),
  /** 接続が要る言い方のときだけ（ほかは null）。画面は未接続のときだけ「つなぐ」を案内する */
  needsConnection: NeedsConnectionSchema.nullable(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type AskSummary = z.infer<typeof AskSummarySchema>;

// ---- 回答（FR-063） ----

export const AskAnswerViewSchema = z.object({
  /** 1. 結論（窓口の submit_report の本文。並列は Kernel が並べたもの） */
  conclusion: z.string(),
  /** 右上の窓口。並列・Kernel が書いた回答は null */
  spokesperson: z.object({ agentId: Uuid, agentName: z.string() }).nullable(),
  /** 2. 誰が何をしたか（Kernel が差し込む。画面は「{agentName}：{text}」） */
  memberLines: z.array(z.object({ agentName: z.string(), text: z.string(), failed: z.boolean() })),
  /**
   * 3. 手が要るもの。line は「あなたの確認待ち：N件」（0件なら null）、stopped は失敗・止まった担当の名前。
   * declinedLine は送る前の確認で「送らない」にしたものの1行（「あなたが「送らない」にしたもの：1件（送っていません）」。0件なら null：D-108）
   */
  needsYou: z.object({
    pendingApprovals: z.number().int(),
    line: z.string().nullable(),
    stoppedMembers: z.array(z.string()),
    declinedWrites: z.number().int(),
    declinedLine: z.string().nullable(),
  }),
  /** 順番の途中の経過（畳んで出す） */
  intermediate: z.array(z.object({ agentName: z.string(), body: z.string() })),
  /** 「外部の内容をもとにしています（…）」。なければ null */
  taintNote: z.string().nullable(),
  /** 窓口の「次の手の提案」（3つまで）。押すと返事（API-077）としてそのまま頼める。なければ空 */
  nextActions: z.array(z.string()),
  /** 見張り：担当がみな「前回から変化なし」と報告した（画面は1行で静かに出す） */
  unchanged: z.boolean(),
  answeredAt: Iso,
  /** 手が要るものの行を書き換えた時刻 */
  updatedAt: Iso,
});
export type AskAnswerView = z.infer<typeof AskAnswerViewSchema>;

// ---- 担当の段（SCR-021） ----

export const STAGE_STATES = ["waiting", "running", "awaiting_approval", "done", "failed", "stopped"] as const;
export const StageStateSchema = z.enum(STAGE_STATES);
export type StageState = z.infer<typeof StageStateSchema>;

/** 担当の段の「やったこと」の1行（ツールの名詞は manifest、結果は Kernel の判定：決まった文） */
export const StageActivityViewSchema = z.object({
  label: z.string(),
  outcome: z.enum(["done", "approval", "denied", "halted"]),
  at: Iso,
});
export type StageActivityView = z.infer<typeof StageActivityViewSchema>;

export const StageViewSchema = z.object({
  memberId: Uuid,
  agentId: Uuid,
  agentName: z.string(),
  position: z.number().int().nullable(),
  isAggregator: z.boolean(),
  summary: z.string(),
  /** この依頼で新しく作った担当か（ask_members.is_new） */
  isNew: z.boolean(),
  /** 使い回しの1行：新しく作りました／いつもの担当 · 前の依頼 N件でも働きました／いつもの担当 */
  reuseLine: z.string().nullable(),
  /** 画面の状態の分類（色ではなく文字で出す） */
  state: StageStateSchema,
  /** 固定の文：待っています／動いています／済み／確認待ち／失敗：〇〇／止めました */
  stateText: z.string(),
  /** 集約前の実タスク状態。同時稼働とキュー待ちを区別する */
  taskStatus: z.string().nullable().optional(),
  taskId: Uuid.nullable(),
  /** 担当の報告（開いたときに出す）。まだなければ null */
  report: z.object({ title: z.string(), body: z.string() }).nullable(),
  tainted: z.boolean(),
  /** 担当のタスクが動き出した・終わった時刻（経過の表示用。まだなら null） */
  startedAt: Iso.nullable(),
  finishedAt: Iso.nullable(),
  /** やったこと（ツールの呼び出しの判定。新しいものから6件を古い順に） */
  activity: z.array(StageActivityViewSchema),
  /** 作業場で作ったファイル（D-116。GET /tasks/{taskId}/files でダウンロードできる）。なければ null */
  files: z.object({ count: z.number().int(), bytes: z.number().int() }).nullable(),
});
export type StageView = z.infer<typeof StageViewSchema>;

/** 順番の段の間の「渡したもの」 */
export const HandoffViewSchema = z.object({
  fromPosition: z.number().int().nullable(),
  toPosition: z.number().int().nullable(),
  fromAgentName: z.string(),
  toAgentName: z.string(),
  /** 渡した報告のタイトル（なければ「報告」） */
  label: z.string(),
  /** 「外部の内容を含む」（汚染されているときだけ。文字で出す） */
  taintMark: z.string().nullable(),
});
export type HandoffView = z.infer<typeof HandoffViewSchema>;

/** この依頼の「送る前の確認」（承認待ちの Intent。承認・却下は approvals の API） */
export const PendingIntentViewSchema = z.object({
  intentId: Uuid,
  approvalId: Uuid.nullable(),
  taskId: Uuid,
  agentName: z.string(),
  /** '<コネクタ>.<ツール>' */
  action: z.string(),
  /** 承認のときに送り返す値（表示した内容のハッシュ） */
  intentHash: z.string(),
  /** 「受信箱係が読んだメールのあとの送信です」。汚染されていなければ null */
  taintLine: z.string().nullable(),
  createdAt: Iso,
});
export type PendingIntentView = z.infer<typeof PendingIntentViewSchema>;

export const AskRunViewSchema = z.object({
  runId: Uuid,
  runNo: z.number().int(),
  status: z.enum(["running", "waiting_input", "done", "failed", "cancelled"]),
  triggerType: z.enum(["initial", "manual", "schedule", "resume"]),
  startedAt: Iso,
  finishedAt: Iso.nullable(),
});
export type AskRunView = z.infer<typeof AskRunViewSchema>;

/** 画面に出す実行の履歴の上限（古いものは出さない。返事のたびに1つ増える） */
export const ASK_TURN_LIMIT = 20;

/**
 * 頼んだこと → 回答 の1往復（本番の実行1つ分）。依頼のページは古い順に並べ、最後が今の実行（run・answer と同じもの）。
 * kind：ask＝最初の依頼（やり直しも含む）、reply＝回答への返事（「追加で頼む」）、schedule＝定期の実行。
 * text：この実行で担当に渡した文（返事の実行は返事の文。最初・定期は依頼の文。秘密情報はマスク済み）
 */
export const AskTurnViewSchema = z.object({
  runId: Uuid,
  runNo: z.number().int(),
  kind: z.enum(["ask", "reply", "schedule"]),
  text: z.string(),
  status: z.enum(["running", "waiting_input", "done", "failed", "cancelled"]),
  answer: AskAnswerViewSchema.nullable(),
  startedAt: Iso,
  finishedAt: Iso.nullable(),
});
export type AskTurnView = z.infer<typeof AskTurnViewSchema>;

/** 担当から利用者への質問（ask_user）。答えるまで担当は待っている（数分。過ぎたら担当は自分で決めて進む） */
export const AgentQuestionViewSchema = z.object({
  questionId: Uuid,
  agentName: z.string(),
  text: z.string(),
  choices: z.array(z.object({ id: z.string(), label: z.string() })).max(4),
  allowFreeText: z.boolean(),
  createdAt: Iso,
});
export type AgentQuestionView = z.infer<typeof AgentQuestionViewSchema>;

/** 順番待ちの返事（動いている間に送った返事。実行が終わると古い順に始まる）。本文は伏せ字にしたあとのもの */
export const PendingReplyViewSchema = z.object({ id: Uuid, text: z.string(), createdAt: Iso });
export type PendingReplyView = z.infer<typeof PendingReplyViewSchema>;

/** API-075：SCR-021 の表示用ビュー */
export const AskDetailResponseSchema = z.object({
  ask: AskSummarySchema,
  /** 頼んだ文の下の1行用（形・トリガー）は ask.shapeLine・ask.trigger。生成前（generating）は null */
  formation: FormationViewSchema.nullable(),
  /** 本番の最新の実行。まだ動いていなければ null */
  run: AskRunViewSchema.nullable(),
  /** 回答。まだなら null（answerPending に「〇〇がまとめています」の窓口の名前） */
  answer: AskAnswerViewSchema.nullable(),
  answerPending: z.object({ spokespersonName: z.string().nullable() }).nullable(),
  /** 頼んだこと → 回答 の履歴（古い順。最後が run・answer と同じ今の実行。ASK_TURN_LIMIT 件まで。まだ動いていなければ空） */
  turns: z.array(AskTurnViewSchema),
  /** 担当の段（順番は段の順、並列・まとめは担当、まとめ役は最後） */
  stages: z.array(StageViewSchema),
  /** 順番の段の間の「渡したもの」 */
  handoffs: z.array(HandoffViewSchema),
  /** 送る前の確認 */
  pendingIntents: z.array(PendingIntentViewSchema),
  /** 担当が答えを待っている質問（ask_user。まだ答えていないものだけ） */
  agentQuestions: z.array(AgentQuestionViewSchema),
  /** 順番待ちの返事（まだ始まっていないもの。古い順） */
  pendingReplies: z.array(PendingReplyViewSchema),
  /** 順番の失敗のとき：[やり直す] [ここまでで終える] を出す（API-074）。止まった担当の名前と理由 */
  resume: z.object({ agentName: z.string(), reason: z.string() }).nullable(),
  /** 連絡板の通数（Should。ひとりは 0） */
  messageCount: z.number().int(),
  /** 編成を作った Gemini の呼び出し（モデル・回数・合計の時間と費用）。用意した依頼（呼んでいない）は null */
  planner: z.object({ model: z.string(), calls: z.number().int(), latencyMs: z.number().int(), costUsd: z.string() }).nullable(),
});
export type AskDetailResponse = z.infer<typeof AskDetailResponseSchema>;

export const ListAsksResponseSchema = z.object({ asks: z.array(AskSummarySchema) });
export type ListAsksResponse = z.infer<typeof ListAsksResponseSchema>;

/** API-072（201）・073（200）・077（202）の応答：依頼。生成・実行の結果は SSE で届く */
export const AskAcceptedResponseSchema = z.object({
  ask: AskSummarySchema,
  /** API-077 のみ：動いている間の返事は順番待ちになった（true）。終わると自動で始まる */
  queued: z.boolean().optional(),
});
export type AskAcceptedResponse = z.infer<typeof AskAcceptedResponseSchema>;

/** API-074 の応答 */
export const ResumeAskResponseSchema = z.object({ ask: AskSummarySchema });
export type ResumeAskResponse = z.infer<typeof ResumeAskResponseSchema>;

// ---- 連絡板（FR-064。Should） ----

export const AskMessageViewSchema = z.object({
  id: Uuid,
  fromAgentName: z.string(),
  /** 全員宛ては null */
  toAgentName: z.string().nullable(),
  kind: z.enum(["share", "question", "reply", "revise"]),
  body: z.string(),
  inReplyTo: Uuid.nullable(),
  /** 送った側が汚染されていた（行末に「外部の内容を含む」） */
  tainted: z.boolean(),
  createdAt: Iso,
});
export type AskMessageView = z.infer<typeof AskMessageViewSchema>;
export const ListAskMessagesResponseSchema = z.object({ messages: z.array(AskMessageViewSchema) });
export type ListAskMessagesResponse = z.infer<typeof ListAskMessagesResponseSchema>;

// ---- SSE の事象（workspace_events。type は ask.* ） ----
// data の形はすべて askId を持つ。画面は askId で該当の依頼を引き直す（GET /asks/:id）か、data をそのまま使う。

export const ASK_EVENT_TYPES = [
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
  "ask.agent_question",
  "ask.reply.queue",
] as const;
export type AskEventType = (typeof ASK_EVENT_TYPES)[number];

export type AskEventData =
  | { type: "ask.created"; askId: string; text: string; status: "generating" }
  | { type: "ask.question"; askId: string; question: AskQuestionView }
  /** 編成ができた。SCR-020 は members を1行ずつ出して shapeLine を最後に出す */
  | { type: "ask.formed"; askId: string; formation: FormationView; trigger: AskTriggerView | null }
  | { type: "ask.failed"; askId: string; reason: AskFailureReason; message: string }
  | { type: "ask.status"; askId: string; status: AskStatus }
  | { type: "ask.step.started"; askId: string; runId: string; memberId: string; agentName: string; taskId: string; position: number | null }
  | { type: "ask.step.finished"; askId: string; runId: string; memberId: string; agentName: string; taskId: string; state: StageState; stateText: string }
  | { type: "ask.answered"; askId: string; runId: string; answer: AskAnswerView }
  | { type: "ask.answer.updated"; askId: string; runId: string; answer: AskAnswerView }
  | { type: "ask.message.posted"; askId: string; message: AskMessageView }
  /** 担当からの質問が出た（posted）・答えた（answered）・待ちを終えた（expired） */
  | { type: "ask.agent_question"; askId: string; questionId: string; status: "posted" | "answered" | "expired" }
  /** 順番待ちの返事が入った（queued）・始まった（started）。画面は取り直して会話の末尾を直す */
  | { type: "ask.reply.queue"; askId: string; replyId: string; status: "queued" | "started" };
