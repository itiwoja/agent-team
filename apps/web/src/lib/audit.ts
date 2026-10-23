// SCR-010 監査ログの純粋な関数：カーソル・1行の要約・実行者・日時。
// 要約は主要なイベントだけ平易な日本語にし、知らない種類は主なキーを並べる（中身を隠さない）
import type { AuditLogItem } from "../api";
import { formatUsd } from "./format";

/** API のカーソル（最後に返した seq の base64。apps/app/src/routes/audit.ts の encodeAuditCursor と同じ） */
export function encodeAuditCursor(seq: number): string {
  return btoa(String(seq));
}

/** seq の行から（それより古い行を含めて）取るカーソル。API は「cursor より小さい seq」を返すので seq+1 を渡す */
export function cursorAt(seq: number): string {
  return encodeAuditCursor(seq + 1);
}

/** ?seq= の値。正の整数でなければ null */
export function parseSeq(v: string | null): number | null {
  if (v === null || !/^[1-9]\d{0,15}$/.test(v)) return null;
  return Number(v);
}

/** ハッシュの先頭8文字 */
export const shortHash = (h: string): string => h.slice(0, 8);

/** 2026/10/6 12:07:33（記録は日付と秒まで出す） */
export function formatAuditTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 実行者：あなた／人／エージェント／仕組み（edge・gateway などの名前） */
export function actorLabel(item: Pick<AuditLogItem, "actorType" | "actorId">, selfUserId?: string): string {
  switch (item.actorType) {
    case "user":
      return item.actorId === selfUserId ? "あなた" : `人（${item.actorId.slice(0, 8)}）`;
    case "agent":
      return `エージェント（${item.actorId.slice(0, 8)}）`;
    case "system":
      return `仕組み（${item.actorId}）`;
    default:
      return `${item.actorType}（${item.actorId}）`;
  }
}

const DECISION: Record<string, string> = {
  allow: "通した",
  deny: "止めた",
  approve: "人の確認に回した",
  handoff: "ほかに引き継いだ",
  halt: "打ち切った",
  reject: "送らない",
};

const REASON: Record<string, string> = {
  task_terminated: "仕事が終わっていた",
  budget_exceeded: "費用の上限",
  breaker_tripped: "安全装置が働いた",
  unknown_action: "知らない操作",
  not_granted: "許されていない操作",
  tool_needs_review: "道具の確認待ち",
  connector_disabled: "接続先が無効",
  intent_limit: "送る数の上限",
  path_denied: "禁止の場所",
  path_not_allowed: "許可の外の場所",
  autonomy_deny: "任せ方の設定で禁止",
  approval_required: "人の確認が必要",
  unknown_outcome_pending: "届いたかわからない送信がある",
  guard_exceeded: "値の上限を超えた",
  autonomy_auto: "任せ方の設定で自動",
  rule_matched: "覚えた決まりに合った",
  not_gated: "確認のいらない操作",
  autonomy_handoff: "任せ方の設定で引き継ぎ",
  // intent.expired・approval の失効の理由
  tool_changed: "道具が変わった",
  tool_hash: "道具が変わった",
  policy_changed: "決まりが変わった",
  task_ended: "仕事が終わった",
  task_cancelled: "仕事を取り消した",
  approval_timeout: "確認の期限が切れた",
  superseded: "新しいものに置き換わった",
  // 仕事を止めた理由（halted）
  timeout: "時間切れ",
  policy_violation: "決まりに反した",
  approval_expired: "確認の期限が切れた",
  installation_removed: "接続が外された",
  agent_disabled: "エージェントが無効",
  // 仕事・送信が失敗した理由（failed）
  sandbox_lost: "実行の環境が失われた",
  provision_failed: "準備に失敗した",
  repo_too_large: "大きすぎる",
  llm_unavailable: "AI を呼べなかった",
  diff_invalid: "変更の形が正しくない",
  base_conflict: "元の状態とぶつかった",
  verify_mismatch: "確かめた結果が合わない",
  precondition_failed: "送る前の前提が崩れた",
  agent_no_change: "変更がなかった",
  agent_unable: "エージェントが続けられなかった",
  action_failed: "送信に失敗した",
  tool_error: "道具がエラーを返した",
  auth_required: "認証が必要",
  unreachable: "接続先に届かなかった",
  // 汚染後の Web の出口（SG-04・D-30）
  tainted_unknown_url: "外の内容を読んだ後で、見ていない URL だった",
  tainted_query_shape: "外の内容を読んだ後で、検索語の形が許されない",
  // 承認の出どころの照合（SG-03。gateway が実行の前に止めた理由）
  approval_provenance: "判定の証拠が合わなかった",
  dry_run_intent: "試し実行の送る案だった",
  decision_not_executable: "実行できる判定ではなかった",
  decision_missing: "統制の判定の記録がない",
  decision_mismatch: "統制の判定の記録と合わない",
  decision_audit_missing: "監査ログに判定がない",
  decision_audit_mismatch: "監査ログの判定と合わない",
  proposal_audit_missing: "監査ログに送る案がない",
  proposal_audit_mismatch: "監査ログの送る案と合わない",
  already_finished: "もう終わった送る案だった",
  execution_replayed: "同じ送る案をもう一度送ろうとした",
  approval_missing: "人の確認の記録がない",
  approval_mismatch: "人の確認の記録と合わない",
  approval_not_approved: "人が確認していない",
  approver_not_allowed: "確認できる人ではなかった",
  approval_time_invalid: "確認の時刻が合わない",
  approval_after_expiry: "確認が期限の後だった",
  approval_rejected: "人が送らないと決めていた",
  approval_audit_missing: "監査ログに人の確認がない",
  approval_audit_conflict: "監査ログの人の確認が食い違う",
  approval_hash_mismatch: "確認した中身と合わない",
  approval_request_missing: "監査ログに確認の依頼がない",
  approval_request_mismatch: "監査ログの確認の依頼と合わない",
  approval_order_invalid: "確認の順番が合わない",
  rule_not_matched: "覚えた決まりに合っていない",
  // 依頼が失敗した理由
  formation_invalid: "チームの組み方が正しくない",
  agent_limit: "エージェントの数の上限",
  planner_error: "チームを組めなかった",
  // completed・cancelled の内訳
  dry_run: "試しの実行",
  report: "報告だけ",
  actions_declined: "送らないものがあった",
  approved_branch: "確認で送った場合",
  user: "利用者が取り消した",
  policy_narrowed: "決まりを狭めた",
};

/** 仕事（tasks）・依頼（asks・ask_runs）の状態 */
const STATUS: Record<string, string> = {
  queued: "待ち",
  provisioning: "準備中",
  generating: "チームを組んでいる",
  running: "実行中",
  awaiting_approval: "確認待ち",
  waiting_input: "返事待ち",
  executing: "送っている",
  judging: "判定中",
  succeeded: "成功",
  completed: "完了",
  done: "完了",
  rejected: "却下",
  failed: "失敗",
  error: "エラー",
  halted: "停止",
  cancelled: "取り消し",
};

const BUDGET_ITEM: Record<string, string> = {
  max_steps: "手数の上限",
  max_minutes: "時間の上限",
  per_task_usd: "1件の費用の上限",
  per_day_usd: "1日の費用の上限",
  agent_day_usd: "エージェントの1日の費用の上限",
};

/** 費用の守り（packages/edge/src/spend.ts の SpendScope） */
const BUDGET_SCOPE: Record<string, string> = {
  global: "全体の1日の上限",
};

const BREAKER: Record<string, string> = {
  same_action_repeat: "同じ操作の繰り返し",
  denied_attempts_max: "止められた回数",
  step_cost_usd_max: "1回の費用",
};

const RUN_TRIGGER: Record<string, string> = {
  initial: "最初の実行",
  manual: "手動",
  schedule: "予定の時刻",
  resume: "再開",
};

const ASK_SHAPE: Record<string, string> = {
  single: "1人",
  parallel: "並んで",
  aggregate: "まとめ役つき",
  chain: "順番に",
};

const TEAM_MESSAGE: Record<string, string> = {
  share: "共有",
  question: "質問",
  reply: "返事",
  revise: "直しの依頼",
  revise_request: "直しの依頼",
};

const TOOL_CHANGE: Record<string, string> = {
  changed: "定義が変わった",
  removed: "一覧から消えた",
};

type Payload = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const usd = (v: unknown): string | null => (typeof v === "string" || typeof v === "number" ? formatUsd(v) : null);
const label = (map: Record<string, string>, v: unknown): string | null => {
  const s = str(v);
  return s === null ? null : (map[s] ?? s);
};
/** 対応表にある値だけを日本語にする（ない値は出さない） */
const knownLabel = (map: Record<string, string>, v: unknown): string | null => {
  const s = str(v);
  return s === null ? null : (map[s] ?? null);
};
const join = (parts: Array<string | null | false | undefined>): string => parts.filter((p): p is string => typeof p === "string" && p !== "").join(" · ");
const kTokens = (n: number | null): string | null => (n === null ? null : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const count = (v: unknown): number | null => (Array.isArray(v) ? v.length : null);

/**
 * 当たった決まり（matchedRule は設定の場所 rules.items[0] など）。覚えた決まり・値の上限だけ番号を平易にして出し、
 * ほかは理由（reasonCode）の訳で足りるので出さない（全文は JSON で見られる）
 */
function ruleLabel(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  const rule = /^rules\.items\[(\d+)\]$/.exec(s);
  if (rule) return `${Number(rule[1]) + 1}番目の決まり`;
  const guard = /^guards\[(\d+)\]$/.exec(s);
  if (guard) return `${Number(guard[1]) + 1}番目の値の上限`;
  return null;
}

/** 行の見出し（種類の短い日本語の名前）。英語の event_type は行を開いた詳細に残す */
const EVENT_LABEL: Record<string, string> = {
  "decision.made": "統制の判定",
  "intent.proposed": "送る案",
  "intent.resolved": "送った結果の確認",
  "intent.expired": "送る案の失効",
  "approval.requested": "確認の依頼",
  "approval.decided": "確認の決定",
  "approval.expired": "確認の期限切れ",
  "approval.invalidated": "確認の無効化",
  "action.started": "送信の開始",
  "action.presend_retry": "送る前の失敗からの戻し",
  "action.executed": "送信",
  "action.failed": "送信の失敗",
  "action.unknown_outcome": "送信の結果不明",
  "budget.exceeded": "費用の上限",
  "breaker.tripped": "安全装置",
  "llm.called": "AI の呼び出し",
  "task.created": "仕事の開始",
  "task.status_changed": "仕事の状態",
  "task.cancelled": "仕事の取り消し",
  "task.report_submitted": "報告",
  "ask.created": "依頼",
  "ask.question": "依頼への質問",
  "ask.question_answered": "質問への答え",
  "ask.formed": "チームの組み立て",
  "ask.failed": "依頼の失敗",
  "ask.cancelled": "依頼の取り消し",
  "ask.run.started": "依頼の実行",
  "ask.run.finished": "依頼の実行の終わり",
  "ask.step.started": "担当の開始",
  "ask.followup.started": "追いの質問",
  "ask.answered": "依頼の答え",
  "ask.answer.updated": "答えの更新",
  "ask.resumed": "依頼の再開",
  "ask.reply.queued": "返事の順番待ち",
  "ask.reply.started": "順番待ちの返事の開始",
  "ask.message.posted": "チームへの伝言",
  "ask.message.rejected": "伝言の差し止め",
  "agent.created": "エージェントの作成",
  "agent.removed": "エージェントの片付け",
  "agent.config.changed": "エージェントの設定",
  "agent.config.widened": "エージェントの権限の拡大",
  "agent.workspace.reset": "作業場を最初に戻す",
  "job.created": "仕事の型の作成",
  "workspace.created": "ワークスペースの作成",
  "policy.snapshot_created": "決まりの保存",
  "connector.registered": "接続先の登録",
  "connector.updated": "接続先の更新",
  "connector.rejected": "接続先の拒否",
  "connector.tool.added": "道具の追加",
  "connector.tool.classified": "道具の分類",
  "connector.tool.needs_review": "道具の確認待ち",
};

/** 種類の見出し。知らない種類は event_type をそのまま出す（中身を隠さない） */
export function eventTypeLabel(eventType: string): string {
  return Object.hasOwn(EVENT_LABEL, eventType) ? EVENT_LABEL[eventType]! : eventType;
}

/** 1行の要約 */
export function summarizeAudit(item: Pick<AuditLogItem, "eventType" | "payload">): string {
  const p: Payload = item.payload && typeof item.payload === "object" ? item.payload : {};
  // 主要なイベントでもキーが欠けて空になったら、主なキーに戻す
  return summarizeKnown(item.eventType, p) || summarizeKeys(p);
}

function summarizeKnown(type: string, p: Payload): string | null {
  switch (type) {
    case "decision.made":
      return join([label(DECISION, p.decision), label(REASON, p.reasonCode), ruleLabel(p.matchedRule), str(p.action) ?? (p.subjectKind === "llm_call" ? "AI の呼び出し" : null)]);
    case "intent.proposed":
      return join([`送る案を作った：${str(p.action) ?? "操作"}`, label(DECISION, p.decision), label(REASON, p.reasonCode), ruleLabel(p.matchedRule)]);
    case "intent.resolved":
      return p.outcome === "executed" ? "届いていたと確かめた" : p.outcome === "failed" ? "届いていないと確かめた" : join(["送った結果を確かめた", str(p.outcome)]);
    case "intent.expired":
      return join(["送る案が無効になった", str(p.action), label(REASON, p.reason ?? p.expireReason)]);
    case "approval.requested":
      return "人の確認を頼んだ";
    case "approval.decided":
      return join([p.decision === "approve" ? "確認：送る" : p.decision === "reject" ? "確認：送らない" : label(DECISION, p.decision), p.remember === true && "次から同じものは任せる"]);
    case "approval.expired":
      return join(["確認の期限が切れた", p.reason !== undefined && label(REASON, p.reason)]);
    case "approval.invalidated":
      return join(["確認が無効になった", label(REASON, p.reason)]);
    case "action.executed":
      return join(["送った", str(p.action)]);
    case "action.started":
      return join(["送り始めた", str(p.action)]);
    case "action.presend_retry":
      return join(["送る前に失敗したので、もう一度送れるように戻した", str(p.action)]);
    case "action.failed":
      // 送る前の前提で止めたとき（gateway の境界・判定の証拠の照合：SG-03）だけ、止めた理由とどの証拠かを足す。
      // 対応表にあるコードだけを出す（detail は自由な文のこともあるので、そのままは出さない）
      return join([
        "送れなかった",
        str(p.action),
        label(REASON, p.failReason),
        p.failReason === "precondition_failed" && knownLabel(REASON, p.reasonCode),
        p.failReason === "precondition_failed" && knownLabel(REASON, p.detail),
      ]);
    case "action.unknown_outcome":
      return join(["送ったが届いたかわからない", str(p.action)]);
    case "budget.exceeded": {
      const scope = label(BUDGET_SCOPE, p.scope);
      if (scope) return join([`${scope}で止めた`, usd(p.spentUsd) && `使った額 ${usd(p.spentUsd)}`, usd(p.limitUsd) && `上限 ${usd(p.limitUsd)}`]);
      const what = label(BUDGET_ITEM, p.item) ?? "上限";
      const used = num(p.used) ?? usd(p.usedUsd);
      const limit = num(p.limit) ?? usd(p.limitUsd);
      return join([`${what}で止めた`, used !== null && limit !== null && `${used} / ${limit}`]);
    }
    case "breaker.tripped":
      return join(["安全装置で止めた", label(BREAKER, p.breaker), num(p.value) !== null && num(p.threshold) !== null && `${num(p.value)} / ${num(p.threshold)}`]);
    case "llm.called": {
      const tokens = [kTokens(num(p.inputTokens)), kTokens(num(p.outputTokens))];
      return join([str(p.model), tokens.every((t) => t !== null) && tokens.join("/"), usd(p.costUsd)]);
    }
    case "task.status_changed":
      return join([
        `仕事の状態：${label(STATUS, p.from) ?? "?"} → ${label(STATUS, p.to) ?? "?"}`,
        label(REASON, p.haltReason),
        label(REASON, p.failReason),
        label(REASON, p.detail),
      ]);
    case "task.created":
      return "仕事を始めた";
    case "task.cancelled":
      return "仕事を取り消した";
    case "task.report_submitted":
      return join(["報告を出した", num(p.bodyChars) !== null && `${num(p.bodyChars)}文字`]);
    case "ask.created":
      return "依頼を受けた";
    case "ask.question":
      return join(["確かめたいことを聞いた", num(p.choices) !== null && `選択肢 ${num(p.choices)}つ`]);
    case "ask.question_answered":
      return "聞かれたことに答えた";
    case "ask.formed":
      return join(["チームを組んだ", count(p.members) !== null && `${count(p.members)}人`, label(ASK_SHAPE, p.shape)]);
    case "ask.failed":
      return join(["依頼が失敗した", label(REASON, p.reason)]);
    case "ask.cancelled":
      return "依頼を取り消した";
    case "ask.run.started":
      return join(["依頼を動かした", label(RUN_TRIGGER, p.trigger), num(p.runNo) !== null && `${num(p.runNo)}回目`]);
    case "ask.run.finished":
      return join(["依頼の実行が終わった", label(STATUS, p.status)]);
    case "ask.step.started":
      return join(["担当が仕事を始めた", p.tainted === true && "外から来た内容を含む"]);
    case "ask.followup.started":
      return "担当が追いの質問に答え始めた";
    case "ask.answered":
      return "依頼に答えた";
    case "ask.answer.updated":
      return "依頼の答えを直した";
    case "ask.resumed":
      return p.action === "retry" ? "止まった担当をやり直した" : p.action === "finish" ? "止まったところで依頼を終えた" : "止まった依頼を進めた";
    case "ask.reply.queued":
      return "返事を順番待ちに入れた";
    case "ask.reply.started":
      return "順番待ちの返事で依頼を動かした";
    case "ask.message.posted":
      return join(["チームに伝えた", label(TEAM_MESSAGE, p.kind)]);
    case "ask.message.rejected":
      return join(["チームへの伝言を止めた", label(TEAM_MESSAGE, p.kind), str(p.reason)]);
    case "agent.created":
      return join(["エージェントを作った", str(p.name)]);
    case "agent.removed":
      return join(["30日使われなかったエージェントを片付けた", str(p.name)]);
    case "agent.config.changed":
      return "エージェントの設定を変えた";
    case "agent.config.widened":
      return "エージェントにできることを広げた";
    case "agent.workspace.reset":
      return join([
        "作業場を最初に戻した",
        str(p.name),
        p.origin === "pack" ? "パックのファイルに戻した" : p.origin === "empty" ? "空にした" : null,
        p.previousTainted === true && "外から来た内容を含む控えを捨てた",
      ]);
    case "job.created":
      return join(["仕事の型を作った", str(p.slug)]);
    case "workspace.created":
      return "ワークスペースを作った";
    case "policy.snapshot_created":
      return join(["決まりを保存した", num(p.version) !== null && `版 ${num(p.version)}`]);
    case "connector.registered":
      return join(["接続先を登録した", str(p.slug)]);
    case "connector.updated":
      return join(["接続先を更新した", str(p.slug)]);
    case "connector.rejected":
      return join(["接続先を断った", str(p.slug), label(REASON, p.reasonCode)]);
    case "connector.tool.added":
      return join(["道具を足した", str(p.tool)]);
    case "connector.tool.classified":
      return join(["道具を分類した", str(p.tool), str(p.classification)]);
    case "connector.tool.needs_review":
      return join(["道具を確認待ちにした", str(p.tool), label(TOOL_CHANGE, p.change)]);
    default:
      return null;
  }
}

const HEX = /^(sha256:)?[0-9a-f]{32,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ID・ハッシュのキー（taskId・toolHash・expiredIntentIds など）。要約に出さない（JSON の全文で見られる） */
const ID_KEY = /(Id|Ids|Hash|Hashes)$/;

/** 知らない種類：値が短い文字・数・真偽のキーを3つまで（ID・UUID・長いハッシュは省く） */
function summarizeKeys(p: Payload): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (parts.length >= 3) break;
    if (ID_KEY.test(k)) continue;
    if (typeof v === "string") {
      if (v === "" || HEX.test(v) || UUID.test(v)) continue;
      parts.push(`${k}: ${v.length > 24 ? `${v.slice(0, 24)}…` : v}`);
    } else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}: ${String(v)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "（中身なし）";
}

/** 絞り込みの種類の候補：主要なものと、読み込んだ記録にあった種類を合わせて並べる */
export const COMMON_EVENT_TYPES = [
  "decision.made",
  "intent.proposed",
  "approval.decided",
  "action.executed",
  "budget.exceeded",
  "task.status_changed",
  "llm.called",
] as const;

export function eventTypeOptions(seen: Iterable<string>): string[] {
  return [...new Set<string>([...COMMON_EVENT_TYPES, ...seen])].sort();
}
