// decide()（FR-004。KD §3.2 の手順1〜11 を M-01・M-14・M-18・M-19 で直したもの）と、実行前の再判定 recheckIntent()（M-20）
// 純粋関数：I/O・Date.now・Math.random を使わず、入力を変えない。保存・カウンタの更新・汚染の記録は呼び出し側（ADR-001）
// 汚染（taint）は inputsHash にだけ入り、どの手順の条件にも出てこない（BR-39・D-58）。shadow は入力に取らない（BR-67・D-62）
// SG-07：run_command を run_tests と run_shell のどちらとして判定するかは、edge が判定の入力を作るときに operationOfCommand(command, 汚染)
// で決めて subject.commandOperation に入れる。汚染が効くのは「どの操作として判定するか」だけで、ここの手順の条件には出てこない
// matchedRule のパスは cross-check §4.2。判定できない入力（有限でない数値など）は例外にし、呼び出し側は許可しない（NFR-005）

import { firstGuardViolation } from "./guards.ts";
import { computeInputsHash, computeRecheckInputsHash, destinationKey, repeatKeyOf } from "./hashes.ts";
import { toMicroUsd } from "./money.ts";
import { operationOf } from "./operations.ts";
import { findMatchingRule } from "./rules.ts";
import { CATALOG_TOOLS } from "./types.ts";
import type {
  AutonomyLevel,
  Counters,
  DecideResult,
  Decision,
  DecisionDetail,
  EffectivePolicy,
  Flags,
  Hex64,
  OperationType,
  ReasonCode,
  Subject,
  TaintState,
  TaskStatus,
  ToolInfo,
} from "./types.ts";

/** 終了状態（st:45-50）。手順1で task_terminated。awaiting_approval・executing は通す */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "completed",
  "rejected",
  "failed",
  "cancelled",
  "halted",
]);

type Out = (decision: Decision, reasonCode: ReasonCode, matchedRule?: string | null, detail?: DecisionDetail) => DecideResult;

function makeOut(inputsHash: Hex64, operation: OperationType | null): Out {
  return (decision, reasonCode, matchedRule = null, detail) => ({
    decision,
    reasonCode,
    matchedRule,
    inputsHash,
    operation,
    ...(detail === undefined ? {} : { detail }),
  });
}

/** 記録用の操作の種類（M-15）。どの手順の結果にも同じ値を付ける。llm_call・finish・連絡板・不明は null */
function operationField(subject: Subject): OperationType | null {
  const op = operationOf(subject);
  return op === "none" || op === "unknown" ? null : op;
}

/** 比較に使う数値。有限でなければ例外（欠けた上限で比較が素通りしないように） */
function num(n: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) throw new TypeError("decide: 有限の数値でない入力がある");
  return n;
}

/** 配列でない一覧（文字列など）は String.prototype.includes の部分一致で通ってしまうので、一致なしとして扱う（判定できないなら許可しない：NFR-005） */
function inList(list: readonly string[], v: unknown): boolean {
  return Array.isArray(list) && typeof v === "string" && list.includes(v);
}

/** 'mcp.<connector>.<tool>'。connector は '.' を含まず、tool は残り全部（KC §8 #7、MT D-02） */
function parseMcpAction(action: string | undefined): { connector: string; tool: string } | null {
  if (typeof action !== "string" || !action.startsWith("mcp.")) return null;
  const rest = action.slice(4);
  const i = rest.indexOf(".");
  if (i <= 0 || i === rest.length - 1) return null;
  return { connector: rest.slice(0, i), tool: rest.slice(i + 1) };
}

/** 手順4〜11 の文脈。intentsCount が null なら手順6を飛ばす（recheckIntent：Intent はもう数えてある） */
interface ActionContext {
  intentsCount: number | null;
  unknownOutcomeKeys: readonly Hex64[];
  certificateValid: boolean;
}

/** 手順4〜11（decide と recheckIntent で共有） */
function judgeAction(policy: EffectivePolicy, subject: Subject, ctx: ActionContext, out: Out): DecideResult {
  // 4-1 LLM の呼び出しは予算・Breaker のためだけに判定する（KD §8-29）
  if (subject.kind === "llm_call") return out("allow", "not_gated");

  // 4-2 カタログにない（intent になれるのは mcp_call・open_pr・notify だけ）
  const t = subject.actionType;
  if (subject.kind === "tool_call") {
    if (!inList(CATALOG_TOOLS, t)) return out("deny", "unknown_action");
  } else if (subject.kind !== "intent" || (t !== "mcp_call" && t !== "open_pr" && t !== "notify")) {
    return out("deny", "unknown_action");
  }

  // 4-3 finish は常に許可（cat:79）。連絡板・利用者への質問（ask_user）は外へ出ないので判定の外（M-22）。どれも手順1〜3は先に効く
  // load_skill は担当自身のスキル（プラットフォームが持つ手順書）を読むだけで外へ出ない（10/14。パックのスキル）
  if (t === "finish" || t === "team_post" || t === "team_wait" || t === "ask_user" || t === "load_skill") return out("allow", "not_gated");

  // 4-4 この仕事で LLM に渡していないツール（tool_call だけ。deliver の intent はテンプレートで縛らない：M-14）
  if (subject.kind === "tool_call" && !inList(policy.tools, t)) {
    return out("deny", "not_granted", "tools", { kind: "not_granted", what: "tools" });
  }

  // 4-5 MCP：付与・LLM／届け先が書き込めるか（M-01）。watcher は llmWrite・deliverWrite が false なので名前で見ない
  let mcp: { action: string; tool: ToolInfo } | null = null;
  if (t === "mcp_call") {
    const tool = subject.tool;
    const parsed = parseMcpAction(subject.action);
    if (!tool || parsed === null) return out("deny", "unknown_action");
    const grants = policy.mcp.grants;
    const granted = Object.hasOwn(grants, parsed.connector) ? grants[parsed.connector] : undefined;
    if (!Array.isArray(granted) || !granted.includes(parsed.tool)) {
      return out("deny", "not_granted", `mcp.grants.${parsed.connector}`, { kind: "not_granted", what: "grants" });
    }
    const writes = tool.classification !== "read"; // unclassified は書き込み扱い（ADR-022）
    if (subject.kind === "tool_call") {
      if (writes && policy.mcp.llmWrite !== true) {
        return out("deny", "not_granted", "mcp.llmWrite", { kind: "not_granted", what: "llm_write" });
      }
      // 読み取りを LLM に許していない（compose が tools から mcp_call を外すので普通は 4-4 で止まる。detail の what に値がないので付けない）
      if (!writes && policy.mcp.llmRead !== true) return out("deny", "not_granted", "mcp.llmRead");
    } else if (writes && policy.mcp.deliverWrite !== true) {
      return out("deny", "not_granted", "mcp.deliverWrite", { kind: "not_granted", what: "deliver_write" });
    }

    // 5 ツールの状態（ルールがあっても、合格証があっても deny）。needs_review が先（gov:66 の順）
    if (tool.status !== "ok") return out("deny", "tool_needs_review");
    if (tool.connectorEnabled !== true) return out("deny", "connector_disabled");
    mcp = { action: subject.action as string, tool };
  }

  // 4-6 操作の種類（ここまで来れば必ず決まる）
  const op = operationOf(subject);
  if (op === "none" || op === "unknown") return out("deny", "unknown_action");

  // 6 Intent の数（Intent を作る操作だけ。KD §8-6）。既定5なら5件目まで通り、6件目で止まる
  if ((op === "mcp_write" || op === "open_pr") && ctx.intentsCount !== null) {
    const limit = num(policy.max_intents_per_task);
    if (ctx.intentsCount + 1 > limit) {
      return out("deny", "intent_limit", "max_intents_per_task", { kind: "intent_limit", count: ctx.intentsCount, limit });
    }
  }

  // 7 パス（開発のみ。0-H は subject.paths が常に [] で、実効ポリシーにも paths がない）

  // 8 自律レベル。Hard Ceiling は判定の中でも守る（KD §8-27）：shell_network・merge は常に deny、mcp_write・run_shell の auto は approve
  //   （run_shell のキーがない古い実効ポリシーは、キーがないので deny）
  const autonomyPath = `autonomy.${op}`;
  let level: AutonomyLevel | undefined = Object.hasOwn(policy.autonomy, op) ? policy.autonomy[op] : undefined;
  if (op === "shell_network" || op === "merge") level = "deny";
  else if ((op === "mcp_write" || op === "run_shell") && level === "auto") level = "approve";
  if (level === "auto") return out("allow", "autonomy_auto", autonomyPath);
  if (level === "handoff") return out("handoff", "autonomy_handoff", autonomyPath);
  if (level !== "approve") return out("deny", "autonomy_deny", autonomyPath); // キーがない・知らない値も deny（KD §8-28）
  // mcp_write 以外の approve は手順9〜11の対象がない（KD §8-32）
  if (op !== "mcp_write") return out("approve", "approval_required", autonomyPath);
  if (mcp === null) return out("deny", "unknown_action"); // mcp_write は mcp_call からしか導かれない

  // 9 結果の分からない書き込み（BR-68・D-61）。ルール・合格証・ガードの範囲内でも approve
  const key = destinationKey(mcp.action, subject.args, mcp.tool.argRoles);
  if (ctx.unknownOutcomeKeys.includes(key)) {
    return out("approve", "unknown_outcome_pending", null, { kind: "unknown_outcome", destinationKey: key });
  }

  // 10 ガード（BR-61）。ルールの有無・合格証の有無にかかわらず効く
  const violation = firstGuardViolation(policy.guards, mcp.action, subject.args);
  if (violation !== null) {
    const guard = policy.guards[violation.index]!;
    return out("approve", "guard_exceeded", `guards[${violation.index}]`, {
      kind: "guard",
      argPath: violation.argPath,
      value: violation.value,
      found: violation.found,
      guard: { ...guard },
    });
  }

  // 11 ルール。approve を allow にできるのはここだけ（ADR-035）
  if (policy.rules.enabled !== true || mcp.tool.classification !== "write") {
    return out("approve", "approval_required", "autonomy.mcp_write"); // ルールが効かない・未分類はルールを持てない
  }
  const search = findMatchingRule(policy.rules.items, mcp.action, subject.args, mcp.tool, true);
  if (!search.matched) {
    const m = search.firstMismatch;
    return out(
      "approve",
      "approval_required",
      "autonomy.mcp_write",
      m === null ? undefined : { kind: "rule_mismatch", ruleIndex: m.ruleIndex, argPath: m.argPath, role: m.role },
    );
  }
  const rulePath = `rules.items[${search.index}]`;
  // 一致したルールの id も結果に付ける（SG-09：判定の記録から「最後に使った時刻」を引けるように）。判定そのものは変えない
  const ruleId = policy.rules.items[search.index]?.id;
  const withRuleId = (r: DecideResult): DecideResult => (typeof ruleId === "string" ? { ...r, matchedRuleId: ruleId } : r);
  // 合格証は一致したときだけ確かめる（M-18）。一致しない承認は approval_required のまま（ADR-039:31）
  if (ctx.certificateValid !== true) return withRuleId(out("approve", "certificate_missing", rulePath));
  return withRuleId(out("allow", "rule_matched", rulePath));
}

/** FR-004 の判定。上から順に評価し、最初に当てはまったものを返す（gov:61） */
export function decide(
  policy: EffectivePolicy,
  subject: Subject,
  counters: Counters,
  flags: Flags,
  taint: TaintState,
): DecideResult {
  const inputsHash = computeInputsHash(policy, subject, counters, flags, taint);
  const out = makeOut(inputsHash, operationField(subject));

  // 1 停止。Kill Switch が先
  if (flags.killSwitchEngaged) return out("halt", "kill_switch");
  if (TERMINAL_STATUSES.has(flags.taskStatus)) return out("halt", "task_terminated");

  // 2 予算。「超える（>）」で止める（ちょうどは通す）。金額はマイクロドルの整数で比べる。
  //   全体 $10/日・リハーサル1回 $0.5 は decide の外（checkSpend・canStartWork。M-19）
  const b = policy.budget;
  const adding = Math.max(0, subject.estimatedCostUsd ?? 0); // 負の見積もりで予算をすり抜けさせない
  const est = toMicroUsd(adding);
  if (subject.kind === "llm_call" && num(counters.stepsUsed) + 1 > num(b.max_steps)) {
    // 1ステップ＝LLM 呼び出し1回なので llm_call だけに効かせる（KD §8-4）
    return out("halt", "budget_exceeded", "budget.max_steps", {
      kind: "budget",
      item: "max_steps",
      used: counters.stepsUsed,
      adding: 1,
      limit: b.max_steps,
    });
  }
  const usd = (item: "per_task_usd" | "per_day_usd" | "agent_day_usd", used: number, limit: number) =>
    toMicroUsd(used) + est > toMicroUsd(limit)
      ? out("halt", "budget_exceeded", `budget.${item}`, { kind: "budget", item, used, adding, limit })
      : null;
  const overBudget =
    usd("per_task_usd", counters.costUsd, b.per_task_usd) ??
    usd("per_day_usd", counters.dayCostUsd, b.per_day_usd) ??
    (b.agent_day_usd === null ? null : usd("agent_day_usd", counters.agentDayCostUsd, b.agent_day_usd));
  if (overBudget !== null) return overBudget;
  if (num(counters.elapsedSec) > num(b.max_minutes) * 60) {
    return out("halt", "budget_exceeded", "budget.max_minutes", {
      kind: "budget",
      item: "max_minutes",
      used: counters.elapsedSec,
      adding: 0,
      limit: b.max_minutes * 60,
    });
  }

  // 3 Breaker（FR-014 の表の順）
  const br = policy.breakers;
  if (
    subject.kind === "tool_call" &&
    counters.repeatKey !== null &&
    num(counters.repeatCount) + 1 >= num(br.same_action_repeat) &&
    counters.repeatKey === repeatKeyOf(subject)
  ) {
    // 以上（≥）で止まる：閾値5なら同じ呼び出しの5回目で止まる（seqc:150）
    return out("halt", "breaker_tripped", "breakers.same_action_repeat", {
      kind: "breaker",
      breaker: "same_action_repeat",
      value: counters.repeatCount + 1,
      threshold: br.same_action_repeat,
    });
  }
  if (num(counters.deniedCount) >= num(br.denied_attempts_max)) {
    return out("halt", "breaker_tripped", "breakers.denied_attempts_max", {
      kind: "breaker",
      breaker: "denied_attempts_max",
      value: counters.deniedCount,
      threshold: br.denied_attempts_max,
    });
  }
  if (subject.kind === "llm_call" && est > toMicroUsd(br.step_cost_usd_max)) {
    return out("halt", "breaker_tripped", "breakers.step_cost_usd_max", {
      kind: "breaker",
      breaker: "step_cost_usd_max",
      value: adding,
      threshold: br.step_cost_usd_max,
    });
  }

  // 4〜11
  return judgeAction(
    policy,
    subject,
    {
      intentsCount: num(counters.intentsCount),
      unknownOutcomeKeys: counters.unknownOutcomeKeys,
      certificateValid: flags.certificateValid,
    },
    out,
  );
}

/**
 * 承認済み・実行前の再判定（M-20、D-46）。手順4〜11だけ（予算・Breaker・時間・Kill Switch は見ない）。
 * Intent はもう数えてあるので手順6（intent_limit）も見ない。
 * 呼び出し側：policyHash が今の実効ポリシーと違うときだけ呼び、deny → expired（policy_changed）、人の承認済みの approve と allow → 実行
 */
export function recheckIntent(
  policy: EffectivePolicy,
  subject: Subject,
  ctx: { unknownOutcomeKeys: readonly Hex64[]; certificateValid: boolean },
): DecideResult {
  const out = makeOut(computeRecheckInputsHash(policy, subject, ctx), operationField(subject));
  return judgeAction(
    policy,
    subject,
    { intentsCount: null, unknownOutcomeKeys: ctx.unknownOutcomeKeys, certificateValid: ctx.certificateValid },
    out,
  );
}

/**
 * denied_attempts_max に数える deny か。run_shell の自律レベルによる deny（作業場の許可リストにない形・外の内容のあとのコマンド：SG-07）は数えない。
 * 担当はどの形なら動くかを試しながら進むので、ls・cat・pip install の3回で次の正しい npm test が止まらないようにする
 * （同じ呼び出しの繰り返しは same_action_repeat、試し続けるのは max_steps・予算で止まる）。
 * 数えないかどうかは操作（run_shell）と理由（autonomy_deny）だけで決め、汚染は見ない（BR-39：汚染は decide の条件に出てこない）。
 * run_command を渡していない（not_granted）など、ほかの理由の deny は今までどおり数える
 */
function countsAsDenied(result: Pick<DecideResult, "decision" | "reasonCode" | "operation">): boolean {
  if (result.decision !== "deny") return false;
  return !(result.operation === "run_shell" && result.reasonCode === "autonomy_deny");
}

/**
 * FR-014 のカウンタの更新（KD §3.4-4。gov:142-145）。
 * tool_call は repeatKey を今回のキーにし、直前と同じなら repeatCount + 1、違えば 1。deny なら deniedCount + 1
 * （run_shell の autonomy_deny は数えない：countsAsDenied・SG-07）。
 * Intent の行を作ったら intentsCount + 1（denied の Intent も数える：KD §8-6）。stepsUsed・costUsd は LLM の呼び出しのあとに呼び出し側が実費で足す
 */
export function nextCounters(counters: Counters, subject: Subject, result: DecideResult, intentCreated: boolean): Counters {
  let repeatKey = counters.repeatKey;
  let repeatCount = counters.repeatCount;
  if (subject.kind === "tool_call") {
    const key = repeatKeyOf(subject);
    repeatCount = key === counters.repeatKey ? counters.repeatCount + 1 : 1;
    repeatKey = key;
  }
  return {
    stepsUsed: counters.stepsUsed,
    costUsd: counters.costUsd,
    dayCostUsd: counters.dayCostUsd,
    agentDayCostUsd: counters.agentDayCostUsd,
    elapsedSec: counters.elapsedSec,
    deniedCount: counters.deniedCount + (countsAsDenied(result) ? 1 : 0),
    repeatKey,
    repeatCount,
    intentsCount: counters.intentsCount + (intentCreated ? 1 : 0),
    unknownOutcomeKeys: [...counters.unknownOutcomeKeys],
  };
}
