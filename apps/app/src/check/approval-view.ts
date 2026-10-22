// 承認1件のカード（ApprovalView）を作る。AI に書かせず、DB の行・ツールの定義・Kernel の関数から決まった文で作る（BR-70・D-59）。
// [以後も許可] を出せるかは Kernel の canOfferRemember、固めるルールは buildRuleFromIntent（承認の API と同じ関数。表示と確定がずれない）

import type { SessionCtx, Queryable, WsCtx } from "@open-team/db";
import type { ApprovalBundle } from "@open-team/db/check";
import { getAgentCurrentSnapshot } from "@open-team/db/check";
import { loadTaskPolicy, toolInfoOf } from "@open-team/edge";
import {
  argPathsByRole,
  buildRuleFromIntent,
  canOfferRemember,
  effectiveArgRoles,
  extractArg,
  hashCanonical,
  isTainted,
  type AgentDefinitionInput,
  type ArgPath,
  type Hex64,
  type Json,
  type RememberCondition,
  type Rule,
  type ToolInfo,
} from "@open-team/kernel";
import type { ApprovalView, ArgView, RememberView } from "./contract.ts";
import { calendarCardOf, githubCardOf, intentTitle, openReasonOf, ruleText, taintNoteOf, taintViews, unitOf, valueText } from "./reasons.ts";
import { getGoogleConnection } from "@open-team/db";
import { timeZoneOrDefault } from "../connectors/google.ts";

// 同一 buildCheck は同じ q・workspace・now を渡す。カード間で同じ job/action の
// 集計を共有し、別リクエスト（now が異なる）には結果を持ち越さない。
/** 値（配列は要素ごと）を単位つきで文字にする */
function argText(action: string, path: string, value: Json): string {
  const unit = unitOf(action, path);
  const one = (v: Json): string => `${valueText(v)}${typeof v === "number" ? unit : ""}`;
  return Array.isArray(value) ? value.map(one).join("、") : one(value);
}

function argViewOf(action: string, path: ArgPath, args: ApprovalBundle["intent"]["payload"]["arguments"], role: "destination" | "content" | "option"): ArgView {
  const value = extractArg(args, path);
  return { arg: path, value, label: null, text: argText(action, path, value) };
}

/** ツールの確定した引数の役割（ない・読めないときは null。呼び出し側は引数を全部 destination として扱う：BR-56 の安全側） */
export function rolesOfBundle(b: Pick<ApprovalBundle, "tool">): ToolInfo["argRoles"] | null {
  if (b.tool === null) return null;
  return effectiveArgRoles(b.tool.input_schema, b.tool.arg_roles);
}

/** 宛先の表示（2行目）：名前つきなら「山田珈琲（supplier-01）」、なければ値 */
function destinationText(dest: readonly ArgView[]): string | null {
  if (dest.length === 0) return null;
  return dest.map((d) => (d.label !== null ? `${d.label}（${valueText(Array.isArray(d.value) ? d.value[0] : d.value)}）` : d.text)).join(" · ");
}

export interface RememberPlan {
  view: RememberView;
  /** 提供できるとき、承認した Intent から作るルール（freeOptions なし。確定の API は free を足して作り直す） */
  rule: Rule | null;
  /** 今のツール（ルールの作り直しに使う） */
  tool: ToolInfo | null;
}

const NO_REMEMBER: RememberView = { offered: false, failedConditions: [], fixed: [], freeCandidates: [], fixedHash: null, taintedOrigin: false };

/** ルールを作る [以後も許可] の新しい id（SG-09：作るときに決め、以後変えない。uuid の 32 桁。approvals.created_rule_id の CHECK の範囲） */
export function newRuleIdFrom(uuid: string): string {
  return `r-${uuid.replace(/-/g, "").toLowerCase()}`;
}

/**
 * 承認した Intent が汚染されたタスク（外部の内容を読んだ後）で作られたか（SG-09）。Intent を作った時点の汚染の写しで見る
 * （引数は提案のときに決まるので、そのあとにタスクが汚染されても、この書き込みの中身には効かない）
 */
export function intentWasTainted(b: Pick<ApprovalBundle, "intent">): boolean {
  return isTainted(b.intent.taint_snapshot);
}

/** 固定される値の指紋（見せた値と固めた値をずらさない。宛先とその他の引数の実際の値・action・tool_hash） */
export function fixedHashOf(rule: Pick<Rule, "action" | "match" | "tool_hash">): Hex64 {
  return hashCanonical({ action: rule.action, match: rule.match as unknown as Json, toolHash: rule.tool_hash });
}

/** [以後も許可] の材料（出せるか・固定される値）。pending でない承認・試し実行などは出さない */
export async function planRemember(q: Queryable, ctx: WsCtx, b: ApprovalBundle, now: Date, newRuleId: () => string): Promise<RememberPlan> {
  const none: RememberPlan = { view: NO_REMEMBER, rule: null, tool: null };
  if (b.approval.status !== "pending" || b.tool === null || b.connector === null) return none;
  const live = !b.task.is_dry_run;
  const info = toolInfoOf(b.connector, b.tool);
  let effectiveMcpWrite: "auto" | "approve" | "deny" | "handoff" = "approve";
  let rulesEnabled = false;
  let currentRuleCount = 0;
  try {
    const p = await loadTaskPolicy(q, ctx, { id: b.task.id, job_id: b.task.job_id, agent_snapshot_id: b.task.agent_snapshot_id });
    effectiveMcpWrite = p.policy.autonomy.mcp_write;
    rulesEnabled = p.policy.rules.enabled;
    const snap = await getAgentCurrentSnapshot(q, ctx, b.task.agent_id);
    currentRuleCount = ((snap?.definition as unknown as AgentDefinitionInput | null)?.rules ?? []).length;
  } catch {
    // ポリシーが読めない：出さない側に倒す（3 に当たる）
  }
  const offer = canOfferRemember({
    tool: info,
    effectiveMcpWrite,
    rulesEnabled,
    isHandoffOnly: false,
    isDryRun: !live,
    currentRuleCount,
  });
  if (!offer.ok) return { view: { ...NO_REMEMBER, failedConditions: offer.failed.map((f: RememberCondition) => f) }, rule: null, tool: info };
  // 汚染されたタスクの Intent からも作れる（BR-57 は変えない）。確認に印を出し、ルールの記録に残す（SG-09）
  const tainted = intentWasTainted(b);
  const rule = buildRuleFromIntent({
    intent: { id: b.intent.id, action: b.intent.action, args: b.intent.payload.arguments, toolHash: b.intent.payload.toolHash },
    tool: info,
    freeOptions: [],
    labels: {},
    addedBy: ctx.userId ?? "system",
    now: now.toISOString(),
    newId: newRuleId(),
    createdWhileTainted: tainted,
  });
  const fixed: ArgView[] = Object.entries(rule.match).map(([arg, value]) => ({
    arg,
    value,
    label: null,
    text: argText(b.intent.action, arg, value),
  }));
  const freeCandidates = argPathsByRole(info.argRoles, "option");
  return { view: { offered: true, failedConditions: [], fixed, freeCandidates, fixedHash: fixedHashOf(rule), taintedOrigin: tainted }, rule, tool: info };
}

export interface ApprovalViewDeps {
  q: Queryable;
  ctx: WsCtx;
  now: Date;
  newRuleId: () => string;
}

/** 承認のカード。session は「自分が承認者か」の判定に使う */
export async function buildApprovalView(d: ApprovalViewDeps, session: Pick<SessionCtx, "userId" | "role">, b: ApprovalBundle): Promise<ApprovalView> {
  const { approval: a, intent: i } = b;
  const roles = rolesOfBundle(b);
  const args = i.payload.arguments;
  const destination: ArgView[] = [];
  const content: ArgView[] = [];
  const options: ArgView[] = [];
  if (roles === null) {
    // ツールの定義が読めない：すべて宛先として並べる（BR-56 と同じ安全側）
    for (const k of Object.keys(args)) destination.push(argViewOf(i.action, k, args, "destination"));
  } else {
    for (const p of argPathsByRole(roles, "destination")) destination.push(argViewOf(i.action, p, args, "destination"));
    for (const p of argPathsByRole(roles, "content")) content.push(argViewOf(i.action, p, args, "content"));
    for (const p of argPathsByRole(roles, "option")) options.push(argViewOf(i.action, p, args, "option"));
  }
  const subtitle = destinationText(destination);
  const open = openReasonOf({
    action: i.action,
    reasonCode: i.reason_code,
    detail: i.decision_detail,
    firstDestination: a.first_destination,
    destinationText: subtitle,
  });
  // 予定の登録だけ、確認カードに時刻・招待を出す（時間帯は資格情報のもの。なければ Asia/Tokyo）
  const calendar =
    i.action === "mcp.gcal.create_event"
      ? calendarCardOf(i.action, args as Readonly<Record<string, unknown>>, timeZoneOrDefault((await getGoogleConnection(d.q, d.ctx))?.timeZone))
      : null;
  const github = githubCardOf(i.action, args as Readonly<Record<string, unknown>>);
  const remember = (await planRemember(d.q, d.ctx, b, d.now, d.newRuleId)).view;
  const approvers = (
    await d.q.query<{ id: string; name: string | null; login: string }>("SELECT u.id, u.name, u.login FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.workspace_id = $1 AND u.id = ANY($2::uuid[])", [d.ctx.workspaceId, a.approver_ids])
  ).rows.map((u) => ({ id: u.id, name: u.name ?? u.login }));
  const canDecide = (session.role === "owner" || session.role === "maintainer") && a.approver_ids.includes(session.userId);
  return {
    id: a.id,
    status: a.status,
    taskId: a.task_id,
    intentId: a.intent_id,
    intentHash: i.intent_hash,
    title: intentTitle(i.action),
    subtitle,
    action: i.action,
    agent: b.agentName === null ? null : { id: b.task.agent_id, name: b.agentName },
    askId: b.task.ask_id,
    createdAt: a.created_at.toISOString(),
    expiresAt: a.expires_at.toISOString(),
    canDecide,
    approvers,
    openReason: open,
    taintNote: open === null ? taintNoteOf(i.taint_snapshot) : null,
    destination,
    content,
    options,
    calendar,
    github,
    taint: { tainted: i.taint_snapshot.tainted, sources: taintViews(i.taint_snapshot) },
    rule: { reasonCode: i.reason_code, matchedRule: i.matched_rule, text: ruleText(i.reason_code, i.decision_detail) },
    risk: { level: a.risk_level, reasons: a.risk_reasons.map((r) => ({ code: r.code, points: r.points, detail: r.detail })) },
    remember,
    decidedAt: a.decided_at?.toISOString() ?? null,
    decisionComment: a.decision_comment,
  };
}
