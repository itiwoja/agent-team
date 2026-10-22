// エージェントの一覧（ライブラリ）の API の契約（API-041 の v0.5 版。SCR-014「エージェント一覧」）。
// フロント（apps/web）はこのファイルの型に合わせる。固定の文（役割・状態・仕事の種類の1行）はサーバーが作って返す（LLM に書かせない）。
// パスは /api/v1 からの相対：
//   GET /agents                  一覧（viewer 以上。removed は出さない。最後に動いた順）
//   POST /agents/{agentId}/skill-proposals/{proposalId}/decide   スキルの案を決める（owner・maintainer）
//   POST /agents/{agentId}/evolution/{eventId}/restore           整理で外したものを戻す（owner・maintainer）

import { z } from "zod";

const Uuid = z.guid();
const Iso = z.string();

export const AGENT_LIST_LIMITS = {
  /** 一覧に畳んで出す「関わった依頼」の数（担当ごと） */
  asksPerAgent: 5,
} as const;

/** 担当の状態（agents.status。removed は一覧に出ない） */
export const AGENT_VIEW_STATUSES = ["idle", "active", "invalid", "disabled"] as const;
export const AgentViewStatusSchema = z.enum(AGENT_VIEW_STATUSES);
export type AgentViewStatus = z.infer<typeof AgentViewStatusSchema>;

/** 一覧の「いまの様子」（本番のタスクから。色ではなく文字で出す） */
export const AGENT_ACTIVITY_STATES = ["running", "awaiting_approval", "disabled", "idle"] as const;
export const AgentActivityStateSchema = z.enum(AGENT_ACTIVITY_STATES);
export type AgentActivityState = z.infer<typeof AgentActivityStateSchema>;

export const AgentAskViewSchema = z.object({
  askId: Uuid,
  /** 頼んだ文（秘密情報はマスク済み） */
  text: z.string(),
  status: z.enum(["generating", "running", "waiting_input", "done", "failed", "cancelled"]),
  /** その依頼でこの担当がすること（編成の1行） */
  summary: z.string(),
  /** この依頼で新しく生まれた担当か */
  isNew: z.boolean(),
  isSpokesperson: z.boolean(),
  isAggregator: z.boolean(),
  position: z.number().int().nullable(),
  createdAt: Iso,
});
export type AgentAskView = z.infer<typeof AgentAskViewSchema>;

export const AgentJobViewSchema = z.object({
  jobId: Uuid,
  kind: z.enum(["once", "recurring", "watch"]),
  /** 「1回」「定期」「見張り」（固定の文） */
  kindLabel: z.string(),
  template: z.enum(["researcher", "briefer", "watcher", "assistant", "dev-coder", "reviewer"]),
  /** 「調べる」「まとめる」「見張る」「手伝う」（固定の文） */
  templateLabel: z.string(),
  status: z.enum(["waiting_input", "active", "paused", "done"]),
  createdAt: Iso,
});
export type AgentJobView = z.infer<typeof AgentJobViewSchema>;

/** 担当の成長（引き継がれて積み上がったもの）の数 */
export const AgentGrowthSchema = z.object({
  /** 使い回された依頼の数 */
  reuseCount: z.number().int(),
  /** 「以後も許可」にしたルールの数 */
  allowedRuleCount: z.number().int(),
  /** スキルの数 */
  skillCount: z.number().int(),
});
export type AgentGrowth = z.infer<typeof AgentGrowthSchema>;

/** 担当のスキル（外していないもの）。origin：pack＝パックから、learned＝使い込んで育って、人が ○ を押したもの */
export const AgentSkillViewSchema = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string(),
  origin: z.enum(["pack", "learned"]),
  /** 本番のタスクで最後に読まれた時刻（まだなら null） */
  lastUsedAt: Iso.nullable(),
  createdAt: Iso,
});
export type AgentSkillView = z.infer<typeof AgentSkillViewSchema>;

/** スキルの案（まだ決めていないもの）。body は Markdown の手順書 */
export const SkillProposalViewSchema = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string(),
  body: z.string(),
  reason: z.string().nullable(),
  createdAt: Iso,
});
export type SkillProposalView = z.infer<typeof SkillProposalViewSchema>;

/** 整理で外したもの（スキル・ルール）。restoredAt があれば戻し済み */
export const PrunedItemViewSchema = z.object({
  type: z.enum(["skill", "rule"]),
  id: z.string(),
  label: z.string(),
  restoredAt: Iso.nullable(),
});
export type PrunedItemView = z.infer<typeof PrunedItemViewSchema>;

/** 整理の1回（30日以内。新しい順）。戻すときは eventId と items の (type, id) */
export const PrunedEventViewSchema = z.object({
  eventId: Uuid,
  createdAt: Iso,
  items: z.array(PrunedItemViewSchema),
});
export type PrunedEventView = z.infer<typeof PrunedEventViewSchema>;

export const AgentLibraryItemSchema = z.object({
  id: Uuid,
  name: z.string(),
  /** 名前を付けたのは誰か（user＝自分、suggested＝設定プランナー） */
  nameSource: z.enum(["user", "suggested"]),
  role: z.enum(["research", "watch", "brief", "assist", "dev"]).nullable(),
  /** 役割の1行（「調べる係」など。役割がなければ null） */
  roleLabel: z.string().nullable(),
  status: AgentViewStatusSchema,
  /** いまの様子の分類と固定の文（動いています／確認待ち／止めています／待機中） */
  activity: AgentActivityStateSchema,
  activityText: z.string(),
  /** 停止中の理由（status が disabled のときだけ） */
  disabledReason: z.string().nullable(),
  jobCount: z.number().int(),
  askCount: z.number().int(),
  /** 本番のタスクの数（試し実行は数えない） */
  taskCount: z.number().int(),
  lastActiveAt: Iso.nullable(),
  createdAt: Iso,
  /** この担当が生まれた依頼（ask_members.is_new の依頼。用意した担当・手で作った担当は null） */
  bornAskId: Uuid.nullable(),
  growth: AgentGrowthSchema,
  /** 成長の1行（「使い回し 4回 · 以後も許可 2件 …」。0 の項目は出さず、全部 0 なら null） */
  growthLine: z.string().nullable(),
  /** 関わった依頼（新しい順、asksPerAgent 件まで） */
  asks: z.array(AgentAskViewSchema),
  jobs: z.array(AgentJobViewSchema),
  /** スキル（外していないもの。名前の順） */
  skills: z.array(AgentSkillViewSchema),
  /** スキルの案（proposed のみ。新しい順） */
  skillProposals: z.array(SkillProposalViewSchema),
  /** 30日以内に整理で外したもの（新しい順） */
  pruned: z.array(PrunedEventViewSchema),
});
export type AgentLibraryItem = z.infer<typeof AgentLibraryItemSchema>;

export const AgentLibraryResponseSchema = z.object({
  items: z.array(AgentLibraryItemSchema),
  /** ワークスペースの担当の上限（A-81）と、いまの数（removed を除く） */
  limit: z.number().int(),
  count: z.number().int(),
});
export type AgentLibraryResponse = z.infer<typeof AgentLibraryResponseSchema>;

// POST /agents/{agentId}/workspace/reset（owner・maintainer。SG-07 の最終監査の直し）：担当の作業場を最初に戻す。
// パックから入った担当はパックのファイル、そうでなければ空。Kill Switch 中は 423、その担当の動いているタスクが作業場を開いていれば 409（WORKSPACE_IN_USE）
export const ResetAgentWorkspaceResponseSchema = z.object({
  agentId: Uuid,
  /** 足した控え（source = 'reset'・汚染なし） */
  snapshotId: Uuid,
  /** 戻した先：パックのファイルか空 */
  origin: z.enum(["pack", "empty"]),
  /** 戻したあとの作業場のファイル */
  files: z.array(z.string()),
  resetAt: Iso,
});
export type ResetAgentWorkspaceResponse = z.infer<typeof ResetAgentWorkspaceResponseSchema>;

// POST /agents/{agentId}/skill-proposals/{proposalId}/decide：approve で担当のスキルになる（信頼される）、reject で却下。決めた案は二度と決められない
export const DecideSkillProposalBodySchema = z.strictObject({ decision: z.enum(["approve", "reject"]) });
export type DecideSkillProposalBody = z.infer<typeof DecideSkillProposalBodySchema>;
export const DecideSkillProposalResponseSchema = z.object({
  proposalId: Uuid,
  status: z.enum(["approved", "rejected"]),
  /** approve のとき作ったスキルの ID（reject は null） */
  skillId: Uuid.nullable(),
});
export type DecideSkillProposalResponse = z.infer<typeof DecideSkillProposalResponseSchema>;

// POST /agents/{agentId}/evolution/{eventId}/restore：外したスキル・ルール1件を戻す
export const RestoreEvolutionBodySchema = z.strictObject({ type: z.enum(["skill", "rule"]), id: z.string().min(1).max(128) });
export type RestoreEvolutionBody = z.infer<typeof RestoreEvolutionBodySchema>;
export const RestoreEvolutionResponseSchema = z.object({
  eventId: Uuid,
  type: z.enum(["skill", "rule"]),
  id: z.string(),
  restoredAt: Iso,
});
export type RestoreEvolutionResponse = z.infer<typeof RestoreEvolutionResponseSchema>;
