// 依頼の編成の検査（FR §3.3 validateFormation）・回答1つ（FR §3.7 composeAnswer、FR-063）・形の1行（shapeLine：entrance.md:91-96）
// LLM（設定プランナー）の編成案をそのまま信じない（agents.md:208-214）。違反はすべて返して、プランナーに一度に直させる（FR §8-34）
// 段の番号（position・dependsOn）は 1 始まりの number（M-34）。回答の Kernel の行は固定の文で作り、LLM に書かせない（agents.md:270、D-74）

import { hashCanonical } from "./canonical.ts";
import { answerTaintLine, isTainted } from "./taint.ts";
import type { Hex64, TaintSource, TaintState, TaskStatus, Uuid } from "./types.ts";

/** 形（glossary.md:104）：ひとり・並列・まとめ・順番 */
export const SHAPES = ["single", "parallel", "aggregate", "chain"] as const;
export type Shape = (typeof SHAPES)[number];

/** agents.status（st:86-93 ＋ D-20 の idle） */
export const AGENT_STATUSES = ["idle", "active", "invalid", "disabled", "removed"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** 0-H で編成の担当に使ってよいテンプレート（FR §8-1。受信箱係 researcher、仕入れ係 assistant、まとめ役 briefer） */
// watcher（見張り：前回と比べて変化を知らせる。書き込みを持たない：BR-40）は 10/14 から編成で使う
// dev-coder・reviewer（実装：作業場で書いて動かす。D-116）は 10/14 から編成で使う
export const FORMATION_TEMPLATES_0H = ["researcher", "briefer", "assistant", "watcher", "dev-coder", "reviewer"] as const;

/** 編成の上限（FR §2.1。仮の値は実機で決め直す：v12:6） */
export const FORMATION_LIMITS = {
  minMembers: 1, // agents.md:209（まとめ役を除く）
  maxMembers: 5, // A-99
  maxChainStages: 4, // A-99（順番の段の深さ。同時に動く担当は同じ段に数える）
  aggregateMinMembers: 2,
  aggregateMaxMembers: 5,
  aggregatorCount: 1,
  maxAgentsPerWorkspace: 20, // A-81
  maxJobsPerAgent: 10, // A-81
  nameMaxChars: 40, // 定義 v1 の name 1〜40文字（policy-and-schema.md:132）
  plannerMaxAttempts: 3, // agents.md:190
  generationTimeoutMs: 30_000, // A-98
  thinkingNoticeAfterMs: 10_000,
  formationShowMs: 3_000, // A-97
  aggregatorWaitMs: 30 * 60_000, // A-100
  questionMax: 1, // BR-49
  questionChoicesMax: 4, // A-93
} as const;
export type FormationLimits = { -readonly [K in keyof typeof FORMATION_LIMITS]: number };

/** 編成案の担当（FR §2.3 ProposedMember のうち validateFormation が読む部分。全体の形は app の Zod が持つ） */
export interface ProposedMember {
  agent: { kind: "existing"; agentId: Uuid } | { kind: "new"; name: string; role?: string | null };
  /** 1 始まりの段の番号（M-34） */
  position: number;
  /** 順番で結果を受け取る前の段の position（M-34）。前の段の結果が要らない担当は空にして、同時に始める */
  dependsOn: readonly number[];
  isSpokesperson: boolean;
  job: { template: string; deliver: ReadonlyArray<{ to: string }> };
  grantsNeeded: { connectors: Readonly<Record<string, readonly string[]>> };
}
/** 設定プランナーの編成案（FR §2.3 FormationProposal のうち validateFormation が読む部分）。rules などは Zod の strict で先に落とす */
export interface FormationProposal {
  shape: Shape;
  /** まとめ役を含めない */
  members: readonly ProposedMember[];
  /** aggregate のときだけ */
  aggregator?: ProposedMember | null;
}

export const FORMATION_VIOLATION_CODES = [
  "PROPOSAL_SCHEMA_INVALID",
  "SHAPE_MEMBER_COUNT",
  "CHAIN_TOO_LONG",
  "AGGREGATOR_MISSING",
  "AGGREGATOR_NOT_ALLOWED",
  "POSITION_INVALID",
  "DEPENDS_ON_INVALID",
  "AGENT_NOT_IN_WORKSPACE",
  "AGENT_NOT_USABLE",
  "AGENT_DUPLICATED",
  "AGGREGATOR_HAS_WRITE",
  "AGENT_LIMIT",
  "JOB_LIMIT",
  "SPOKESPERSON_INVALID",
  "NAME_INVALID",
  "NAME_CONFLICT",
  "MENTION_MISMATCH",
  "TEMPLATE_NOT_ALLOWED",
] as const;
export type FormationViolationCode = (typeof FORMATION_VIOLATION_CODES)[number];
export interface FormationViolation {
  code: FormationViolationCode;
  /** どの担当か（まとめ役はその position） */
  position?: number;
  /** プランナーに添える理由（固定の文） */
  detail?: string;
}
export type ValidateFormationResult = { ok: true } | { ok: false; violations: FormationViolation[] };

export interface ValidateFormationInput {
  proposal: FormationProposal;
  workspace: {
    /** removed の行も含めて渡す（名前の重なりを見るため。数には入れない） */
    agents: ReadonlyArray<{ agentId: Uuid; name: string; status: AgentStatus; jobCount: number; hasConnectorGrants: boolean }>;
  };
  /** 「@仕入れ係」で担当を指定した依頼 */
  mention: { agentId: Uuid } | null;
  /** テンプレート → LLM が書き込みを呼べるか（KC の TEMPLATES の mcpLlm = read_write） */
  templates: Readonly<Record<string, { canWriteByLlm: boolean; tools?: readonly string[] }>>;
  /** 既定 FORMATION_TEMPLATES_0H */
  allowedTemplates?: readonly string[];
  limits?: Partial<FormationLimits>;
}

/** 名前の正規化（FR §3.3 V10：NFKC・前後の空白を除く・英字は小文字） */
export function normalizeAgentName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sameNumberSet(a: readonly unknown[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => Number(p) - Number(q));
  const y = [...b].sort((p, q) => p - q);
  return x.every((v, k) => v === y[k]);
}

/**
 * 編成案の検査（FR §3.3 V1〜V12、agents.md:208-214）。すべての項目を調べ、違反をすべて返す。
 * V1 人数 1〜5／V2 形ごとの人数（single 1・chain 2〜5（段の深さは4まで）・parallel 2〜5・aggregate 2〜5）／V3 まとめ役の有無／
 * V4 段の番号と依存（chain は前の段だけを指し、どの担当も最後の段につながる）／V5 担当の参照／V6 まとめ役は書き込みを持たない（BR-72）／V7 エージェント20体／V8 仕事10個／
 * V9 窓口がちょうど1つ（並列は0）／V10 新しい名前／V11 担当の指定（mention）／V12 0-H のテンプレート
 */
export function validateFormation(input: ValidateFormationInput): ValidateFormationResult {
  // 差し替えは有限の数だけ（undefined・NaN で比較が素通りしないように）
  const limits: FormationLimits = { ...FORMATION_LIMITS };
  for (const [k, v] of Object.entries(input.limits ?? {})) {
    if (Object.hasOwn(FORMATION_LIMITS, k) && typeof v === "number" && Number.isFinite(v)) limits[k as keyof FormationLimits] = v;
  }
  const p = input.proposal as unknown;
  // Zod の前の保険：形が分からない・担当が配列でない案は、ほかを調べられない
  if (!isObject(p) || !(SHAPES as readonly unknown[]).includes(p.shape) || !Array.isArray(p.members)) {
    return { ok: false, violations: [{ code: "PROPOSAL_SCHEMA_INVALID", detail: "編成案の形が読めない" }] };
  }
  const proposal = input.proposal;
  const shape = proposal.shape;
  const members = proposal.members;
  const aggregator = proposal.aggregator ?? null;
  const n = members.length;
  const violations: FormationViolation[] = [];
  const seen = new Set<string>();
  const add = (code: FormationViolationCode, position?: number, detail?: string) => {
    const key = JSON.stringify([code, position ?? null, detail ?? null]);
    if (seen.has(key)) return;
    seen.add(key);
    const v: FormationViolation = { code };
    if (position !== undefined && Number.isFinite(position)) v.position = position;
    if (detail !== undefined) v.detail = detail;
    violations.push(v);
  };
  const participants: Array<{ m: ProposedMember; isAggregator: boolean }> = [
    ...members.map((m) => ({ m, isAggregator: false })),
    ...(aggregator === null ? [] : [{ m: aggregator, isAggregator: true }]),
  ];
  for (const { m } of participants) {
    if (!isObject(m) || !isObject(m.agent) || !isObject(m.job) || !isObject(m.grantsNeeded)) {
      return { ok: false, violations: [{ code: "PROPOSAL_SCHEMA_INVALID", detail: "担当の形が読めない" }] };
    }
  }

  // V1・V2 人数（同じ違反は1つにまとめる）
  const countDetail = `${shape} に担当 ${n}人`;
  if (n < limits.minMembers || n > limits.maxMembers) add("SHAPE_MEMBER_COUNT", undefined, countDetail);
  if (shape === "single" && n !== 1) add("SHAPE_MEMBER_COUNT", undefined, countDetail);
  if (shape === "chain" && n < 2) add("SHAPE_MEMBER_COUNT", undefined, countDetail); // 下限2は FR §3.3 V2 の提案
  if (shape === "parallel" && (n < 2 || n > limits.maxMembers)) add("SHAPE_MEMBER_COUNT", undefined, countDetail);
  if (shape === "aggregate" && (n < limits.aggregateMinMembers || n > limits.aggregateMaxMembers)) {
    add("SHAPE_MEMBER_COUNT", undefined, countDetail);
  }

  // V3 まとめ役の有無
  if (shape === "aggregate" && aggregator === null) add("AGGREGATOR_MISSING");
  if (shape !== "aggregate" && aggregator !== null) add("AGGREGATOR_NOT_ALLOWED", aggregator.position);

  // V4 段の番号：担当は 1..n の重複なし。依存：chain は自分より前の段だけ（1段目と、前の結果が要らない担当は []）、ほかの担当は []、まとめ役は n+1 で全担当に依存
  const counts = new Map<number, number>();
  for (const m of members) counts.set(m.position, (counts.get(m.position) ?? 0) + 1);
  for (const m of members) {
    const pos = m.position;
    if (typeof pos !== "number" || !Number.isInteger(pos) || pos < 1 || pos > n) add("POSITION_INVALID", pos, `段の番号は 1〜${n}`);
    else if ((counts.get(pos) ?? 0) > 1) add("POSITION_INVALID", pos, "段の番号が重なっている");
  }
  const memberPositions = new Set(members.map((m) => m.position));
  for (const m of members) {
    const deps: readonly unknown[] | null = Array.isArray(m.dependsOn) ? m.dependsOn : null;
    if (deps === null) {
      add("DEPENDS_ON_INVALID", m.position, "dependsOn が配列でない");
      continue;
    }
    if (deps.some((d) => typeof d !== "number" || !memberPositions.has(d))) add("DEPENDS_ON_INVALID", m.position, "編成にない段を指している");
    if (shape === "chain") {
      if (deps.some((d) => typeof d === "number" && d >= m.position)) add("DEPENDS_ON_INVALID", m.position, "順番は前の段だけに依存する");
      if (new Set(deps).size !== deps.length) add("DEPENDS_ON_INVALID", m.position, "同じ段を2回指している");
    } else if (deps.length > 0) {
      add("DEPENDS_ON_INVALID", m.position, "この形の担当は依存を持たない");
    }
  }
  if (shape === "chain" && n >= 2 && !violations.some((v) => v.code === "POSITION_INVALID" || v.code === "DEPENDS_ON_INVALID")) {
    // 段の深さ（同時に動く担当は同じ段）と、どの担当の結果も最後の段（窓口）まで届くか
    const byPos = new Map(members.map((m) => [m.position, m]));
    const depth = new Map<number, number>();
    for (const pos of [...byPos.keys()].sort((a, b) => a - b)) {
      depth.set(pos, 1 + Math.max(0, ...byPos.get(pos)!.dependsOn.map((d) => depth.get(d) ?? 0)));
    }
    const deepest = Math.max(...depth.values());
    if (deepest > limits.maxChainStages) add("CHAIN_TOO_LONG", undefined, `順番は${limits.maxChainStages}段まで（${deepest}段）`);
    const reach = new Set<number>([n]);
    for (let pos = n; pos >= 1; pos -= 1) if (reach.has(pos)) for (const d of byPos.get(pos)!.dependsOn) reach.add(d);
    for (const pos of [...byPos.keys()].sort((a, b) => a - b)) {
      if (!reach.has(pos)) add("DEPENDS_ON_INVALID", pos, "この担当の結果が最後の段に届かない");
    }
  }
  if (aggregator !== null && shape === "aggregate") {
    if (aggregator.position !== n + 1) add("POSITION_INVALID", aggregator.position, `まとめ役の段の番号は ${n + 1}`);
    const deps: readonly unknown[] = Array.isArray(aggregator.dependsOn) ? aggregator.dependsOn : [Number.NaN];
    if (!sameNumberSet(deps, [...memberPositions].filter((x): x is number => typeof x === "number"))) {
      add("DEPENDS_ON_INVALID", aggregator.position, "まとめ役は全担当に依存する");
    }
  }

  // V5 担当の参照・V8 仕事の数
  const byId = new Map(input.workspace.agents.map((a) => [a.agentId, a]));
  const usedIds = new Set<string>();
  for (const { m } of participants) {
    if (m.agent.kind !== "existing") continue;
    const id = m.agent.agentId;
    if (usedIds.has(id)) add("AGENT_DUPLICATED", m.position, "同じ担当が2回出ている");
    usedIds.add(id);
    const a = byId.get(id);
    if (a === undefined) {
      add("AGENT_NOT_IN_WORKSPACE", m.position);
      continue;
    }
    if (a.status !== "idle" && a.status !== "active") add("AGENT_NOT_USABLE", m.position, `状態が ${a.status}`);
    if (!Number.isFinite(a.jobCount) || a.jobCount + 1 > limits.maxJobsPerAgent) {
      add("JOB_LIMIT", m.position, `仕事は1体${limits.maxJobsPerAgent}個まで`);
    }
  }

  // V6 まとめ役は書き込みのツール・コネクタを持たない（BR-72。読み取りの付与も持たない）
  if (aggregator !== null) {
    const pos = aggregator.position;
    const name = aggregator.job.template;
    const tpl = Object.hasOwn(input.templates, name) ? input.templates[name] : undefined;
    // 知らないテンプレートは書き込めるものとして扱う（厳しい側）
    if (tpl === undefined || tpl.canWriteByLlm !== false) add("AGGREGATOR_HAS_WRITE", pos, "書き込みを呼べるテンプレート");
    const connectors: unknown = aggregator.grantsNeeded.connectors;
    if (connectors !== undefined && connectors !== null && (typeof connectors !== "object" || Object.keys(connectors).length > 0)) {
      add("AGGREGATOR_HAS_WRITE", pos, "コネクタの付与");
    }
    const deliver = Array.isArray(aggregator.job.deliver) ? aggregator.job.deliver : [];
    if (deliver.some((d) => typeof d?.to !== "string" || d.to.startsWith("mcp."))) add("AGGREGATOR_HAS_WRITE", pos, "MCP の届け先");
    if (aggregator.agent.kind === "existing" && byId.get(aggregator.agent.agentId)?.hasConnectorGrants === true) {
      add("AGGREGATOR_HAS_WRITE", pos, "使い回す担当にコネクタの付与がある");
    }
  }

  // V7 エージェントの数（removed は数えない）
  const living = input.workspace.agents.filter((a) => a.status !== "removed").length;
  const created = participants.filter(({ m }) => m.agent.kind === "new").length;
  if (living + created > limits.maxAgentsPerWorkspace) add("AGENT_LIMIT", undefined, `エージェントは${limits.maxAgentsPerWorkspace}体まで`);

  // V9 窓口：single は担当、chain は最後の段、aggregate はまとめ役、parallel はなし
  const sorted = [...members].sort((x, y) => x.position - y.position);
  const expectedSpokesperson = (m: ProposedMember, isAggregator: boolean): boolean => {
    switch (shape) {
      case "single":
        return !isAggregator && m === sorted[0];
      case "chain":
        return !isAggregator && m === sorted[sorted.length - 1];
      case "aggregate":
        return isAggregator;
      default:
        return false;
    }
  };
  for (const { m, isAggregator } of participants) {
    if ((m.isSpokesperson === true) !== expectedSpokesperson(m, isAggregator)) add("SPOKESPERSON_INVALID", m.position);
  }

  // V10 新しい担当の名前（正規化して、空・41文字以上・既存（removed も含む）・同じ編成の新しい担当と重なる）
  const existingNames = new Set(input.workspace.agents.map((a) => normalizeAgentName(a.name)));
  const newNames = new Set<string>();
  for (const { m } of participants) {
    if (m.agent.kind !== "new") continue;
    const raw = m.agent.name;
    if (typeof raw !== "string") {
      add("NAME_INVALID", m.position, "名前がない");
      continue;
    }
    const name = normalizeAgentName(raw);
    if (name === "" || [...name].length > limits.nameMaxChars) {
      add("NAME_INVALID", m.position, `名前は1〜${limits.nameMaxChars}文字`);
      continue;
    }
    if (existingNames.has(name) || newNames.has(name)) add("NAME_CONFLICT", m.position, `「${raw.trim()}」はもうある`);
    newNames.add(name);
  }

  // V11 担当の指定：ひとりで、その担当を使い回す
  if (input.mention !== null) {
    const first = members[0];
    const ok = shape === "single" && first !== undefined && first.agent.kind === "existing" && first.agent.agentId === input.mention.agentId;
    if (!ok) add("MENTION_MISMATCH", undefined, "指定された担当だけで「ひとり」にする");
  }

  // V12 テンプレート
  const allowed = input.allowedTemplates ?? FORMATION_TEMPLATES_0H;
  for (const { m } of participants) {
    if (!allowed.includes(m.job.template)) add("TEMPLATE_NOT_ALLOWED", m.position, `使えるのは ${allowed.join("・")}`);
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/**
 * 順番の段（同時に動く担当を同じ段にまとめる）。段の深さは「依存する段のうち一番深いもの + 1」。
 * dependsOn がない担当は、前の段に依存するもの（従来の1段ずつ）として扱う。段の中は position の順
 */
export function chainStages<T extends { position: number; dependsOn?: readonly number[] }>(members: readonly T[]): T[][] {
  const sorted = [...members].sort((a, b) => a.position - b.position);
  const depth = new Map<number, number>();
  sorted.forEach((m, i) => {
    const deps = m.dependsOn ?? (i === 0 ? [] : [sorted[i - 1]!.position]);
    depth.set(m.position, 1 + Math.max(0, ...deps.map((d) => depth.get(d) ?? 0)));
  });
  const stages: T[][] = [];
  for (const m of sorted) {
    const d = depth.get(m.position)! - 1;
    (stages[d] ??= []).push(m);
  }
  return stages.filter((g) => g !== undefined);
}

/**
 * 形の1行（entrance.md:91-96、FR §2.9。固定の文で LLM に書かせない：entrance.md:110）。single は null。
 * 担当は position の順に並べ、まとめ役は数えない（UI E20-11・12）。順番で同時に動く担当は「・」でつなぐ
 */
export function shapeLine(
  shape: Shape,
  members: ReadonlyArray<{ agentName: string; position: number; isAggregator?: boolean; dependsOn?: readonly number[] }>,
): string | null {
  const ms = members.filter((m) => m.isAggregator !== true);
  switch (shape) {
    case "parallel":
      return `${ms.length}人がそれぞれ動いて、答えを1つにして届けます`;
    case "aggregate":
      return `${ms.length}人が調べて、まとめ役が1つにして届けます`;
    case "chain": {
      const stages = chainStages(ms);
      const last = stages[stages.length - 1]?.at(-1)?.agentName;
      if (last === undefined) return null;
      const flow = stages.map((g) => g.map((m) => m.agentName).join("・")).join(" → ");
      const together = stages.filter((g) => g.length > 1).map((g) => g.map((m) => m.agentName).join("と"));
      return together.length === 0
        ? `${flow} の順に進めて、${last}が答えます`
        : `${flow} の順に進めて（${together.join("、")}は同時に動きます）、${last}が答えます`;
    }
    default:
      return null;
  }
}

// ここから連絡板（FR-064・BR-73〜77。Should）：連絡を受け付けてよいかの検査（FR §3.13 validateTeamMessage）

/** 連絡の種類（FR §2.1 TeamMessageKind、ag:303-308）。runner の型の revise_request は edge がこの revise に対応づける */
export const TEAM_MESSAGE_KINDS = ["share", "question", "reply", "revise"] as const;
export type TeamMessageKind = (typeof TEAM_MESSAGE_KINDS)[number];

/** 連絡板の上限（FR §2.1 TEAM_LIMITS。BR-77：br:260、A-103〜105：ag:339-341） */
export const TEAM_LIMITS = {
  messagesPerAsk: 20, // 1依頼の連絡は20通
  questionsPerPair: 3, // 同じ2体の間の question は3往復（向きを問わない）
  revisePerMember: 1, // 作り直しの依頼は担当ごとに1回（まとめ役からだけ）
  bodyMaxChars: 2_000, // 本文（コードポイントで数える）
  waitMaxSec: 300, // team_wait の待ち時間（A-104）
  followupTurns: 1, // 追いのターンは1ターン（reply を1通。A-105）
} as const;

/** 連絡を断る理由（FR §2.8。名前は FR の提案） */
export const TEAM_MESSAGE_REJECT_REASONS = [
  "board_closed",
  "single_shape",
  "recipient_not_in_ask",
  "recipient_stopped",
  "kind_not_allowed_for_shape",
  "reply_target_invalid",
  "revise_not_from_aggregator",
  "ask_message_limit",
  "question_pair_limit",
  "revise_limit",
  "body_too_long",
  "body_empty",
] as const;
export type TeamMessageRejectReason = (typeof TEAM_MESSAGE_REJECT_REASONS)[number];

export interface ValidateTeamMessageInput {
  /** boardOpen は Kill Switch・依頼の取り消しで false（ag:321） */
  ask: { id: Uuid; shape: Shape; boardOpen: boolean };
  /** 依頼の担当（まとめ役を含む）。stopped は止まった担当（失敗・停止・取り消し） */
  members: ReadonlyArray<{ memberId: Uuid; agentName: string; position: number; isAggregator: boolean; stopped: boolean }>;
  /** 送った担当（edge がタスクのトークンから引く） */
  fromMemberId: Uuid;
  /** to は担当の名前か 'all'（share だけ） */
  message: { to: string; kind: TeamMessageKind; body: string; inReplyTo?: Uuid };
  /** 受け付けた連絡だけ（ask_messages） */
  history: ReadonlyArray<{ id: Uuid; fromMember: Uuid; toMember: Uuid | null; kind: TeamMessageKind; inReplyTo: Uuid | null }>;
}
/** toMemberId は宛先の担当（'all' は null） */
export type ValidateTeamMessageResult = { ok: true; toMemberId: Uuid | null } | { ok: false; reason: TeamMessageRejectReason };

type TeamMember = ValidateTeamMessageInput["members"][number];

/** share（ag:303-308）：並列・まとめはまとめ役以外の担当どうし、順番は前の段 → 後の段 */
function shareAllowed(shape: Shape, from: TeamMember, to: TeamMember): boolean {
  if (from.isAggregator || to.isAggregator) return false;
  return shape === "chain" ? from.position < to.position : shape === "parallel" || shape === "aggregate";
}

/** question：まとめは担当どうしとまとめ役 → 担当、順番は後の段 → 前の段、並列は担当どうし */
function questionAllowed(shape: Shape, from: TeamMember, to: TeamMember): boolean {
  if (to.isAggregator) return false;
  if (shape === "aggregate") return true;
  if (from.isAggregator) return false;
  return shape === "chain" ? from.position > to.position : shape === "parallel";
}

/**
 * 連絡板の連絡を受け付けてよいか（FR §3.13、ag:314-318。純粋関数）。上から順に調べ、最初の違反を返す：
 * 1 連絡板が閉じている → board_closed／2 ひとり → single_shape／3 本文が空（trim）・2,000文字を超える → body_empty・body_too_long／
 * 4 宛先：'all' は share だけ、ほかは同じ依頼の担当の名前（正規化して照合：V10 と同じ）。ない・自分・送り手が依頼にいない → recipient_not_in_ask（BR-73）、
 *   止まった担当 → recipient_stopped／5 形と種類の表（reply は自分宛てでまだ返事していない question だけ、revise はまとめ役 → 担当だけ）／
 * 6 上限（BR-77）：依頼で20通、同じ2体の question 3件（向きを問わない）、同じ担当への revise 1件。
 * 通れば宛先の担当（'all' は null）。断ったら呼び出し側は監査ログ ask.message.rejected を残し、ツールのエラーとして返す（ag:314）
 */
export function validateTeamMessage(input: ValidateTeamMessageInput): ValidateTeamMessageResult {
  const reject = (reason: TeamMessageRejectReason): ValidateTeamMessageResult => ({ ok: false, reason });
  const { ask, members, message, history } = input;
  if (ask.boardOpen !== true) return reject("board_closed");
  const shape = ask.shape;
  if (shape === "single") return reject("single_shape");
  const body = typeof message.body === "string" ? message.body : "";
  if (body.trim() === "") return reject("body_empty");
  if ([...body].length > TEAM_LIMITS.bodyMaxChars) return reject("body_too_long");

  // 4 送り手と宛先（編成は依頼1件の中で閉じる：BR-73）
  const from = members.find((m) => m.memberId === input.fromMemberId);
  if (from === undefined) return reject("recipient_not_in_ask");
  const kind = message.kind;
  let to: TeamMember | null = null;
  if (kind === "share" && message.to === "all") {
    // 全員：まとめ役は share をしないので聞き手から外す。全員に share してよい送り手のときだけ（順番は先頭の段だけ）
    const audience = members.filter((m) => m !== from && !m.isAggregator);
    if (audience.length === 0) return reject("recipient_not_in_ask");
    if (!audience.every((m) => shareAllowed(shape, from, m))) return reject("kind_not_allowed_for_shape");
  } else {
    const name = typeof message.to === "string" ? normalizeAgentName(message.to) : "";
    const hits = name === "" ? [] : members.filter((m) => normalizeAgentName(m.agentName) === name);
    // 同じ名前が2人いたら決められないので断る（ワークスペースの中で名前は重ならない：V10）
    if (hits.length !== 1 || hits[0] === from) return reject("recipient_not_in_ask");
    to = hits[0]!;
    if (to.stopped === true) return reject("recipient_stopped");
  }

  // 5 形と種類（ag:303-308）
  switch (kind) {
    case "share":
      if (to !== null && !shareAllowed(shape, from, to)) return reject("kind_not_allowed_for_shape");
      break;
    case "question":
      if (to === null || !questionAllowed(shape, from, to)) return reject("kind_not_allowed_for_shape");
      break;
    case "reply": {
      // 質問を受けた担当 → 質問した担当だけ。inReplyTo は自分宛ての question で、まだ返事していないもの
      const q = history.find((h) => h.id === message.inReplyTo);
      const valid =
        to !== null &&
        q !== undefined &&
        q.kind === "question" &&
        q.toMember === from.memberId &&
        q.fromMember === to.memberId &&
        !history.some((h) => h.kind === "reply" && h.inReplyTo === q.id && h.fromMember === from.memberId);
      if (!valid) return reject("reply_target_invalid");
      break;
    }
    case "revise":
      if (shape !== "aggregate" || !from.isAggregator || to === null || to.isAggregator) return reject("revise_not_from_aggregator");
      break;
    default:
      return reject("kind_not_allowed_for_shape");
  }

  // 6 上限（BR-77）。20通目は可、21通目は不可
  if (history.length + 1 > TEAM_LIMITS.messagesPerAsk) return reject("ask_message_limit");
  if (kind === "question" && to !== null) {
    const pair = history.filter(
      (h) =>
        h.kind === "question" &&
        ((h.fromMember === from.memberId && h.toMember === to.memberId) || (h.fromMember === to.memberId && h.toMember === from.memberId)),
    ).length;
    if (pair + 1 > TEAM_LIMITS.questionsPerPair) return reject("question_pair_limit");
  }
  if (kind === "revise" && to !== null) {
    const revised = history.filter((h) => h.kind === "revise" && h.toMember === to.memberId).length;
    if (revised + 1 > TEAM_LIMITS.revisePerMember) return reject("revise_limit");
  }
  return { ok: true, toMemberId: to === null ? null : to.memberId };
}

// ここから回答（FR-063）

/** 失敗の理由の固定文（FR §8-11「{名前}：失敗（{理由の固定文}）」。UI の failReasonText にも使う） */
const FAIL_REASON_TEXT: Readonly<Record<string, string>> = {
  sandbox_lost: "応答がなくなりました",
  provision_failed: "準備に失敗しました",
  repo_too_large: "リポジトリが大きすぎます",
  llm_unavailable: "AI につながりませんでした",
  diff_invalid: "変更を作れませんでした",
  base_conflict: "元の内容が変わっていました",
  verify_mismatch: "結果を確かめられませんでした",
  precondition_failed: "始める条件がそろっていませんでした",
  agent_no_change: "することがありませんでした",
  agent_unable: "できませんでした",
  action_failed: "送った操作が失敗しました",
};
/** 止めた理由の固定文 */
const HALT_REASON_TEXT: Readonly<Record<string, string>> = {
  budget_exceeded: "予算の上限に達しました",
  breaker_tripped: "くり返しの上限で止めました",
  timeout: "時間の上限に達しました",
  kill_switch: "全体の停止で止めました",
  policy_violation: "決まりに反しました",
  approval_expired: "確認の期限が切れました",
  installation_removed: "連携が外されました",
  agent_disabled: "エージェントが停止されました",
};

/** タスクの fail_reason の固定文。知らない値・null は「理由不明」 */
export function failReasonText(reason: string | null): string {
  return reason !== null && Object.hasOwn(FAIL_REASON_TEXT, reason) ? (FAIL_REASON_TEXT[reason] ?? "理由不明") : "理由不明";
}
/** タスクの halt_reason の固定文。知らない値・null は「止めました」 */
export function haltReasonText(reason: string | null): string {
  return reason !== null && Object.hasOwn(HALT_REASON_TEXT, reason) ? (HALT_REASON_TEXT[reason] ?? "止めました") : "止めました";
}

export interface AnswerMemberTask {
  id: Uuid;
  status: TaskStatus;
  failReason: string | null;
  haltReason: string | null;
  taint: TaintState;
  report: { title: string; body: string } | null;
  /** 送る前の確認で、ユーザーが「送らない」にした書き込み（Intent の rejected）の数（D-108）。なければ 0 */
  declinedWrites?: number;
}
export interface AnswerMember {
  agentId: Uuid;
  agentName: string;
  position: number;
  isAggregator: boolean;
  isSpokesperson: boolean;
  /** その run のこの担当の最新のタスク。始まっていなければ null */
  task: AnswerMemberTask | null;
}
export interface ComposeAnswerInput {
  shape: Shape;
  members: readonly AnswerMember[];
  /** この run のタスクの pending_approval の Intent の数 */
  pendingApprovals: number;
  /** 連絡板の question と返事の有無（Should） */
  boardFacts: ReadonlyArray<{ fromAgentName: string; toAgentName: string; replied: boolean }>;
  /** 順番の [ここまでで終える]（FR §3.6）：止まった担当と理由の固定文 */
  stoppedBeforeEnd?: { agentName: string; reason: string };
}

/** 依頼の回答（FR §2.7。ask_runs.answer に保存する） */
export interface AskAnswer {
  askRunId: Uuid;
  /** 回答を書いたタスク。並列・Kernel が書いた回答は null（D-74） */
  answerTaskId: Uuid | null;
  /** SCR-021 の右上の窓口。並列・Kernel が書いた回答は null */
  spokesperson: { agentId: Uuid; agentName: string } | null;
  /** 1. 結論。窓口の submit_report の本文（Kernel は書き換えない）、並列は Kernel が並べたもの */
  conclusion: string;
  /** 2. 誰が何をしたか（Kernel が差し込む。text に名前は入れない：画面が「{名前}：{text}」にする） */
  memberLines: Array<{ agentName: string; text: string; failed: boolean }>;
  /**
   * 3. 手が要るもの（文は画面の固定の文「あなたの確認待ち：N件」）。declinedWrites はユーザーが「送らない」にした書き込みの数で、
   * 1件以上のときだけ入れる（0 のときに鍵を足すと、前からある回答の bodyHash が変わるため：D-108）
   */
  needsYou: { pendingApprovals: number; stoppedMembers: string[]; declinedWrites?: number };
  /** 順番の途中の経過（最後の段より前の段の本文。畳んで出す） */
  intermediate: Array<{ agentName: string; body: string }>;
  /** 「外部の内容をもとにしています（…）」 */
  taintNote: string | null;
  /** ask.answered に入れる本文のハッシュ */
  bodyHash: Hex64;
  updatedAt: string;
}
export type ComposedAnswer = Omit<AskAnswer, "askRunId" | "updatedAt">;

const OK_STATUSES: readonly TaskStatus[] = ["succeeded", "completed"];
const STOPPED_STATUSES: readonly TaskStatus[] = ["halted", "cancelled", "rejected"];

/** 失敗・止めた担当の理由の固定文 */
function stopReasonText(t: AnswerMemberTask): string {
  if (t.status === "failed") return failReasonText(t.failReason);
  if (t.status === "halted") return haltReasonText(t.haltReason);
  if (t.status === "cancelled") return "取り消されました";
  return "止めました";
}

/** 送る前の確認で「送らない」にした書き込みの数（負・非数は 0） */
function declinedOf(t: AnswerMemberTask): number {
  const n = t.declinedWrites ?? 0;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** 失敗・止めた担当（failed・halted・cancelled・rejected） */
function isStopped(t: AnswerMemberTask | null): boolean {
  return t !== null && (t.status === "failed" || STOPPED_STATUSES.includes(t.status));
}

/** 見出しに使う名前（LLM 由来の名前に改行があっても見出しを1行に保つ） */
function headingName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

function byPosition(members: readonly AnswerMember[]): AnswerMember[] {
  return members.map((m, k) => ({ m, k })).sort((a, b) => a.m.position - b.m.position || a.k - b.k).map((e) => e.m);
}

/** 担当の1行の text（FR §8-11）。連絡板で確かめたことを同じ行に足す（uc:167） */
function memberText(m: AnswerMember, facts: ComposeAnswerInput["boardFacts"]): { text: string; failed: boolean } {
  const t = m.task;
  let text: string;
  let failed = false;
  if (t === null) text = "始まっていません";
  else if (t.status === "failed") {
    text = `失敗（${failReasonText(t.failReason)}）`;
    failed = true;
  } else if (STOPPED_STATUSES.includes(t.status)) text = "止めました";
  else if (t.report !== null && t.report.title.trim() !== "") text = t.report.title.trim();
  else if (OK_STATUSES.includes(t.status)) text = "済み";
  else text = "まだ終わっていません";
  // 送る前の確認で「送らない」にしたもの（D-108）：報告の題（「〜を発注します」）のままだと送ったように読めるので、同じ行に足す
  const declined = t !== null && OK_STATUSES.includes(t.status) ? declinedOf(t) : 0;
  if (declined > 0) text = `${text.replace(/。$/, "")}（あなたの確認で${declined}件を送りませんでした）`;
  // 相手ごとに1つ：返事が1回でも来れば「確かめました」
  const asked = new Map<string, boolean>();
  for (const f of facts) {
    if (f.fromAgentName !== m.agentName) continue;
    asked.set(f.toAgentName, (asked.get(f.toAgentName) ?? false) || f.replied === true);
  }
  const extra = [...asked].map(([to, replied]) => (replied ? `${to}に確かめました` : `${to}に確かめられませんでした`));
  if (extra.length > 0) text = [text.replace(/。$/, ""), ...extra].join("。");
  return { text, failed };
}

/** 並列の結論（D-74）：担当ごとの報告を position の順に、名前を見出しにして並べる。失敗した担当は「失敗：〇〇」。動いている担当は入れない */
function parallelConclusion(sorted: readonly AnswerMember[]): string {
  const sections: string[] = [];
  for (const m of sorted) {
    const t = m.task;
    if (t === null) continue;
    if (isStopped(t)) sections.push(`## 失敗：${headingName(m.agentName)}\n\n${stopReasonText(t)}`);
    else if (t.report !== null) sections.push(`## ${headingName(m.agentName)}\n\n${t.report.body}`);
  }
  return sections.length === 0 ? "回答を作れませんでした" : sections.join("\n\n");
}

/** 窓口（isSpokesperson。立っていなければ形から：chain は最後の段、single は最初、aggregate はまとめ役） */
function spokespersonOf(shape: Shape, sorted: readonly AnswerMember[]): AnswerMember | null {
  if (shape === "parallel") return null;
  const flagged = sorted.find((m) => m.isSpokesperson === true);
  if (flagged !== undefined) return flagged;
  if (shape === "aggregate") return sorted.find((m) => m.isAggregator === true) ?? null;
  const own = sorted.filter((m) => m.isAggregator !== true);
  return (shape === "chain" ? own[own.length - 1] : own[0]) ?? null;
}

function mergedTaint(members: readonly AnswerMember[]): TaintState {
  const sources: TaintSource[] = [];
  let tainted = false;
  for (const m of members) {
    if (m.task === null || !isTainted(m.task.taint)) continue;
    tainted = true;
    sources.push(...m.task.taint.sources);
  }
  return { tainted, sources };
}

/**
 * 依頼の回答を作る（FR §3.7、agents.md:258-275、D-74）。LLM を呼ばない。
 * 結論：single・chain・aggregate は窓口の報告の本文（書き換えない）。parallel は Kernel が並べる。
 * [ここまでで終える] は「{名前}で止まりました（{理由}）」。窓口の報告がなければ最初に止まった担当で同じ文。
 * 誰が何をしたか・手が要るもの・途中の経過・汚染の1行は Kernel が固定の文で作る。bodyHash はこれらの正規形のハッシュ
 */
export function composeAnswer(input: ComposeAnswerInput): ComposedAnswer {
  const sorted = byPosition(input.members);
  const sp = spokespersonOf(input.shape, sorted);
  let conclusion: string;
  let writer: AnswerMember | null = null; // 結論を書いたタスクの担当（Kernel が書いたら null）
  if (input.stoppedBeforeEnd !== undefined) {
    conclusion = `${input.stoppedBeforeEnd.agentName}で止まりました（${input.stoppedBeforeEnd.reason}）`;
  } else if (input.shape === "parallel") {
    conclusion = parallelConclusion(sorted);
  } else if (sp !== null && sp.task !== null && sp.task.report !== null) {
    conclusion = sp.task.report.body;
    writer = sp;
  } else {
    const stopped = sorted.find((m) => isStopped(m.task));
    conclusion =
      stopped !== undefined && stopped.task !== null
        ? `${stopped.agentName}で止まりました（${stopReasonText(stopped.task)}）`
        : "回答を作れませんでした";
  }

  const memberLines = sorted.map((m) => ({ agentName: m.agentName, ...memberText(m, input.boardFacts) }));
  const declinedWrites = sorted.reduce((n, m) => n + (m.task === null ? 0 : declinedOf(m.task)), 0);
  const needsYou: ComposedAnswer["needsYou"] = {
    pendingApprovals: input.pendingApprovals,
    stoppedMembers: sorted.filter((m) => isStopped(m.task)).map((m) => m.agentName),
    ...(declinedWrites > 0 ? { declinedWrites } : {}),
  };
  const intermediate: ComposedAnswer["intermediate"] = [];
  if (input.shape === "chain") {
    const last = sorted.filter((m) => m.isAggregator !== true).at(-1);
    for (const m of sorted) {
      if (m === last || m.isAggregator === true || m.task === null || m.task.report === null) continue;
      intermediate.push({ agentName: m.agentName, body: m.task.report.body });
    }
  }
  // 回答を書いたタスクの汚染。並列・Kernel が書いた回答はどれかの担当が汚染されていれば付ける（FR §3.7-5）
  const taintNote = answerTaintLine(writer !== null && writer.task !== null ? writer.task.taint : mergedTaint(sorted));
  const bodyHash = hashCanonical({ conclusion, memberLines, needsYou, intermediate, taintNote });
  return {
    answerTaskId: writer?.task?.id ?? null,
    spokesperson: writer === null ? null : { agentId: writer.agentId, agentName: writer.agentName },
    conclusion,
    memberLines,
    needsYou,
    intermediate,
    taintNote,
    bodyHash,
  };
}
