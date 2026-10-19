// recordMcpIntent（M-14）：判定済みの結果（LLM Proxy で kind: 'tool_call' として1回だけ decide したもの）から Intent と承認を保存する。
// 中で decide を呼ばない。状態の決め方は IA §3.5 の表を上から（試し実行 → 影 → allow → approve → deny・halt・handoff）。
// intentHash・destination_key・option_digest・taint_snapshot・期限（kernel の computeApprovalExpiry）・decision_detail を入れる。
// 承認の行は本番のタスクだけ（リハーサル・影のタスクは承認の行を作らない：DB §4.6・IA §3.22）

import {
  computeApprovalExpiry,
  computeApproverIds,
  computeMcpIntentHash,
  destinationKey,
  destinationMatchesAnyRule,
  isTainted,
  mcpRiskScore,
  optionDigest,
  type DecideResult,
  type EffectivePolicy,
  type Hex64,
  type JsonObject,
  type MemberRole as KernelMemberRole,
  type TaintState,
} from "@open-team/kernel";
import { appendAuditLog, type IntentStatus, type TaskRow, type Tx, type Uuid, type WsCtx } from "@open-team/db";
import { getActiveCredentialId, getAskRow, hasApprovedDestination, insertActionIntent, insertApproval, listMembershipRoles } from "@open-team/db/edge";
import type { McpTarget } from "./inputs.ts";
import { EdgeDataError } from "./inputs.ts";

/** エージェントに返す状態（runner の GovernanceEntry.intent.status。A-87：結果は待たない） */
export type AgentIntentStatus = "pending_approval" | "accepted" | "denied";

export interface RecordMcpIntentInput {
  /** ロック済みのタスクの行 */
  task: TaskRow;
  mcp: McpTarget;
  /** 判定に使った引数（trimRoleStrings 済み）。Gateway はこのまま送る */
  args: JsonObject;
  origin: "agent" | "deliver";
  /** 判定の結果（decide の戻り値そのもの。影でも記録は判定どおり） */
  result: DecideResult;
  policy: EffectivePolicy;
  policyHash: Hex64;
  /** Intent を作った時点の汚染（カードの情報源はこれを出す：MT §2.8） */
  taint: TaintState;
  now: Date;
}

export interface RecordedMcpIntent {
  intentId: Uuid;
  status: IntentStatus;
  agentStatus: AgentIntentStatus;
  approvalId: Uuid | null;
  enforced: boolean;
  intentHash: Hex64;
  destinationKey: Hex64;
  optionDigest: Hex64;
  expiresAt: Date | null;
}

function agentStatusOf(decision: DecideResult["decision"]): AgentIntentStatus {
  if (decision === "allow") return "accepted";
  if (decision === "approve") return "pending_approval";
  return "denied";
}

/**
 * 影の走行で「記録だけ」にする判定か（SW §4.5-2、KD §8-40）：deny・approve・handoff と Breaker の halt。
 * Kill Switch・タスクの終了・予算の halt は影でも効かせる（費用と停止は守る）。allow はそもそも止めない
 */
export function shadowIgnores(r: Pick<DecideResult, "decision"> & { reasonCode: string }): boolean {
  if (r.decision === "allow") return false;
  if (r.decision === "halt") return r.reasonCode === "breaker_tripped";
  return true;
}

/** IA §3.5 の表（上から）。halt・handoff は denied（IA §8-9） */
export function intentStatusFor(
  task: Pick<TaskRow, "is_dry_run" | "rehearsal_run_id" | "shadow">,
  r: Pick<DecideResult, "decision"> & { reasonCode: string },
): { status: Extract<IntentStatus, "simulated" | "denied" | "pending_approval" | "approved">; agentStatus: AgentIntentStatus; enforced: boolean } {
  // 試し実行（リハーサルでない）は判定にかかわらず simulated（BR-24）。戻り値は判定どおり
  if (task.is_dry_run && task.rehearsal_run_id === null) return { status: "simulated", agentStatus: agentStatusOf(r.decision), enforced: true };
  if (task.shadow) {
    // 影でも Kill Switch・予算の halt は効かせる（タスクは止まる。Intent は実行しない）
    if (r.decision === "halt" && !shadowIgnores(r)) return { status: "denied", agentStatus: "denied", enforced: true };
    // 影の走行は記録だけ。gateway が auto として sim-world に書く（BR-67 ③、SW §4.5-3）
    return { status: "approved", agentStatus: "accepted", enforced: false };
  }
  if (r.decision === "allow") return { status: "approved", agentStatus: "accepted", enforced: true };
  if (r.decision === "approve") return { status: "pending_approval", agentStatus: "pending_approval", enforced: true };
  return { status: "denied", agentStatus: "denied", enforced: true };
}

/**
 * 判定済みの MCP の書き込みを Intent にする（M-14）。同じトランザクションで、本番の approve なら承認（期限・承認者・リスク・初めての宛先）も作り、
 * 監査ログ intent.proposed（と approval.requested）を足す。decision.made は呼び出し側（判定の記録と一緒に）
 */
export async function recordMcpIntent(tx: Tx, ctx: WsCtx, input: RecordMcpIntentInput): Promise<RecordedMcpIntent> {
  const { task, mcp, args, result, now } = input;
  const { status, agentStatus, enforced } = intentStatusFor(task, result);
  const dKey = destinationKey(mcp.action, args, mcp.info.argRoles);
  const oDigest = optionDigest(mcp.action, args, mcp.info.argRoles);
  const intentHash = computeMcpIntentHash({
    connectorId: mcp.connector.id,
    tool: mcp.tool.name,
    arguments: args,
    toolHash: mcp.tool.tool_hash,
    effectivePolicyHash: input.policyHash,
  });

  // 期限：作成から24時間と、そのタスクの依頼の次の実行の早い方（M-25）
  let expiry: { expiresAt: Date; cause: "ttl" | "next_run" } | null = null;
  if (status === "pending_approval") {
    const ask = task.ask_id === null ? null : await getAskRow(tx, ctx, task.ask_id);
    const e = computeApprovalExpiry({ createdAt: now.toISOString(), askNextRunAt: ask?.next_run_at?.toISOString() ?? null });
    expiry = { expiresAt: new Date(e.expiresAt), cause: e.cause };
  }

  const intentId = await insertActionIntent(
    tx,
    ctx,
    {
      taskId: task.id,
      jobId: task.job_id,
      connectorId: mcp.connector.id,
      connectorCredentialId: mcp.connector.auth.type === "oauth" ? await getActiveCredentialId(tx, ctx, mcp.connector.id) : null,
      action: mcp.action,
      origin: input.origin,
      payload: { connectorId: mcp.connector.id, tool: mcp.tool.name, arguments: args, toolHash: mcp.tool.tool_hash },
      toolHash: mcp.tool.tool_hash,
      destinationKey: dKey,
      optionDigest: oDigest,
      taintSnapshot: input.taint,
      status,
      decision: result.decision,
      reasonCode: result.reasonCode,
      matchedRule: result.matchedRule,
      decisionDetail: result.detail === undefined ? null : (structuredClone(result.detail) as unknown as JsonObject),
      enforced,
      policyHash: input.policyHash,
      intentHash,
      expiresAt: expiry?.expiresAt ?? null,
    },
    now,
  );

  let approvalId: Uuid | null = null;
  const live = task.rehearsal_run_id === null && !task.shadow && !task.is_dry_run;
  if (status === "pending_approval" && live && expiry !== null) {
    const members = await listMembershipRoles(tx, ctx);
    const roles: Record<string, KernelMemberRole> = Object.fromEntries(members.map((m) => [m.user_id, m.role]));
    const approverIds = computeApproverIds({
      policyApprovers: input.policy.approvers,
      requesterId: task.requester_id,
      workspaceOwners: members.filter((m) => m.role === "owner").map((m) => m.user_id),
      roles,
    });
    // 承認者が1人もいない承認は作れない（approver_ids は1人以上：CHECK）。ワークスペースの所属が壊れている
    if (approverIds.length === 0) throw new EdgeDataError(`ワークスペース ${ctx.workspaceId} に承認者がいない`);
    const risk = mcpRiskScore({
      tainted: isTainted(input.taint),
      matchesAnyRule: destinationMatchesAnyRule(input.policy.rules.items, mcp.action, args, mcp.info, input.policy.rules.enabled),
      containsProfileValue: false, // 0-H はプロフィールがない（IA §3.7-3）
      origin: input.origin,
      scopeSelf: mcp.info.scope === "self",
    });
    const firstDestination = !(await hasApprovedDestination(tx, ctx, task.job_id, dKey));
    approvalId = await insertApproval(
      tx,
      ctx,
      {
        taskId: task.id,
        intentId,
        riskLevel: risk.level,
        riskScore: risk.score,
        riskReasons: risk.reasons,
        approverIds,
        expiresAt: expiry.expiresAt,
        expiryCause: expiry.cause,
        firstDestination,
      },
      now,
    );
  }

  await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "intent.proposed",
      actorType: "agent",
      actorId: task.agent_id,
      taskId: task.id,
      payload: {
        taskId: task.id,
        intentId,
        action: mcp.action,
        origin: input.origin,
        status,
        decision: result.decision,
        reasonCode: result.reasonCode,
        matchedRule: result.matchedRule,
        intentHash,
        destinationKey: dKey,
        optionDigest: oDigest,
        policyHash: input.policyHash,
        enforced,
        tainted: isTainted(input.taint),
      },
    },
    now,
  );
  if (approvalId !== null && expiry !== null) {
    await appendAuditLog(
      tx,
      ctx.workspaceId,
      {
        eventType: "approval.requested",
        actorType: "system",
        actorId: "edge",
        taskId: task.id,
        payload: { taskId: task.id, intentId, approvalId, expiresAt: expiry.expiresAt.toISOString(), expiryCause: expiry.cause },
      },
      now,
    );
  }

  return {
    intentId,
    status,
    agentStatus,
    approvalId,
    enforced,
    intentHash,
    destinationKey: dKey,
    optionDigest: oDigest,
    expiresAt: expiry?.expiresAt ?? null,
  };
}
