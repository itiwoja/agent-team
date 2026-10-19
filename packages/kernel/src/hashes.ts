// ハッシュ（M-07：tool_hash だけ 'sha256:' つき、ほかは接頭辞なしの小文字16進64桁）
// すべて canonical.ts の正規形 JSON で計算する（M-08）

import { argPathsByRole, extractArg, normalizeForMatch } from "./args.ts";
import { hashCanonical } from "./canonical.ts";
import { OPERATION_TYPES } from "./types.ts";
import type {
  ArgRole,
  ArgRoleMap,
  Counters,
  DirectTaintSource,
  EffectivePolicy,
  Flags,
  Hex64,
  Json,
  JsonObject,
  Subject,
  TaintState,
  ToolHash,
} from "./types.ts";

/**
 * ツールのハッシュ（MT §3.2、mcp-and-web.md:50）：説明文・入力スキーマ・確定の arg_roles だけ。
 * description は取得したまま（trim しない）。annotations・name・title は入れない（余計な項目を渡されても拾わない）
 */
export function toolHashOf(t: { description: string; inputSchema: Json; argRoles: ArgRoleMap }): ToolHash {
  return `sha256:${hashCanonical({ description: t.description, inputSchema: t.inputSchema, argRoles: t.argRoles })}`;
}

/**
 * MCP の Intent のハッシュ（intents.md:79、IA §3.1-4）。arguments は正規化しない（Gateway に渡す値そのものを固める）。
 * origin・jobId・taskId は入れない
 */
export function computeMcpIntentHash(i: {
  connectorId: string;
  tool: string;
  arguments: JsonObject;
  toolHash: ToolHash;
  effectivePolicyHash: Hex64;
}): Hex64 {
  return hashCanonical({
    actionType: "mcp_call",
    connectorId: i.connectorId,
    tool: i.tool,
    arguments: i.arguments,
    toolHash: i.toolHash,
    effectivePolicyHash: i.effectivePolicyHash,
  });
}

function valuesByRole(args: JsonObject, argRoles: ArgRoleMap, role: ArgRole): JsonObject {
  return Object.fromEntries(argPathsByRole(argRoles, role).map((p) => [p, normalizeForMatch(extractArg(args, p))]));
}

/**
 * 宛先のキー（BR-68・BR-70、KD §3.3-4）：action と全 destination 引数の正規形のハッシュ。
 * 欠けは null（M-10）、'p[].f' は要素の値の多重集合。argRoles にない余計な引数は入れない（M-12。edge がスキーマで先に弾く）
 */
export function destinationKey(action: string, args: JsonObject, argRoles: ArgRoleMap): Hex64 {
  return hashCanonical({ action, destination: valuesByRole(args, argRoles, "destination") });
}

/** option の値のハッシュ（G-05。O-08・回帰の試験の重なり・止まった書き込み）。free の option も含み、content は含まない。欠けは null */
export function optionDigest(action: string, args: JsonObject, argRoles: ArgRoleMap): Hex64 {
  return hashCanonical({ action, options: valuesByRole(args, argRoles, "option") });
}

/** FR-014 の repeatKey（KD §3.3-5）：ツール名＋引数の正規形のハッシュ。trim しない（完全に同じ呼び出しを数える） */
export function repeatKeyOf(subject: Pick<Subject, "actionType" | "action" | "args">): Hex64 {
  return hashCanonical({ action: subject.action ?? subject.actionType ?? null, args: subject.args });
}

// ここから inputsHash（KD §3.3-3）：型にあるキーだけを取り出す（shadow などを誤って渡しても値が変わらない）

function projectPolicy(p: EffectivePolicy) {
  return {
    version: p.version,
    autonomy: Object.fromEntries(OPERATION_TYPES.map((op) => [op, p.autonomy[op]])),
    budget: {
      per_task_usd: p.budget.per_task_usd,
      per_day_usd: p.budget.per_day_usd,
      agent_day_usd: p.budget.agent_day_usd,
      max_steps: p.budget.max_steps,
      max_minutes: p.budget.max_minutes,
    },
    breakers: {
      same_action_repeat: p.breakers.same_action_repeat,
      denied_attempts_max: p.breakers.denied_attempts_max,
      step_cost_usd_max: p.breakers.step_cost_usd_max,
    },
    max_intents_per_task: p.max_intents_per_task,
    max_runs_per_day: p.max_runs_per_day,
    tools: p.tools,
    mcp: { llmRead: p.mcp.llmRead, llmWrite: p.mcp.llmWrite, deliverWrite: p.mcp.deliverWrite, grants: p.mcp.grants },
    web: { allow_domains: p.web.allow_domains, deny_domains: p.web.deny_domains, max_fetches_per_task: p.web.max_fetches_per_task },
    rules: {
      enabled: p.rules.enabled,
      items: p.rules.items.map((r) => ({ id: r.id, action: r.action, match: r.match, free: r.free, tool_hash: r.tool_hash })),
    },
    guards: p.guards.map((g) => ({
      action: g.action,
      arg: g.arg,
      min: g.min,
      max: g.max,
      max_digits: g.max_digits,
      in: g.in,
      empty: g.empty,
    })),
    approvers: p.approvers,
  };
}

function projectSubject(s: Subject) {
  const t = s.tool;
  return {
    kind: s.kind,
    actionType: s.actionType,
    action: s.action,
    args: s.args,
    paths: s.paths,
    estimatedCostUsd: s.estimatedCostUsd,
    tool: !t
        ? undefined
        : {
            classification: t.classification,
            status: t.status,
            connectorEnabled: t.connectorEnabled,
            argRoles: t.argRoles,
            scope: t.scope,
            toolHash: t.toolHash,
          },
    origin: s.origin,
    // SG-07：run_command の写し先（汚染から決めたもの）も判定の入力
    commandOperation: s.commandOperation,
  };
}

function sortedKeys(keys: readonly Hex64[]): Hex64[] {
  return [...keys].sort();
}

/** 直接読んだ出どころの型にあるキー（M-06）。知らない種類はそのまま（落とすと別の出どころと区別できなくなる） */
function projectDirectSource(s: DirectTaintSource): unknown {
  switch (s.kind) {
    case "mcp_read":
      return { kind: s.kind, connectorId: s.connectorId, connectorSlug: s.connectorSlug, connectorName: s.connectorName, tool: s.tool, at: s.at };
    case "web_search":
      return { kind: s.kind, at: s.at };
    case "web_fetch":
      return { kind: s.kind, url: s.url, at: s.at };
    case "sandbox_run":
      return { kind: s.kind, at: s.at };
    case "skill":
      return { kind: s.kind, name: s.name, packId: s.packId, at: s.at };
    default:
      return s;
  }
}

/** 受け渡し・連絡の upstream。配列でない（壊れた）値はそのまま（判定に使わないので例外にしない） */
function projectUpstream(upstream: readonly DirectTaintSource[]): unknown {
  return Array.isArray(upstream) ? upstream.map(projectDirectSource) : upstream;
}

/** 汚染の出どころも型にあるキーだけ（KD §3.3-3-1。読んだ中身の件名などを誤って持たせても inputsHash が変わらない） */
function projectTaint(t: TaintState) {
  if (!Array.isArray(t.sources)) return { tainted: t.tainted, sources: t.sources }; // 壊れた値はそのまま（判定に使わない）
  return {
    tainted: t.tainted,
    sources: t.sources.map((s) => {
      switch (s.kind) {
        case "handoff":
          return { kind: s.kind, fromTaskId: s.fromTaskId, fromAgentName: s.fromAgentName, upstream: projectUpstream(s.upstream), at: s.at };
        case "workspace_snapshot":
          return { kind: s.kind, snapshotId: s.snapshotId, fromTaskId: s.fromTaskId, upstream: projectUpstream(s.upstream), at: s.at };
        case "team_message":
          return {
            kind: s.kind,
            messageId: s.messageId,
            fromTaskId: s.fromTaskId,
            fromAgentName: s.fromAgentName,
            upstream: projectUpstream(s.upstream),
            at: s.at,
          };
        default:
          return projectDirectSource(s);
      }
    }),
  };
}

/** decide() の inputsHash（KD §3.3-3）。集合の配列（unknownOutcomeKeys）は並べ替える。引数の配列は並べ替えない。KERNEL_VERSION は入れない */
export function computeInputsHash(
  policy: EffectivePolicy,
  subject: Subject,
  counters: Counters,
  flags: Flags,
  taint: TaintState,
): Hex64 {
  return hashCanonical({
    policy: projectPolicy(policy),
    subject: projectSubject(subject),
    counters: {
      stepsUsed: counters.stepsUsed,
      costUsd: counters.costUsd,
      dayCostUsd: counters.dayCostUsd,
      agentDayCostUsd: counters.agentDayCostUsd,
      elapsedSec: counters.elapsedSec,
      deniedCount: counters.deniedCount,
      repeatKey: counters.repeatKey,
      repeatCount: counters.repeatCount,
      intentsCount: counters.intentsCount,
      unknownOutcomeKeys: sortedKeys(counters.unknownOutcomeKeys),
    },
    flags: { killSwitchEngaged: flags.killSwitchEngaged, taskStatus: flags.taskStatus, certificateValid: flags.certificateValid },
    taint: projectTaint(taint),
  });
}

/** recheckIntent() の inputsHash（M-20）。decide() と区別できるよう counters・flags・taint の代わりに recheck を持つ */
export function computeRecheckInputsHash(
  policy: EffectivePolicy,
  subject: Subject,
  ctx: { unknownOutcomeKeys: readonly Hex64[]; certificateValid: boolean },
): Hex64 {
  return hashCanonical({
    policy: projectPolicy(policy),
    subject: projectSubject(subject),
    recheck: { unknownOutcomeKeys: sortedKeys(ctx.unknownOutcomeKeys), certificateValid: ctx.certificateValid },
  });
}
