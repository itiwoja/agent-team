// ゲスト（審査員）のワークスペースの作成と、デモ用のデータの投入（FR-046・15 §最初に入っているもの・D-39・D-69・D-70）
// 入口でゲスト用のトークンを入れるたびに、新しいゲストのワークスペースを作る。手順（外部の呼び出しはトランザクションの外：G-14）：
// 1. 利用者・ワークスペース（kind = guest）・所属（owner）・監査ログの起点 workspace.created・入口の記録を1つのトランザクションで（上限は BR-65：
//    全体50件・同じ IP から1時間5件。超えたら 429 GUEST_LIMIT_REACHED）
// 2. ポリシー（日次 $4：BR-62・D-106）・コネクタ（sim-world だけ：BR-64）・ツールの分類・デモ店舗・担当2人・用意した依頼を、オーナーと同じ処理（owner-setup の seedWorkspace）で。
//    seed_key（prepared-purchasing）で冪等。監査ログは足さない（作成の1件だけ：15:350）
// 3. 用意した依頼の「1回分を走らせ終えた状態」を DB に直接入れる（Gemini を待たずに10秒で価値が見える：D-70）：
//    受信箱係は済み（新しいメール3通。うち1通は仕入れ先の値上げの知らせ）、仕入れ係は在庫を見て発注を決め、**送る前の確認が1件** 残る
//    （supplier.place_order、宛先 supplier-01 山田珈琲、コーヒー豆 20kg。受け渡しで汚染されているので BR-70 の出し方：初めての送り先）。
//    ○ を押すと既存の経路（承認 → 再判定 → gateway → sim-world）で発注が届く。回答（ask_runs.answer）も kernel の composeAnswer で作って入れる
//    タスクの開始時のデモ店舗のスナップショット（sim-world）を付けるので、却下すると回帰の試験（BR-80）になる
// 4. セッションを作る（前のセッションがあれば失効）。ここで初めて Cookie が出る
//    続けて、用意した依頼（順番の編成全体）の「リハーサルの結果」を事前に走らせた固定の結果で入れる（guest-rehearsal/seed.ts・D-97）：
//    12件中10件は統制が止め、2件がすり抜け（締める提案つき・防いだ損害の金額つき）、合格証はまだない。[適用] → 再試験は審査員が押せる（ここで初めて Gemini が動く）。
//    すり抜けた状況には sim-world の走行を結びつける（締める提案の数値の材料。トランザクションの外）
// どこかで失敗したら、作ったワークスペースを削除予約にする（SO §3.5：sim-world の初期化の失敗）
// 決めたこと：使った費用の記録（usage_records）は入れない（事前に走らせた結果で、実際に Gemini を呼んだ費用ではない。
// ゲストの日次上限 $4・全体 $15 を食わない）。監査ログも足さない（作成の1件だけ）

import {
  createGuestWorkspace,
  issueSession,
  lockWorkspace,
  requestWorkspaceDeletion,
  revokeSession,
  type IssuedSession,
  type SessionCtx,
  type Tx,
  type Uuid,
  type WsCtx,
} from "@open-team/db";
import { findAskBySeedKey, listConnectors, listConnectorTools } from "@open-team/db/app";
import { getLatestLiveRun, insertAskMessage, insertAskTask, insertLiveRun, listMembers, markFirstMemberStarted, saveRunAnswer } from "@open-team/db/asks";
import { insertActionIntent, insertApproval } from "@open-team/db/edge";
import { insertSeedTaskEvent, setSeedScenarioExecution, setTaskSimSnapshot, settleSeedTask } from "@open-team/db/seed";
import {
  EMPTY_TAINT,
  composeAnswer,
  computeApprovalExpiry,
  computeMcpIntentHash,
  destinationKey,
  effectiveArgRoles,
  mcpRiskScore,
  optionDigest,
  type JsonObject,
  type TaintSource,
  type TaintState,
} from "@open-team/kernel";
import { AppError } from "@open-team/platform";
import type { AppDeps } from "./deps.ts";
import { seedPreparedRehearsal } from "./guest-rehearsal/seed.ts";
import { OwnerSetupError, seedWorkspace, type OwnerSetupResult } from "./owner-setup.ts";

/** ゲストのシードの版（workspaces.seed_version。中身を変えたら上げる：15:341） */
export const GUEST_SEED_VERSION = "guest-v2";

export type GuestDeps = Pick<AppDeps, "db" | "env" | "log" | "clock" | "gatewayClient" | "simClient" | "ids">;

export type GuestEntryResult =
  | { kind: "guest"; session: IssuedSession; workspaceId: Uuid; firstAskId: Uuid }
  | { kind: "guest_limit"; scope: "global" | "ip" };

/** 発注の中身（15:345。いつもの量。ガードは入っていない：リハーサルで穴を見つける題材） */
const ORDER_ARGS: JsonObject = {
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

/** 連絡板の1往復（D-73・FR-064）：順番の後の段（仕入れ係）が前の段（受信箱係）に聞き、答えをもらう。受信箱係はメールを読んだ担当なので返事も汚染の印つき */
const TEAM_QUESTION = "山田珈琲の20kgは確定ですか？";
const TEAM_REPLY = "確定とは書かれていません。「次回は前回と同じ20kgの予定。数量が変わるなら発注時に知らせてほしい」という書き方でした。";

/** 1回分の時刻（今から見て）。受信箱係が先に終わり、仕入れ係が確認待ちで止まっている */
function timeline(now: Date) {
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
  return { runStart: at(12), inboxStart: at(12), inboxEnd: at(9), buyStart: at(9), buyAsk: at(8), buyReply: at(7), buyWait: at(5) };
}

/**
 * 用意した依頼の「1回分を走らせ終えた状態」を入れる（1つのトランザクション。外部を呼ばない）。
 * すでに本番の実行があれば何もしない（冪等）。入れたら { created: true, taskIds }。sim のスナップショットは呼び出し側が付ける
 */
export async function seedPreparedRun(
  tx: Tx,
  deps: Pick<GuestDeps, "ids">,
  ctx: WsCtx & { userId: Uuid },
  team: Pick<OwnerSetupResult, "askId">,
  now: Date,
): Promise<{ created: false } | { created: true; runId: Uuid; taskIds: Uuid[]; purchasingTaskId: Uuid }> {
  await lockWorkspace(tx, ctx);
  if ((await getLatestLiveRun(tx, ctx, team.askId)) !== null) return { created: false };
  const t = timeline(now);
  const members = (await listMembers(tx, ctx, team.askId)).filter((m) => !m.is_aggregator);
  const inbox = members.find((m) => m.position === 1);
  const buyer = members.find((m) => m.position === 2);
  if (!inbox || !buyer) throw new OwnerSetupError("agents", "用意した依頼の担当が2人そろっていない");
  const connectors = await listConnectors(tx, ctx);
  const tools = await listConnectorTools(tx, ctx);
  const mail = connectors.find((c) => c.slug === "mail");
  const supplier = connectors.find((c) => c.slug === "supplier");
  const orderTool = supplier ? tools.find((x) => x.connector_id === supplier.id && x.name === "place_order") : undefined;
  if (!mail || !supplier || !orderTool) throw new OwnerSetupError("connectors", "デモ用のコネクタ・ツールがない");
  const snapshotOf = async (agentId: Uuid): Promise<{ snapshotId: Uuid; policies: Record<string, { policy: unknown; hash: string }> }> => {
    const r = await tx.query<{ current_snapshot_id: Uuid; effective_policies: Record<string, { policy: unknown; hash: string }> }>(
      `SELECT a.current_snapshot_id, s.effective_policies FROM agents a JOIN agent_snapshots s ON s.workspace_id = a.workspace_id AND s.id = a.current_snapshot_id
        WHERE a.workspace_id = $1 AND a.id = $2`,
      [ctx.workspaceId, agentId],
    );
    const row = r.rows[0];
    if (!row) throw new OwnerSetupError("agents", "担当のスナップショットがない");
    return { snapshotId: row.current_snapshot_id, policies: row.effective_policies };
  };
  const ask = (await tx.query<{ next_run_at: Date | null }>("SELECT next_run_at FROM asks WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, team.askId])).rows[0];

  const run = await insertLiveRun(tx, ctx, team.askId, "initial", t.runStart);
  if (run === null) return { created: false };
  await markFirstMemberStarted(tx, ctx, run.id, t.inboxStart);

  // ---- 受信箱係（済み。メールを読んだので汚染される）----
  const inboxSnap = await snapshotOf(inbox.agent_id);
  const mailRead: TaintSource = {
    kind: "mcp_read",
    connectorId: mail.id,
    connectorSlug: mail.slug,
    connectorName: mail.display_name,
    tool: "list_inbox",
    at: t.inboxEnd.toISOString(),
  };
  const inboxTask = await insertAskTask(tx, ctx, {
    requesterId: ctx.userId,
    agentId: inbox.agent_id,
    agentSnapshotId: inboxSnap.snapshotId,
    jobId: inbox.job_id,
    askId: team.askId,
    askRunId: run.id,
    askMemberId: inbox.id,
    inputTaskIds: [],
    taint: EMPTY_TAINT,
    prompt: null,
    now: t.inboxStart,
  });
  const inboxTaint: TaintState = { tainted: true, sources: [mailRead] };
  const inboxDone = await settleSeedTask(tx, ctx, inboxTask.id, {
    status: "succeeded",
    report: { ...INBOX_REPORT, kind: "normal" },
    stepsUsed: 3,
    costUsd: "0.000000",
    simSnapshotId: null,
    startedAt: t.inboxStart,
    finishedAt: t.inboxEnd,
    tainted: { tainted: true, sources: [mailRead as unknown as never] },
  });
  if (inboxDone === null) throw new OwnerSetupError("agents", "受信箱係のタスクを済みにできなかった");
  await insertSeedTaskEvent(tx, ctx, inboxTask.id, "tool_called", { tool: "mail.list_inbox", target: "mail", decision: "allow", reasonCode: "not_gated", matchedRule: null, resultSummary: "新着3通" }, t.inboxStart);
  await insertSeedTaskEvent(tx, ctx, inboxTask.id, "status_changed", { from: "running", to: "succeeded" }, t.inboxEnd);
  await insertSeedTaskEvent(tx, ctx, inboxTask.id, "finished", { outcome: "succeeded" }, t.inboxEnd);

  // ---- 仕入れ係（在庫を見て発注を決めた。送る前の確認が1件）----
  const buySnap = await snapshotOf(buyer.agent_id);
  const handoff: TaintSource = { kind: "handoff", fromTaskId: inboxTask.id, fromAgentName: inbox.agent_name, upstream: [mailRead], at: t.buyStart.toISOString() };
  const buyTaint: TaintState = { tainted: true, sources: [handoff] };
  const buyTask = await insertAskTask(tx, ctx, {
    requesterId: ctx.userId,
    agentId: buyer.agent_id,
    agentSnapshotId: buySnap.snapshotId,
    jobId: buyer.job_id,
    askId: team.askId,
    askRunId: run.id,
    askMemberId: buyer.id,
    inputTaskIds: [inboxTask.id],
    taint: buyTaint,
    prompt: null,
    now: t.buyStart,
  });
  const buyWait = await settleSeedTask(tx, ctx, buyTask.id, {
    status: "awaiting_approval",
    report: { ...PURCHASING_REPORT, kind: "answer" },
    stepsUsed: 6,
    costUsd: "0.000000",
    simSnapshotId: null,
    startedAt: t.buyStart,
    finishedAt: null,
    updatedAt: t.buyWait,
    tainted: { tainted: true, sources: [handoff as unknown as never] },
  });
  if (buyWait === null) throw new OwnerSetupError("agents", "仕入れ係のタスクを確認待ちにできなかった");
  await insertSeedTaskEvent(tx, ctx, buyTask.id, "tool_called", { tool: "store.get_inventory", target: "store", decision: "allow", reasonCode: "not_gated", matchedRule: null, resultSummary: "5品目" }, t.buyStart);
  await insertSeedTaskEvent(tx, ctx, buyTask.id, "tool_called", { tool: "supplier.list_products", target: "supplier", decision: "allow", reasonCode: "not_gated", matchedRule: null, resultSummary: "5商品" }, t.buyStart);
  await insertSeedTaskEvent(tx, ctx, buyTask.id, "status_changed", { from: "running", to: "awaiting_approval" }, t.buyWait);

  // 連絡板の1往復（仕入れ係 → 受信箱係の質問と返事）。受信箱係の返事は済んだタスクのまま入れる（追いのターンは走らせない）
  const question = await insertAskMessage(tx, ctx, {
    askId: team.askId,
    askRunId: run.id,
    fromMember: buyer.id,
    toMember: inbox.id,
    kind: "question",
    body: TEAM_QUESTION,
    inReplyTo: null,
    tainted: true,
    fromTaskId: buyTask.id,
    now: t.buyAsk,
  });
  await insertAskMessage(tx, ctx, {
    askId: team.askId,
    askRunId: run.id,
    fromMember: inbox.id,
    toMember: buyer.id,
    kind: "reply",
    body: TEAM_REPLY,
    inReplyTo: question.id,
    tainted: true,
    fromTaskId: inboxTask.id,
    now: t.buyReply,
  });

  // 発注の Intent と承認（intentHash は kernel の関数で、本番の edge と同じ入力から計算する）
  const policyEntry = buySnap.policies.reorder;
  if (!policyEntry) throw new OwnerSetupError("agents", "仕入れ係の仕事の実効ポリシーがない");
  const roles = effectiveArgRoles(orderTool.input_schema, orderTool.arg_roles);
  const action = "mcp.supplier.place_order";
  const expiry = computeApprovalExpiry({ createdAt: t.buyWait.toISOString(), askNextRunAt: ask?.next_run_at?.toISOString() ?? null });
  const intentHash = computeMcpIntentHash({
    connectorId: supplier.id,
    tool: "place_order",
    arguments: ORDER_ARGS,
    toolHash: orderTool.tool_hash,
    effectivePolicyHash: policyEntry.hash as `${string}`,
  });
  const intentId = await insertActionIntent(
    tx,
    ctx,
    {
      taskId: buyTask.id,
      jobId: buyer.job_id,
      connectorId: supplier.id,
      action,
      origin: "agent",
      payload: { connectorId: supplier.id, tool: "place_order", arguments: ORDER_ARGS, toolHash: orderTool.tool_hash },
      toolHash: orderTool.tool_hash,
      destinationKey: destinationKey(action, ORDER_ARGS, roles),
      optionDigest: optionDigest(action, ORDER_ARGS, roles),
      taintSnapshot: buyTaint,
      status: "pending_approval",
      decision: "approve",
      reasonCode: "approval_required",
      matchedRule: "autonomy.mcp_write",
      decisionDetail: null,
      enforced: true,
      policyHash: policyEntry.hash as never,
      intentHash,
      expiresAt: new Date(expiry.expiresAt),
    },
    t.buyWait,
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
      approverIds: [ctx.userId],
      expiresAt: new Date(expiry.expiresAt),
      expiryCause: expiry.cause,
      firstDestination: true,
    },
    t.buyWait,
  );

  // ---- 回答（kernel の composeAnswer。LLM を呼ばない）----
  const composed = composeAnswer({
    shape: "chain",
    members: [
      { agentId: inbox.agent_id, agentName: inbox.agent_name, position: 1, isAggregator: false, isSpokesperson: false, task: { id: inboxTask.id, status: "succeeded", failReason: null, haltReason: null, taint: inboxTaint, report: INBOX_REPORT } },
      { agentId: buyer.agent_id, agentName: buyer.agent_name, position: 2, isAggregator: false, isSpokesperson: true, task: { id: buyTask.id, status: "awaiting_approval", failReason: null, haltReason: null, taint: buyTaint, report: PURCHASING_REPORT } },
    ],
    pendingApprovals: 1,
    boardFacts: [{ fromAgentName: buyer.agent_name, toAgentName: inbox.agent_name, replied: true }],
  });
  await saveRunAnswer(tx, ctx, run.id, {
    answerTaskId: composed.answerTaskId,
    answer: { ...composed, askRunId: run.id, updatedAt: t.buyWait.toISOString() } as unknown as JsonObject,
    answerHash: composed.bodyHash,
    now: t.buyWait,
  });
  return { created: true, runId: run.id, taskIds: [inboxTask.id, buyTask.id], purchasingTaskId: buyTask.id };
}

/**
 * 入口：ゲストのワークスペースを作ってデモ用のデータを入れ、セッションを作る。
 * 失敗したら作ったワークスペースを削除予約にしてから例外にする（sim-world に届かない → 503 SIM_WORLD_UNAVAILABLE、ほかは 500）
 */
export async function enterAsNewGuest(
  deps: GuestDeps,
  req: { ipHash: string | null; userAgent: string | null; existing: SessionCtx | null },
): Promise<GuestEntryResult> {
  const now = deps.clock.now();
  // 1：IP のハッシュがなければ（準備中の確認を通ったあとなので鍵はある）上限を数えられない。安全側で全員を同じ IP として数える
  const ipHash = req.ipHash ?? "unknown";
  const created = await deps.db.transaction((tx) => createGuestWorkspace(tx, { ipHash, now, seedVersion: GUEST_SEED_VERSION, outcome: "guest_created" }));
  if (!created.ok) return { kind: "guest_limit", scope: created.scope };
  const ctx = created.ctx;

  try {
    // 2
    const team = await seedWorkspace(deps, ctx, "guest", { now }, { workspaceCreated: true, audit: false });
    // 3：1回分（DB）→ 開始時のスナップショット（sim-world。トランザクションの外）→ タスクに付ける
    const seeded = await deps.db.transaction((tx) => seedPreparedRun(tx, deps, ctx, team, now));
    if (seeded.created) {
      const snap = await deps.simClient.createSnapshot({ workspaceId: ctx.workspaceId, world: "shop", sourceTaskId: seeded.purchasingTaskId });
      await deps.db.transaction(async (tx) => {
        for (const id of seeded.taskIds) await setTaskSimSnapshot(tx, ctx, id, snap.snapshot.id);
      });
    }
    // 3b：事前に走らせたリハーサルの結果（DB）→ すり抜けた状況に sim-world の走行を結びつける（トランザクションの外）
    const rehearsal = await deps.db.transaction((tx) => seedPreparedRehearsal(tx, deps, ctx, team, now));
    if (rehearsal.created) {
      for (const s of rehearsal.slipped) {
        const executionId = deps.ids.newId();
        await deps.simClient.createExecution({
          workspaceId: ctx.workspaceId,
          world: "shop",
          rehearsalRunId: rehearsal.runId,
          executionId,
          variant: "governed",
          scenario: s.scenario as never,
        });
        await deps.db.transaction((tx) => setSeedScenarioExecution(tx, ctx, s.scenarioId, executionId));
      }
    }
    // 4
    const session = await deps.db.transaction(async (tx) => {
      if (req.existing) await revokeSession(tx, req.existing, now);
      return issueSession(tx, { workspaceId: ctx.workspaceId, userId: ctx.userId, ipHash: req.ipHash, userAgent: req.userAgent, now });
    });
    deps.log.info("entry.guest", "ゲストのワークスペースを作った", { workspaceId: ctx.workspaceId, ipHash: req.ipHash, seedVersion: GUEST_SEED_VERSION });
    return { kind: "guest", session, workspaceId: ctx.workspaceId, firstAskId: team.askId };
  } catch (error) {
    deps.log.error("entry.guest_failed", "ゲストのワークスペースの用意に失敗した。削除予約にする", { workspaceId: ctx.workspaceId, error });
    await deps.db.transaction((tx) => requestWorkspaceDeletion(tx, ctx, deps.clock.now())).catch((e: unknown) => {
      deps.log.error("entry.guest_cleanup_failed", "ゲストの削除予約に失敗した", { workspaceId: ctx.workspaceId, error: e });
    });
    const step = error instanceof OwnerSetupError ? error.step : null;
    if (step === "sync" || step === "demo_store" || (error instanceof Error && /sim/i.test(error.name))) throw new AppError("SIM_WORLD_UNAVAILABLE", undefined, { cause: error });
    throw error;
  }
}

/** ゲストの「最初に開く依頼」（用意した依頼）の ID。なければ null */
export async function preparedAskIdOf(deps: Pick<GuestDeps, "db">, ctx: WsCtx): Promise<Uuid | null> {
  return (await findAskBySeedKey(deps.db, ctx, "prepared-purchasing"))?.id ?? null;
}
