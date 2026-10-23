// recordMcpIntent（M-14。packages/edge/src/intents.ts の WorkspaceDO 版）：判定済みの結果（LLM Proxy で kind: 'tool_call' として1回だけ decide したもの）から Intent と承認を保存する。
// 中で decide を呼ばない。状態の決め方は IA §3.5 の表を上から（試し実行 → allow → approve → deny・halt・handoff）。
// intentHash・destination_key・option_digest・taint_snapshot・期限（kernel の computeApprovalExpiry）・decision_detail を入れる。
// 承認の行は本番のタスクだけ（試し実行のタスクは承認の行を作らない：DB §4.6）
// Node 版との違い：同期で、呼ぶ側の db.transaction の中で呼ぶ。承認者の材料（listMembershipRoles）は DO の中ではワークスペースの持ち主1人。
// 記録のあとの onIntentRecorded（app の check/hooks.ts：approved なら gateway の実行、pending_approval なら確認の行の SSE）は移さない。
// 呼ぶ側（edgeLlmSettle）が記録した Intent の ID と状態を返し、DO の側がつなぐ（4d・4e）

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
import { appendAuditLog } from "../db/audit.ts";
import { getActiveCredentialId, getAskRow, hasApprovedDestination, insertActionIntent, insertApproval, listMembershipRoles } from "../db/repo/edge.ts";
import type { WsDb } from "../db/sqlite.ts";
import type { IntentStatus, TaskRow, Uuid } from "../db/types.ts";
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
  /** 判定の結果（decide の戻り値そのもの） */
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

/** IA §3.5 の表（上から）。halt・handoff は denied（IA §8-9） */
export function intentStatusFor(
  task: Pick<TaskRow, "is_dry_run">,
  r: Pick<DecideResult, "decision">,
): { status: Extract<IntentStatus, "simulated" | "denied" | "pending_approval" | "approved">; agentStatus: AgentIntentStatus } {
  // 試し実行は判定にかかわらず simulated（BR-24）。戻り値は判定どおり
  if (task.is_dry_run) return { status: "simulated", agentStatus: agentStatusOf(r.decision) };
  if (r.decision === "allow") return { status: "approved", agentStatus: "accepted" };
  if (r.decision === "approve") return { status: "pending_approval", agentStatus: "pending_approval" };
  return { status: "denied", agentStatus: "denied" };
}

/**
 * 判定済みの MCP の書き込みを Intent にする（M-14）。同じトランザクションで、本番の approve なら承認（期限・承認者・リスク・初めての宛先）も作り、
 * 監査ログ intent.proposed（と approval.requested）を足す。decision.made は呼び出し側（判定の記録と一緒に）
 */
export function recordMcpIntent(db: WsDb, input: RecordMcpIntentInput): RecordedMcpIntent {
  const { task, mcp, args, result, now } = input;
  const { status, agentStatus } = intentStatusFor(task, result);
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
    const ask = task.ask_id === null ? null : getAskRow(db, task.ask_id);
    const e = computeApprovalExpiry({ createdAt: now.toISOString(), askNextRunAt: ask?.next_run_at?.toISOString() ?? null });
    expiry = { expiresAt: new Date(e.expiresAt), cause: e.cause };
  }

  const intentId = insertActionIntent(
    db,
    {
      taskId: task.id,
      jobId: task.job_id,
      connectorId: mcp.connector.id,
      connectorCredentialId: mcp.connector.auth.type === "oauth" ? getActiveCredentialId(db, mcp.connector.id) : null,
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
      enforced: true,
      policyHash: input.policyHash,
      intentHash,
      expiresAt: expiry?.expiresAt ?? null,
    },
    now,
  );

  let approvalId: Uuid | null = null;
  if (status === "pending_approval" && !task.is_dry_run && expiry !== null) {
    const members = listMembershipRoles(db);
    const roles: Record<string, KernelMemberRole> = Object.fromEntries(members.map((m) => [m.user_id, m.role]));
    const approverIds = computeApproverIds({
      policyApprovers: input.policy.approvers,
      requesterId: task.requester_id,
      workspaceOwners: members.filter((m) => m.role === "owner").map((m) => m.user_id),
      roles,
    });
    // 承認者が1人もいない承認は作れない（approver_ids は1人以上：CHECK）。ワークスペースの所属が壊れている
    if (approverIds.length === 0) throw new EdgeDataError("ワークスペースに承認者がいない");
    const risk = mcpRiskScore({
      tainted: isTainted(input.taint),
      matchesAnyRule: destinationMatchesAnyRule(input.policy.rules.items, mcp.action, args, mcp.info, input.policy.rules.enabled),
      containsProfileValue: false, // 0-H はプロフィールがない（IA §3.7-3）
      origin: input.origin,
      scopeSelf: mcp.info.scope === "self",
    });
    const firstDestination = !hasApprovedDestination(db, task.job_id, dKey);
    approvalId = insertApproval(
      db,
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

  appendAuditLog(
    db,
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
        enforced: true,
        tainted: isTainted(input.taint),
      },
    },
    now,
  );
  if (approvalId !== null && expiry !== null) {
    appendAuditLog(
      db,
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
    intentHash,
    destinationKey: dKey,
    optionDigest: oDigest,
    expiresAt: expiry?.expiresAt ?? null,
  };
}
