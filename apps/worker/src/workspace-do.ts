// ワークスペースごとの Durable Object（docs/cloudflare-design.md）。ワークスペースの状態をすべて自分の SQLite に持つ。
// 中の処理は1本の流れで進むので、読んで判断して書く処理は db.transaction の中に書けば、行のロック（Postgres の M-21）は要らない。
// スキーマ（db/schema.ts）は作られたとき・起き直したときに blockConcurrencyWhile の中で MIGRATIONS を順に当てる（当てた版は schema_migrations に残す）。
// 表の読み書きは db/repo/*.ts の同期の関数（WsDb を受け取る）。画面の表示用ビューは views/*（RPC で返す。JSON にできる素の値で、時刻は ISO の文字列）

import { defaultWorkspacePolicy, hashCanonical, type JsonObject } from "@open-team/kernel";
import { knownSecretsFromEnv } from "@open-team/platform";
import { DurableObject } from "cloudflare:workers";
import type { LlmRequest } from "@open-team/llm";
import type { LlmMessagesResponse, LlmPhase, RunTaskEnd, TaskContext, ToolCallResult } from "@open-team/runner";
import { acceptAsk, answerAskQuestion } from "./asks/accept.ts";
import { takeStartableTasks } from "./asks/drive.ts";
import { advanceTx } from "./asks/run.ts";
import { failGeneration, loadPlannerMaterials } from "./asks/generate.ts";
import { savePlanResult, type PlanSaveOutcome, type PlanStepResult } from "./asks/plan-steps.ts";
import type { PlannerInput } from "./asks/planner.ts";
import { appendAuditLog } from "./db/audit.ts";
import { insertWorkspacePolicyIfMissing } from "./db/repo/app.ts";
import { bumpPlannerAttempts, getAsk, getAskRun } from "./db/repo/asks.ts";
import { getTask, type UsageRecordInput } from "./db/repo/edge.ts";
import { MIGRATIONS } from "./db/schema.ts";
import { count, wsDbOf, type WsDb } from "./db/sqlite.ts";
import { getWorkspace, initWorkspace } from "./db/workspace.ts";
import { captureEdge, type EdgeOutcome } from "./edge/fault.ts";
import { llmGate, llmRecord, type LlmGate } from "./edge/llm-call.ts";
import {
  createTaskEdgeRuntime,
  edgeCallTool,
  edgeLlmBegin,
  edgeLlmFail,
  edgeLlmPrepare,
  edgeLlmSettle,
  edgePostEvents,
  edgeTaskContext,
  finishTaskRun,
  type TaskEdgeRuntime,
} from "./edge/task-edge.ts";
import { llmOf } from "./llm.ts";
import { runIdempotent, type IdemRequest } from "./idempotency.ts";
import type { AgentLibraryResponse } from "./views/agents/contract.ts";
import { buildAgentLibrary } from "./views/agents/view.ts";
import type {
  AnswerAskBody,
  AskAcceptedResponse,
  AskDetailResponse,
  AskStatus,
  CreateAskBody,
  ListAskMessagesResponse,
  ListAsksResponse,
} from "./views/asks/contract.ts";
import { buildAskDetail, listAskSummaries, listMessages } from "./views/asks/view.ts";
import type { WriteResult } from "./write.ts";

export { MIGRATIONS };

export class WorkspaceDO extends DurableObject<Env> {
  private readonly db: WsDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = wsDbOf(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
                version     INTEGER PRIMARY KEY,
                name        TEXT    NOT NULL,
                applied_at  TEXT    NOT NULL
              )`);
    const applied = new Set(sql.exec<{ version: number }>("SELECT version FROM schema_migrations").toArray().map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.ctx.storage.transactionSync(() => {
        sql.exec(m.sql);
        sql.exec("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", m.version, m.name, new Date().toISOString());
      });
    }
  }

  /**
   * 初めてならワークスペースの持ち主と、ワークスペースのポリシー v1（kernel の既定。apps/app/src/owner-setup.ts の 2 と同じ）を入れる。
   * 2回目以降は何もしない。違う持ち主なら例外
   */
  init(workspaceId: string, ownerUserId: string): void {
    const now = new Date();
    this.db.transaction(() => {
      initWorkspace(this.db, { workspaceId, ownerUserId, now });
      const policy = defaultWorkspacePolicy();
      const policyHash = hashCanonical(policy);
      const p = insertWorkspacePolicyIfMissing(this.db, { policy: policy as unknown as JsonObject, policyHash, createdBy: null, now });
      if (p.created) {
        appendAuditLog(
          this.db,
          { eventType: "policy.snapshot_created", actorType: "system", actorId: "seed", payload: { scope: "workspace", version: p.row.version, policyHash, origin: "seed" } },
          now,
        );
      }
    });
  }

  /** 当てたスキーマの版（新しい順の先頭。なければ 0） */
  schemaVersion(): number {
    const row = this.ctx.storage.sql.exec<{ v: number | null }>("SELECT max(version) AS v FROM schema_migrations").one();
    return row.v ?? 0;
  }

  // ---- 画面の表示用ビュー（読むだけ。GET /api/v1/*） ----

  /** エージェントの一覧（GET /agents） */
  agentLibrary(): AgentLibraryResponse {
    return buildAgentLibrary(this.db, new Date());
  }

  /** 入口（SCR-020）の依頼の一覧（GET /asks） */
  listAsks(o: { limit: number; status?: AskStatus }): ListAsksResponse {
    return listAskSummaries(this.db, o);
  }

  /** 依頼のページ（API-075）。依頼がなければ null */
  askDetail(askId: string): AskDetailResponse | null {
    return buildAskDetail(this.db, askId, new Date());
  }

  /** 連絡板（API-076）。依頼がなければ null */
  askMessages(askId: string): ListAskMessagesResponse | null {
    return listMessages(this.db, askId);
  }

  // ---- 書き込み（POST /api/v1/*）。AppError は値（WriteResult）にして返す（write.ts） ----

  /** 利用者の文から伏せる既知の秘密（Workers secrets のうち SECRET_ENV_NAMES のもの） */
  private secrets(): readonly string[] {
    return knownSecretsFromEnv(this.env as unknown as Record<string, string | undefined>);
  }

  /** API-072：依頼を作る（201）。受けたら編成の Workflow を起動する */
  async acceptAsk(i: { userId: string; body: CreateAskBody; idem: IdemRequest | null; now: Date }): Promise<WriteResult<AskAcceptedResponse>> {
    const r = runIdempotent(this.db, i.idem, 201, i.now, () => acceptAsk(this.db, { ...i, secrets: this.secrets() }));
    if (r.ok && r.replayed !== true) await this.startPlan(r.body.ask.id, i.userId, "initial");
    return r;
  }

  /** API-073：生成中の質問に答える。答えたら編成の Workflow をもう一度起動する */
  async answerAskQuestion(i: { userId: string; askId: string; body: AnswerAskBody; idem: IdemRequest | null; now: Date }): Promise<WriteResult<AskAcceptedResponse>> {
    const r = runIdempotent(this.db, i.idem, 200, i.now, () => answerAskQuestion(this.db, { ...i, secrets: this.secrets() }));
    if (r.ok && r.replayed !== true) await this.startPlan(i.askId, i.userId, "answered");
    return r;
  }

  /**
   * 編成の Workflow を起動する。同じ Idempotency-Key のやり直し（記録した応答を返したとき）は呼ばない。
   * インスタンスの ID は依頼と段階（初回・質問への答えのあと）で決まるので、万一2回呼んでも2つ目は作られない（instance.already_exists）
   */
  private async startPlan(askId: string, userId: string, phase: "initial" | "answered"): Promise<void> {
    const id = `plan-${askId}-${phase}`;
    const workspaceId = getWorkspace(this.db)?.workspace_id;
    if (workspaceId === undefined) return;
    try {
      await this.env.PLAN_ASK.create({ id, params: { workspaceId, askId, userId } });
    } catch (e) {
      // 依頼と冪等性の記録はもう確定しているので、同じキーで送り直しても記録した応答が返るだけで、編成は始まらない。
      // generating のまま残さず、生成の失敗として閉じる（画面は「もう一度送ってください」。応答の本文は受け付けた時点の generating のまま）
      const detail = e instanceof Error ? e.message : String(e);
      console.error("ask.plan_start_failed", { askId, error: detail });
      failGeneration(this.db, { askId, reason: "planner_error", detail: `編成の Workflow を起動できなかった：${detail}`, now: new Date(), secrets: this.secrets() });
    }
  }

  // ---- 編成の Workflow（workflows/plan-ask.ts）から呼ぶ ----

  /** 設定プランナーの材料（生成中でない・質問に未回答なら null） */
  planMaterials(askId: string): PlannerInput | null {
    return loadPlannerMaterials(this.db, askId)?.input ?? null;
  }

  /** 設定プランナーを呼んだ回数を足す */
  bumpPlannerAttempts(askId: string): void {
    bumpPlannerAttempts(this.db, askId, 1, new Date());
  }

  /** 計画の結果を保存して、最初の実行を始める */
  async planSave(i: { askId: string; requesterId: string; result: PlanStepResult }): Promise<PlanSaveOutcome> {
    const saved = savePlanResult(this.db, { ...i, now: new Date(), secrets: this.secrets() });
    if (saved.outcome === "formed") await this.startTasks();
    return saved;
  }

  // ---- 実行の進め役（asks/drive.ts）。担当のタスクは TaskWorkflow（workflows/task-run.ts）で動かす ----

  /**
   * 始められる queued のタスクを取り、TaskWorkflow を起動する。始める前に止めたタスクの実行は1歩進める（止まった段で失敗として閉じる）。
   * 起動できなかったタスクは、終わったものとして後始末する
   */
  private async startTasks(): Promise<void> {
    const workspaceId = getWorkspace(this.db)?.workspace_id;
    if (workspaceId === undefined) return;
    for (let round = 0; round < 10; round += 1) {
      const now = new Date();
      const r = takeStartableTasks(this.db, now);
      for (const runId of r.haltedRunIds) this.advanceRun(runId, now);
      let startFailed = false;
      for (const t of r.started) {
        try {
          await this.env.TASK_RUN.create({ id: `task-${t.id}`, params: { workspaceId, taskId: t.id } });
        } catch (e) {
          console.error("task.start_failed", { taskId: t.id, error: e instanceof Error ? e.message : String(e) });
          const after = finishTaskRun(this.db, t.id, "error", new Date());
          if (after?.ask_run_id) this.advanceRun(after.ask_run_id, new Date());
          startFailed = true;
        }
      }
      // 止めた・起動できなかったタスクの後始末で、次の段のタスクが queued になったり枠が空いたりする。もう一度見る
      if (r.haltedRunIds.length === 0 && !startFailed) return;
    }
  }

  /** 実行を1歩進める（頼んだ人は依頼の作り手。返事の実行は窓口だけで、最初の歩みで作り終えている） */
  private advanceRun(runId: string, now: Date): void {
    const run = getAskRun(this.db, runId);
    const ask = run === null ? null : getAsk(this.db, run.ask_id);
    if (ask === null) return;
    advanceTx(this.db, runId, { requesterId: ask.created_by, now });
  }

  /** TaskWorkflow の終わり：後始末 → 1歩進める → 次のタスクを起動 */
  async taskFinished(taskId: string, ended: RunTaskEnd | "error"): Promise<void> {
    const now = new Date();
    // Workflow が finish の歩みをやり直したとき（記録のあと RPC の戻りで落ちた）、段の終わりの事象を二重に出さない。
    // 1歩進める・次を起動するのは何度呼んでも同じ結果になるので、続けて行う
    const done = count(this.db, "SELECT count(*) FROM workspace_events WHERE type = 'ask.step.finished' AND json_extract(data, '$.taskId') = ?", taskId) > 0;
    const after = done ? getTask(this.db, taskId) : finishTaskRun(this.db, taskId, ended, now);
    if (after?.ask_run_id) this.advanceRun(after.ask_run_id, now);
    await this.startTasks();
  }

  // ---- 担当のタスクの edge（runner の EdgePort。workflows/task-run.ts が歩みの中で呼ぶ）。EdgeError は値で返す ----

  private taskEdge: TaskEdgeRuntime | null = null;

  private edgeRuntime(): TaskEdgeRuntime {
    this.taskEdge ??= createTaskEdgeRuntime({ models: llmOf(this.env).config, knownSecrets: this.secrets() });
    return this.taskEdge;
  }

  edgeTaskContext(taskId: string): EdgeOutcome<TaskContext> {
    return captureEdge(() => edgeTaskContext(this.db, this.edgeRuntime(), taskId, new Date()));
  }

  edgeLlmPrepare(taskId: string, rawReq: unknown): EdgeOutcome<{ llmReq: LlmRequest; phase: LlmPhase }> {
    return captureEdge(() => edgeLlmPrepare(this.db, this.edgeRuntime(), taskId, rawReq, new Date()));
  }

  edgeLlmBegin(taskId: string, a: { budgetEstimateMicroUsd: number; model: string; phase: LlmPhase }): EdgeOutcome<null> {
    return captureEdge(() => {
      edgeLlmBegin(this.db, this.edgeRuntime(), taskId, a, new Date());
      return null;
    });
  }

  edgeLlmSettle(taskId: string, a: Parameters<typeof edgeLlmSettle>[3]): EdgeOutcome<LlmMessagesResponse> {
    return captureEdge(() => edgeLlmSettle(this.db, this.edgeRuntime(), taskId, a, new Date()));
  }

  edgeLlmFail(taskId: string, a: Parameters<typeof edgeLlmFail>[3]): EdgeOutcome<LlmMessagesResponse> {
    return captureEdge(() => edgeLlmFail(this.db, this.edgeRuntime(), taskId, a, new Date()));
  }

  edgePostEvents(taskId: string, events: unknown): EdgeOutcome<{ accepted: number; dropped: number }> {
    return captureEdge(() => edgePostEvents(this.db, this.edgeRuntime(), taskId, events, new Date()));
  }

  edgeCallTool(taskId: string, toolCallId: string): EdgeOutcome<ToolCallResult> {
    return captureEdge(() => edgeCallTool(this.db, this.edgeRuntime(), taskId, toolCallId, new Date()));
  }

  // ---- LLM の呼び出しの記録（edge/llm-call.ts の callLlm の ledger） ----

  /** 呼ぶ前の確かめ（費用の上限） */
  llmGate(budgetEstimateMicroUsd: number, now: Date): LlmGate {
    return llmGate(this.db, budgetEstimateMicroUsd, now);
  }

  /** 費用の記録 */
  llmRecord(usage: UsageRecordInput, now: Date): void {
    llmRecord(this.db, usage, now);
  }
}
