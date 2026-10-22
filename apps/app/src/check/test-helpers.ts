// 承認・チェックの試験の道具（本番では読み込まれない）
// オーナーで入り（本物の入口と owner-setup）、例の MCP コネクタ（メール・在庫・仕入れ先）をつないだ状態から、
// 順番の依頼（受信箱係 → 仕入れ係）の「1回分を走らせ終えた状態」を入れる：受信箱係は済み、仕入れ係は発注を決めて **送る前の確認が1件** 残る。
// Intent・承認・回答は本番の edge・依頼の実行と同じ関数（kernel の hash・期限・リスク・composeAnswer、db の insert）で作る。
// gateway は偽物（実行は DB に書くだけ。executed に ID が残る）

import type { Db, Queryable, Uuid, WsCtx } from "@open-team/db";
import { getLatestWorkspacePolicy, insertAsk, insertAskMember } from "@open-team/db/app";
import { insertAskMessage, insertAskTask, insertLiveRun, markFirstMemberStarted, saveRunAnswer } from "@open-team/db/asks";
import { insertActionIntent, insertApproval } from "@open-team/db/edge";
import { GatewayClientError, type GwExecuteResponse } from "@open-team/gateway-client";
import {
  EMPTY_TAINT,
  composeAnswer,
  computeApprovalExpiry,
  computeMcpIntentHash,
  destinationKey,
  effectiveArgRoles,
  mcpRiskScore,
  optionDigest,
  parseWorkspacePolicy,
  type AgentDefinitionInput,
  type Hex64,
  type JsonObject,
  type TaintSource,
  type TaintState,
  type ToolHash,
} from "@open-team/kernel";
import { insertWorldConnectorRows, seedAgent } from "../__fixtures__/world.ts";
import { setConnectorEnabledInPolicy } from "../connectors/policy.ts";
import type { AppEnv } from "../env.ts";
import { ensureOwnerWorkspace } from "../owner-setup.ts";
import { nextScheduledRun } from "../schedule.ts";
import { OWNER_TOKEN, fakeGatewayClient, makeTestApp, send, signInOwner, type FakeGateway, type SignedIn, type TestApp } from "../test-helpers.ts";

export interface CheckHarness {
  t: TestApp;
  gateway: FakeGateway & {
    executed: string[];
    /** 次の実行から gateway に届かない（null で戻す） */
    failExecute(status: number | null): void;
  };
}

/** Intent の実行を DB に書くだけの偽の gateway（本物は apps/gateway。実行の経路は gateway の試験が持つ）。executed に ID が残る */
export function checkHarness(db: Db, o: { executeResult?: "executed" | "unknown_outcome"; env?: Partial<AppEnv> } = {}): CheckHarness {
  const base = fakeGatewayClient(db);
  const executed: string[] = [];
  let failure: number | null = null;
  const gateway = Object.assign(base, {
    executed,
    failExecute: (status: number | null) => {
      failure = status;
    },
    async executeIntent(intentId: string): Promise<GwExecuteResponse> {
      if (failure !== null) throw new GatewayClientError(failure, "UPSTREAM");
      executed.push(intentId);
      const status = o.executeResult ?? "executed";
      await db.query(
        `UPDATE action_intents SET status = $2, executed_at = CASE WHEN $2 = 'executed' THEN now() ELSE NULL END, updated_at = now()
          WHERE id = $1 AND status = 'approved'`,
        [intentId, status],
      );
      return { intentId, status, failReason: null, expiredReason: null };
    },
  });
  const t = makeTestApp(db, { ...(o.env ? { env: o.env } : {}), deps: { gatewayClient: gateway } });
  return { t, gateway };
}

export interface CheckSession extends SignedIn {
  /** 用意した順番の依頼 */
  askId: Uuid;
}

/** 発注の中身（いつもの量） */
export const ORDER_ARGS: JsonObject = {
  supplier_id: "supplier-01",
  items: [{ sku: "BEAN-HOUSE", quantity: 20, unit_price: 780 }],
  note: "いつもの量でお願いします",
};

const INBOX_REPORT = {
  title: "新しいメール3通を確認しました",
  body:
    "新しいメールは3通です。\n" +
    "・山田珈琲：次回のハウスブレンドは前回と同じ20kgの予定（数量の変更があれば発注時に知らせてほしいとのこと）\n" +
    "・みどり牧場：来月から「牛乳 1L」を245円から258円に値上げ（今月分は現在の価格）\n" +
    "・佐藤さん：土曜の朝にコーヒー10杯のテイクアウト予約の相談",
};

const PURCHASING_REPORT = {
  title: "豆が残り2kgなので、山田珈琲に20kgを発注します",
  body:
    "豆が残り2kgなので、山田珈琲に20kgを発注します。\n" +
    "ハウスブレンドの在庫が残り2kg（1日3kg使うので、明日の昼には切れます）。山田珈琲のメールの数量は確定ではないため、いつもの量（20kg、1kg 780円）にしました。\n" +
    "発注は、あなたの確認のあとに送ります。",
};

/** 受信箱係（メールを読む） */
function inboxDefinition(): AgentDefinitionInput {
  return {
    version: 2,
    name: "受信箱係",
    role: "research",
    grants: { connectors: { mail: { grant: ["list_inbox"] } } },
    autonomy: {},
    rules: [],
    budget: { per_task_usd: 0.2, per_day_usd: 1 },
    max_runs_per_day: 10,
    profile: [],
    jobs: [
      {
        id: "read-supplier-mail",
        kind: "recurring",
        template: "researcher",
        instructions: "仕入れ先から届いた新しいメールを読んで、数量や価格など仕入れに関係する内容を短くまとめてください。",
        trigger: null,
        deliver: [],
        guards: [],
      },
    ],
  };
}

/**
 * 仕入れ係（在庫を読み、仕入れ先に発注する）。前からある「以後も許可」のルール（r-0001。記録の項目より前の形）が1つ入っている。
 * 別の仕入れ先（supplier-02）のものなので、今回の発注には当たらない
 */
function purchasingDefinition(placeOrderHash: ToolHash, now: Date): AgentDefinitionInput {
  return {
    version: 2,
    name: "仕入れ係",
    role: "assist",
    grants: { connectors: { store: { grant: ["get_inventory"] }, supplier: { grant: ["list_products", "place_order"] } } },
    autonomy: {},
    rules: [
      {
        id: "r-0001",
        action: "mcp.supplier.place_order",
        match: { supplier_id: "supplier-02", "items[].sku": ["BEAN-HOUSE"] },
        free: ["items[].quantity", "items[].unit_price"],
        tool_hash: placeOrderHash,
        added_by: "owner",
        added_at: now.toISOString(),
      },
    ],
    budget: { per_task_usd: 0.2, per_day_usd: 1 },
    max_runs_per_day: 10,
    profile: [],
    jobs: [
      {
        id: "reorder",
        kind: "recurring",
        template: "assistant",
        instructions: "在庫を確認して、足りなくなりそうなものがあれば仕入れ先に発注してください。",
        trigger: null,
        deliver: [],
        guards: [],
      },
    ],
  };
}

/** タスクを走らせ終えた状態にする（本番の edge が書く列だけ。トークンは持たない） */
async function settleTask(
  db: Queryable,
  ctx: WsCtx,
  taskId: Uuid,
  s: { status: "succeeded" | "awaiting_approval"; report: { title: string; body: string; kind: "normal" | "answer" }; startedAt: Date; finishedAt: Date | null; updatedAt: Date; taint: TaintState },
): Promise<void> {
  await db.query(
    `UPDATE tasks SET status = $3, report = $4, report_title = $5, report_kind = $6, steps_used = 3, cost_usd = '0.000000',
                      started_at = $7, last_heartbeat_at = $7, finished_at = $8, tainted = $9, taint_sources = $10::jsonb, updated_at = $11
      WHERE workspace_id = $1 AND id = $2`,
    [ctx.workspaceId, taskId, s.status, s.report.body, s.report.title, s.report.kind, s.startedAt, s.finishedAt, s.taint.tainted, s.taint.sources as unknown as JsonObject[], s.updatedAt],
  );
}

/**
 * オーナーで入り、送る前の確認が1件ある状態を作る（毎日18時の順番の依頼の1回分。受け渡しで汚染されているので、初めての送り先として開いて出る）
 */
export async function enterWithPendingApproval(t: TestApp): Promise<CheckSession> {
  const db = t.deps.db;
  const now = t.clock.now();
  await ensureOwnerWorkspace(t.deps);
  const s = await signInOwner(t);
  const ctx: WsCtx & { userId: Uuid } = { workspaceId: s.workspaceId, kind: "owner", userId: s.userId };
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);

  // コネクタをつなぎ、ワークスペースのポリシーで有効にする（つなぐときと同じ版の足し方）
  const connectors = await insertWorldConnectorRows(db, ctx, ["mail", "store", "supplier"], now);
  await db.transaction(async (tx) => {
    for (const slug of ["mail", "store", "supplier"]) await setConnectorEnabledInPolicy(tx, ctx, { slug, enabled: true, userId: s.userId, now });
  });
  const workspacePolicy = parseWorkspacePolicy((await getLatestWorkspacePolicy(db, ctx))!.policy);
  const supplier = connectors.supplier!;
  const mail = connectors.mail!;
  const orderTool = supplier.tools.place_order!;
  const inbox = await seedAgent(db, ctx, inboxDefinition(), { workspacePolicy, now: at(60) });
  const buyer = await seedAgent(db, ctx, purchasingDefinition(orderTool.toolHash, at(60)), { workspacePolicy, now: at(60) });
  const buyerPolicyHash = (
    await db.query<{ hash: Hex64 }>("SELECT effective_policies->'reorder'->>'hash' AS hash FROM agent_snapshots WHERE id = $1", [buyer.snapshotId])
  ).rows[0]!.hash;

  const trigger = { type: "schedule" as const, cron: "0 18 * * *", timezone: "Asia/Tokyo" };
  const nextRunAt = nextScheduledRun(trigger, now);

  return db.transaction(async (tx) => {
    const ask = await insertAsk(tx, ctx, {
      createdBy: s.userId,
      text: "仕入れ先のメールを読んで、在庫を見て、必要なら発注して",
      shape: "chain",
      status: "running",
      trigger,
      nextRunAt,
      formation: null,
      seedKey: null,
      now: at(30),
    });
    const inboxMember = await insertAskMember(tx, ctx, { askId: ask.id, agentId: inbox.agentId, jobId: inbox.jobId, position: 1, dependsOn: [], isAggregator: false, isSpokesperson: false, isNew: false, summary: "メールを読む", now: at(30) });
    const buyerMember = await insertAskMember(tx, ctx, { askId: ask.id, agentId: buyer.agentId, jobId: buyer.jobId, position: 2, dependsOn: [1], isAggregator: false, isSpokesperson: true, isNew: false, summary: "在庫を見て発注する", now: at(30) });
    const run = (await insertLiveRun(tx, ctx, ask.id, "initial", at(12)))!;
    await markFirstMemberStarted(tx, ctx, run.id, at(12));

    // ---- 受信箱係（済み。メールを読んだので汚染される）----
    const mailRead: TaintSource = { kind: "mcp_read", connectorId: mail.id, connectorSlug: mail.slug, connectorName: mail.displayName, tool: "list_inbox", at: at(9).toISOString() };
    const inboxTaint: TaintState = { tainted: true, sources: [mailRead] };
    const inboxTask = await insertAskTask(tx, ctx, {
      requesterId: s.userId,
      agentId: inbox.agentId,
      agentSnapshotId: inbox.snapshotId,
      jobId: inbox.jobId,
      askId: ask.id,
      askRunId: run.id,
      askMemberId: inboxMember.id,
      inputTaskIds: [],
      taint: EMPTY_TAINT,
      prompt: null,
      now: at(12),
    });
    await settleTask(tx, ctx, inboxTask.id, { status: "succeeded", report: { ...INBOX_REPORT, kind: "normal" }, startedAt: at(12), finishedAt: at(9), updatedAt: at(9), taint: inboxTaint });

    // ---- 仕入れ係（在庫を見て発注を決めた。送る前の確認が1件）----
    const handoff: TaintSource = { kind: "handoff", fromTaskId: inboxTask.id, fromAgentName: "受信箱係", upstream: [mailRead], at: at(9).toISOString() };
    const buyTaint: TaintState = { tainted: true, sources: [handoff] };
    const buyTask = await insertAskTask(tx, ctx, {
      requesterId: s.userId,
      agentId: buyer.agentId,
      agentSnapshotId: buyer.snapshotId,
      jobId: buyer.jobId,
      askId: ask.id,
      askRunId: run.id,
      askMemberId: buyerMember.id,
      inputTaskIds: [inboxTask.id],
      taint: buyTaint,
      prompt: null,
      now: at(9),
    });
    await settleTask(tx, ctx, buyTask.id, { status: "awaiting_approval", report: { ...PURCHASING_REPORT, kind: "answer" }, startedAt: at(9), finishedAt: null, updatedAt: at(5), taint: buyTaint });

    // 連絡板の1往復（仕入れ係 → 受信箱係の質問と返事）
    const question = await insertAskMessage(tx, ctx, {
      askId: ask.id,
      askRunId: run.id,
      fromMember: buyerMember.id,
      toMember: inboxMember.id,
      kind: "question",
      body: "山田珈琲の20kgは確定ですか？",
      inReplyTo: null,
      tainted: true,
      fromTaskId: buyTask.id,
      now: at(8),
    });
    await insertAskMessage(tx, ctx, {
      askId: ask.id,
      askRunId: run.id,
      fromMember: inboxMember.id,
      toMember: buyerMember.id,
      kind: "reply",
      body: "確定とは書かれていません。「次回は前回と同じ20kgの予定」という書き方でした。",
      inReplyTo: question.id,
      tainted: true,
      fromTaskId: inboxTask.id,
      now: at(7),
    });

    // 発注の Intent と承認（intentHash は kernel の関数で、本番の edge と同じ入力から計算する）
    const toolRow = (await tx.query<{ input_schema: JsonObject; arg_roles: Record<string, string> }>("SELECT input_schema, arg_roles FROM connector_tools WHERE id = $1", [orderTool.id])).rows[0]!;
    const roles = effectiveArgRoles(toolRow.input_schema, toolRow.arg_roles as never);
    const action = "mcp.supplier.place_order";
    const expiry = computeApprovalExpiry({ createdAt: at(5).toISOString(), askNextRunAt: nextRunAt.toISOString() });
    const intentId = await insertActionIntent(
      tx,
      ctx,
      {
        taskId: buyTask.id,
        jobId: buyer.jobId,
        connectorId: supplier.id,
        action,
        origin: "agent",
        payload: { connectorId: supplier.id, tool: "place_order", arguments: ORDER_ARGS, toolHash: orderTool.toolHash },
        toolHash: orderTool.toolHash,
        destinationKey: destinationKey(action, ORDER_ARGS, roles),
        optionDigest: optionDigest(action, ORDER_ARGS, roles),
        taintSnapshot: buyTaint,
        status: "pending_approval",
        decision: "approve",
        reasonCode: "approval_required",
        matchedRule: "autonomy.mcp_write",
        decisionDetail: null,
        enforced: true,
        policyHash: buyerPolicyHash,
        intentHash: computeMcpIntentHash({ connectorId: supplier.id, tool: "place_order", arguments: ORDER_ARGS, toolHash: orderTool.toolHash, effectivePolicyHash: buyerPolicyHash }),
        expiresAt: new Date(expiry.expiresAt),
      },
      at(5),
    );
    const risk = mcpRiskScore({ tainted: true, matchesAnyRule: false, containsProfileValue: false, origin: "agent", scopeSelf: false });
    await insertApproval(
      tx,
      ctx,
      {
        taskId: buyTask.id,
        intentId,
        riskLevel: risk.level,
        riskScore: risk.score,
        riskReasons: risk.reasons,
        approverIds: [s.userId],
        expiresAt: new Date(expiry.expiresAt),
        expiryCause: expiry.cause,
        firstDestination: true,
      },
      at(5),
    );

    // ---- 回答（kernel の composeAnswer。LLM を呼ばない）----
    const composed = composeAnswer({
      shape: "chain",
      members: [
        { agentId: inbox.agentId, agentName: "受信箱係", position: 1, isAggregator: false, isSpokesperson: false, task: { id: inboxTask.id, status: "succeeded", failReason: null, haltReason: null, taint: inboxTaint, report: INBOX_REPORT } },
        { agentId: buyer.agentId, agentName: "仕入れ係", position: 2, isAggregator: false, isSpokesperson: true, task: { id: buyTask.id, status: "awaiting_approval", failReason: null, haltReason: null, taint: buyTaint, report: PURCHASING_REPORT } },
      ],
      pendingApprovals: 1,
      boardFacts: [{ fromAgentName: "仕入れ係", toAgentName: "受信箱係", replied: true }],
    });
    await saveRunAnswer(tx, ctx, run.id, {
      answerTaskId: composed.answerTaskId,
      answer: { ...composed, askRunId: run.id, updatedAt: at(5).toISOString() } as unknown as JsonObject,
      answerHash: composed.bodyHash,
      now: at(5),
    });
    return { ...s, askId: ask.id };
  });
}

export const call = async <T = unknown>(t: TestApp, s: Pick<SignedIn, "cookie" | "csrf">, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const res = await send(t, method, path, { cookie: s.cookie, csrf: s.csrf, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text === "" ? null : JSON.parse(text)) as T };
};

export { OWNER_TOKEN };
