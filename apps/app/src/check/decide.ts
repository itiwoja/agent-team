// API-019：承認の決定（approve / reject / remember）。ADR-005：表示した intentHash が今の Intent と違えば 409 INTENT_CHANGED。
// トランザクションの順（M-21）：ワークスペースの行 → タスク → 承認 → Intent。Kill Switch 発動中は承認も却下も 423。
// 1つのトランザクションで決定・Intent の状態・ルールの追加・監査ログ approval.decided・SSE の事象を書き、
// 外部（gateway の実行）はコミットのあとに呼ぶ（G-14）。実行の失敗は承認を取り消さない（Intent は approved のまま。tick が拾い直す）

import { appendAuditLog, lockWorkspace, type EffectivePolicies, type SessionCtx, type Tx, type Uuid } from "@open-team/db";
import { getLatestWorkspacePolicy, listConnectors, listConnectorTools } from "@open-team/db/app";
import {
  applyRuleChange,
  decideApprovalRow,
  decideIntentRow,
  expireDueApprovals,
  getAgentCurrentSnapshot,
  getApprovalBundle,
  lockApproval,
  lockApprovalIntent,
  type ApprovalBundle,
} from "@open-team/db/check";
import { lockTask as lockEdgeTask } from "@open-team/db/edge";
import { recomputeTaskStatus } from "@open-team/db/gateway";
import { GatewayClientError } from "@open-team/gateway-client";
import {
  CEILINGS_VERSION,
  DEFAULT_CEILINGS,
  RuleBuildError,
  buildRuleFromIntent,
  classify,
  composeAll,
  parseWorkspacePolicy,
  validateAgentDefinition,
  type AgentDefinitionInput,
  type Json,
  type JsonObject,
  type Rule,
} from "@open-team/kernel";
import { AppError } from "@open-team/platform";
import type { AppDeps } from "../deps.ts";
import { advanceAsk } from "../asks/run.ts";
import { catalogOf } from "../owner-setup.ts";
import { buildApprovalView, fixedHashOf, intentWasTainted, newRuleIdFrom, planRemember } from "./approval-view.ts";
import { calendarLinkOf } from "./calendar-link.ts";
import type { DecisionBody, DecisionResponse, ExecutionView, RuleView } from "./contract.ts";
import { publishCheckCounts, publishCheckRemove } from "./events.ts";
import { recheckBeforeExecute } from "./recheck.ts";

type Deps = Pick<AppDeps, "db" | "clock" | "ids" | "log" | "gatewayClient" | "env" | "hooks" | "llm" | "registry" | "sleep">;

const newRuleId = (deps: Pick<AppDeps, "ids">): string => newRuleIdFrom(deps.ids.newId());

type TxOutcome =
  | { kind: "decided"; decision: "approve" | "reject"; intentId: Uuid; askId: Uuid | null; rule: Rule | null }
  /** 期限切れ・ツールの変化：状態を書いてコミットしてから 409 を返す */
  | { kind: "stale"; error: AppError };

export async function decideApproval(deps: Deps, s: SessionCtx, approvalId: Uuid, body: DecisionBody): Promise<DecisionResponse> {
  const now = deps.clock.now();
  const out = await deps.db.transaction(async (tx): Promise<TxOutcome> => {
    const ws = await lockWorkspace(tx, s);
    if (ws === null) throw new AppError("NOT_FOUND");
    const pre = await getApprovalBundle(tx, s, approvalId);
    if (pre === null) throw new AppError("NOT_FOUND");
    const approverOk = (s.role === "owner" || s.role === "maintainer") && pre.approval.approver_ids.includes(s.userId);
    if (!approverOk) throw new AppError("FORBIDDEN");
    if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");

    const task = await lockEdgeTask(tx, s, pre.approval.task_id);
    const approval = await lockApproval(tx, s, approvalId);
    if (task === null || approval === null) throw new AppError("NOT_FOUND");
    if (approval.status !== "pending") throw new AppError("APPROVAL_NOT_PENDING");
    const intent = await lockApprovalIntent(tx, s, approval.intent_id);
    if (intent === null) throw new AppError("NOT_FOUND");
    if (now.getTime() >= approval.expires_at.getTime()) {
      await expireDueApprovals(tx, s, now);
      await appendAuditLog(tx, s.workspaceId, { eventType: "approval.expired", actorType: "system", actorId: "app", taskId: task.id, payload: { approvalId, intentId: intent.id } }, now);
      await publishCheckRemove(tx, s, `approval:${approvalId}`, now);
      return { kind: "stale", error: new AppError("APPROVAL_NOT_PENDING") };
    }
    if (intent.status !== "pending_approval") throw new AppError("APPROVAL_NOT_PENDING");
    // ADR-005：画面に出した内容（intentHash）と今の Intent が違えば承認しない
    if (body.intentHash !== intent.intent_hash) throw new AppError("INTENT_CHANGED");

    // 承認の前に、ツールの説明・スキーマが変わっていないか（tool_hash）。変わっていたら承認を無効にする
    const bundle: ApprovalBundle | null = await getApprovalBundle(tx, s, approvalId);
    if (bundle === null) throw new AppError("NOT_FOUND");
    if (bundle.tool === null || bundle.connector === null || bundle.tool.tool_hash !== intent.tool_hash || bundle.tool.status !== "ok" || !bundle.connector.enabled) {
      await decideApprovalRow(tx, s, approvalId, { status: "rejected", decidedBy: s.userId, comment: "tool_changed", remember: false, createdRuleId: null, now });
      await tx.query("UPDATE action_intents SET status = 'expired', expire_reason = 'tool_changed', updated_at = $3 WHERE workspace_id = $1 AND id = $2 AND status = 'pending_approval'", [
        s.workspaceId,
        intent.id,
        now,
      ]);
      await appendAuditLog(tx, s.workspaceId, { eventType: "approval.invalidated", actorType: "system", actorId: "app", taskId: task.id, payload: { approvalId, intentId: intent.id, reason: "tool_changed" } }, now);
      await recomputeTaskStatus(tx, s, task.id, now);
      await publishCheckRemove(tx, s, `approval:${approvalId}`, now);
      await publishCheckCounts(tx, deps, s, now);
      return { kind: "stale", error: new AppError("INTENT_CHANGED", "ツールの定義が変わったため、この確認は無効になりました") };
    }

    const comment = body.comment === undefined || body.comment.trim() === "" ? null : body.comment;
    if (body.decision === "reject") {
      await decideApprovalRow(tx, s, approvalId, { status: "rejected", decidedBy: s.userId, comment, remember: false, createdRuleId: null, now });
      await decideIntentRow(tx, s, intent.id, "rejected", now);
      await audit(tx, s, "reject", { approval, intentId: intent.id, taskId: task.id, intentHash: intent.intent_hash, comment, rule: null }, now);
      const change = await recomputeTaskStatus(tx, s, task.id, now);
      if (change?.terminal) for (const hook of deps.hooks.taskSettled ?? []) await hook(tx, s, { taskId: task.id, status: change.to, now });
      await publishCheckRemove(tx, s, `approval:${approvalId}`, now);
      await publishCheckCounts(tx, deps, s, now);
      return { kind: "decided", decision: "reject", intentId: intent.id, askId: task.ask_id, rule: null };
    }

    // approve（[以後も許可] を含む）
    let rule: Rule | null = null;
    if (body.remember === true) rule = await rememberRule(tx, deps, s, bundle, body, now);
    await decideApprovalRow(tx, s, approvalId, { status: "approved", decidedBy: s.userId, comment, remember: rule !== null, createdRuleId: rule?.id ?? null, now });
    await decideIntentRow(tx, s, intent.id, "approved", now);
    await audit(tx, s, "approve", { approval, intentId: intent.id, taskId: task.id, intentHash: intent.intent_hash, comment, rule }, now);
    await recomputeTaskStatus(tx, s, task.id, now);
    await publishCheckRemove(tx, s, `approval:${approvalId}`, now);
    await publishCheckCounts(tx, deps, s, now);
    return { kind: "decided", decision: "approve", intentId: intent.id, askId: task.ask_id, rule };
  }, { retryOnce: true });

  if (out.kind === "stale") throw out.error;

  // コミットのあと：実行（approve のときだけ）。再判定 → gateway の実行
  let execution: ExecutionView | null = null;
  if (out.decision === "approve") execution = await executeApproved(deps, s, out.intentId);

  // 依頼の実行を1歩進める（回答の「手が要るもの」の書き換え・次の段）。タスクを動かすので待たない（失敗は tick が拾い直す：asks/hooks.ts）
  if (out.askId !== null) {
    void advanceAsk(deps, s, out.askId).catch((error: unknown) => deps.log.warn("approval.advance_ask_failed", "依頼の実行を進められなかった（tick が拾い直す）", { askId: out.askId, error }));
  }

  const after = await getApprovalBundle(deps.db, s, approvalId);
  if (after === null) throw new AppError("NOT_FOUND");
  const approval = await buildApprovalView({ q: deps.db, ctx: s, now: deps.clock.now(), newRuleId: () => newRuleId(deps) }, s, after);
  return {
    approval,
    rule: out.rule === null ? null : ruleView(out.rule),
    // 実行できたときだけ、保存された結果から「カレンダーで開く」のリンクを付ける（実行のあとの Intent を読み直した結果）
    execution: withCalendarLink(execution, after.intent.action, after.intent.result),
  };
}

/** 実行できた予定の登録だけ、「カレンダーで開く」のリンクを足す（リンクがないときは項目を付けない：既存の形のまま） */
function withCalendarLink(execution: ExecutionView | null, action: string, storedResult: unknown): ExecutionView | null {
  if (execution === null || execution.status !== "executed") return execution;
  const calendarLink = calendarLinkOf(action, storedResult);
  return calendarLink === null ? execution : { ...execution, calendarLink };
}

function ruleView(r: Rule): RuleView {
  return { id: r.id, action: r.action, match: r.match as unknown as Record<string, unknown>, free: [...r.free], labels: r.labels === undefined ? null : { ...r.labels } };
}

async function audit(
  tx: Tx,
  s: SessionCtx,
  decision: "approve" | "reject",
  i: { approval: { id: string; remember: boolean }; intentId: Uuid; taskId: Uuid; intentHash: string; comment: string | null; rule: Rule | null },
  now: Date,
): Promise<void> {
  await appendAuditLog(
    tx,
    s.workspaceId,
    {
      eventType: "approval.decided",
      actorType: "user",
      actorId: s.userId,
      taskId: i.taskId,
      payload: {
        approvalId: i.approval.id,
        intentId: i.intentId,
        taskId: i.taskId,
        decision,
        intentHash: i.intentHash,
        remember: i.rule !== null,
        ruleId: i.rule?.id ?? null,
        // SG-09：外部の内容を読んだ後の書き込みから作ったルールか（ルールを作らなかったときは付けない）
        ...(i.rule === null ? {} : { ruleCreatedWhileTainted: i.rule.created_while_tainted === true }),
        hasComment: i.comment !== null,
      },
    },
    now,
  );
}

/** [以後も許可]：出せる条件・固定される値の確認・ルールの追加（定義への widen）。外れたら 422 / 409 */
async function rememberRule(
  tx: Tx,
  deps: Deps,
  s: SessionCtx,
  b: ApprovalBundle,
  body: DecisionBody,
  now: Date,
): Promise<Rule> {
  const plan = await planRemember(tx, s, b, now, () => newRuleId(deps));
  if (!plan.view.offered || plan.rule === null || plan.tool === null) {
    throw new AppError("RULE_NOT_ALLOWED", undefined, { details: { failedConditions: plan.view.failedConditions } });
  }
  // 見せた「固定される値」と、いま固めようとしている値が同じか（ADR-005 を残りの値に広げたもの）
  if (body.rememberFixedHash !== fixedHashOf(plan.rule)) throw new AppError("INTENT_CHANGED", "固定される値が変わりました。もう一度確認してください");

  const free = [...new Set(body.freeOptions ?? [])];
  // 汚染されたタスクの Intent からも作る（BR-57 は変えない）。ルールの記録と監査ログに残す（SG-09）
  const createdWhileTainted = intentWasTainted(b);
  let rule: Rule;
  try {
    const labels: Record<string, string> = {};
    for (const f of plan.view.fixed) if (f.label !== null && plan.tool.argRoles[f.arg] === "destination") labels[f.arg] = f.label;
    rule = buildRuleFromIntent({
      intent: { id: b.intent.id, action: b.intent.action, args: b.intent.payload.arguments, toolHash: b.intent.payload.toolHash },
      tool: plan.tool,
      freeOptions: free,
      labels,
      addedBy: s.userId,
      now: now.toISOString(),
      newId: plan.rule.id,
      createdWhileTainted,
    });
  } catch (e) {
    if (e instanceof RuleBuildError) {
      if (e.code === "tool_changed") throw new AppError("INTENT_CHANGED");
      throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "freeOptions", reason: e.message }] });
    }
    throw e;
  }

  const snap = await getAgentCurrentSnapshot(tx, s, b.task.agent_id);
  if (snap === null || snap.definition === null) throw new AppError("NOT_FOUND");
  const before = snap.definition as unknown as AgentDefinitionInput;
  const after = { ...before, rules: [...(before.rules ?? []), rule] } as unknown as AgentDefinitionInput;
  const policyRow = await getLatestWorkspacePolicy(tx, s);
  if (policyRow === null) throw new AppError("INTERNAL_ERROR", "ワークスペースのポリシーがありません");
  const workspacePolicy = parseWorkspacePolicy(policyRow.policy);
  const catalog = catalogOf(await listConnectors(tx, s), await listConnectorTools(tx, s));
  const v = validateAgentDefinition(after, { tools: catalog });
  if (!v.ok) throw new AppError("AGENT_SCHEMA_INVALID", undefined, { details: v.issues });
  const cls = classify({ before, after: v.definition as unknown as AgentDefinitionInput, ctx: { ceilings: DEFAULT_CEILINGS, workspacePolicy, tools: catalog } });
  if (cls.violations.length > 0) throw new AppError("AGENT_EXCEEDS_POLICY", undefined, { details: cls.violations });
  const composed = composeAll({ ceilings: DEFAULT_CEILINGS, workspacePolicy, agent: v.definition });
  if (composed.violations.length > 0) throw new AppError("AGENT_EXCEEDS_POLICY", undefined, { details: composed.violations });
  const effectivePolicies: EffectivePolicies = Object.fromEntries(Object.entries(composed.jobs).map(([slug, r]) => [slug, { policy: r.effective, hash: r.effectivePolicyHash }]));

  const applied = await applyRuleChange(tx, s, {
    agentId: b.task.agent_id,
    jobId: b.task.job_id,
    patch: [{ op: "add", path: "/rules/-", value: rule as unknown as Json }],
    widenedItems: cls.widenItems as unknown as Json[],
    expectedSnapshotId: snap.id,
    definition: v.definition as unknown as JsonObject,
    effectivePolicies,
    clamped: composed.clamped as unknown as Json[],
    ceilingsVersion: CEILINGS_VERSION,
    decidedBy: s.userId,
    sourceTaskId: b.task.id,
    rule: { id: rule.id, sourceIntentId: b.intent.id, createdWhileTainted },
    now,
  });
  if (applied === null) throw new AppError("CHANGE_NOT_PENDING", "設定が別の変更で更新されました。もう一度確認してください");
  return rule;
}

/** コミットのあと：再判定 → gateway の実行。実行できなくても承認は残す（Intent は approved のまま） */
export async function executeApproved(deps: Deps, s: SessionCtx, intentId: Uuid): Promise<ExecutionView> {
  try {
    const r = await recheckBeforeExecute(deps, s, intentId);
    if (!r.ok) return { status: "expired", failReason: null, expiredReason: "policy_changed" };
    const e = await deps.gatewayClient.executeIntent(intentId);
    return { status: e.status, failReason: e.failReason, expiredReason: e.expiredReason };
  } catch (error) {
    deps.log.error("approval.execute_failed", "承認した Intent を実行できなかった（approved のまま。あとで拾い直す）", {
      workspaceId: s.workspaceId,
      intentId,
      error: error instanceof GatewayClientError ? `${error.status} ${error.code}` : error,
    });
    return { status: "not_started", failReason: null, expiredReason: null };
  }
}

