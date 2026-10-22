// ワークスペースごとの Durable Object（docs/cloudflare-design.md）。ワークスペースの状態をすべて自分の SQLite に持つ。
// 中の処理は1本の流れで進むので、読んで判断して書く処理は db.transaction の中に書けば、行のロック（Postgres の M-21）は要らない。
// スキーマ（db/schema.ts）は作られたとき・起き直したときに blockConcurrencyWhile の中で MIGRATIONS を順に当てる（当てた版は schema_migrations に残す）。
// 表の読み書きは db/repo/*.ts の同期の関数（WsDb を受け取る）。画面の表示用ビューは views/*（RPC で返す。JSON にできる素の値で、時刻は ISO の文字列）

import { defaultWorkspacePolicy, hashCanonical, type JsonObject } from "@open-team/kernel";
import { knownSecretsFromEnv } from "@open-team/platform";
import { DurableObject } from "cloudflare:workers";
import { acceptAsk, answerAskQuestion } from "./asks/accept.ts";
import { loadPlannerMaterials } from "./asks/generate.ts";
import { savePlanResult, type PlanSaveOutcome, type PlanStepResult } from "./asks/plan-steps.ts";
import type { PlannerInput } from "./asks/planner.ts";
import { appendAuditLog } from "./db/audit.ts";
import { insertWorkspacePolicyIfMissing } from "./db/repo/app.ts";
import { bumpPlannerAttempts } from "./db/repo/asks.ts";
import type { UsageRecordInput } from "./db/repo/edge.ts";
import { MIGRATIONS } from "./db/schema.ts";
import { wsDbOf, type WsDb } from "./db/sqlite.ts";
import { getWorkspace, initWorkspace } from "./db/workspace.ts";
import { llmGate, llmRecord, type LlmGate } from "./edge/llm-call.ts";
import { runIdempotent, type IdemRequest } from "./idempotency.ts";
import { engageKillSwitch, releaseKillSwitch, type KillSwitchEngageResponse, type KillSwitchReleaseResponse } from "./kill-switch.ts";
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
import { captureAppError, type WriteResult } from "./write.ts";

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
    await this.env.PLAN_ASK.create({ id, params: { workspaceId, askId, userId } });
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
  planSave(i: { askId: string; requesterId: string; result: PlanStepResult }): PlanSaveOutcome {
    return savePlanResult(this.db, { ...i, now: new Date(), secrets: this.secrets() });
  }

  // ---- LLM の呼び出しの記録（edge/llm-call.ts の callLlm の ledger） ----

  /** 呼ぶ前の確かめ（Kill Switch・費用の上限） */
  llmGate(budgetEstimateMicroUsd: number, now: Date): LlmGate {
    return llmGate(this.db, budgetEstimateMicroUsd, now);
  }

  /** 費用の記録 */
  llmRecord(usage: UsageRecordInput, now: Date): void {
    llmRecord(this.db, usage, now);
  }

  /** EP-27：Kill Switch の発動 */
  engageKillSwitch(i: { userId: string; reason: string | null; idem: IdemRequest | null; now: Date }): WriteResult<KillSwitchEngageResponse> {
    return runIdempotent(this.db, i.idem, 200, i.now, () => engageKillSwitch(this.db, i));
  }

  /** EP-28：Kill Switch の解除 */
  releaseKillSwitch(i: { userId: string; reason: string; now: Date }): WriteResult<KillSwitchReleaseResponse> {
    return captureAppError(() => ({ status: 200, body: releaseKillSwitch(this.db, i) }));
  }
}
