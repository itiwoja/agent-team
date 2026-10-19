// 締める提案の作成と適用・再試験（FR-045・15「処理の流れ」6・D-82）
// - proposeTighteningForRuns：すり抜けた失敗（オラクルが原因とした書き込み）から、packages/rehearsal の proposeTightening で案を作る。
//   案の中身の合否は決定論：kernel の checkTighteningProposal（スキーマ → compose → ルールの追加でない → classify が narrow → その書き込みを塞ぐ）に
//   通らない案は捨てる。LLM は使わない（案の表示文は種類ごとの決まった文。rehearsal_tighten の呼び出しは要らない）
// - applyTighteningAndRetest：ユーザーの [適用] 相当。案をもう一度同じ検証にかけ（保存済みの案・外から来た案を信用しない）、通ったものを
//   設定変更（TBL-025。apply.ts の applyTightening が保存）として適用し、同じシードで再試験する（runRehearsalSuite。影は走らせない）。
//   締める変更では合格証を失効させない（FR-067）：ここでは失効に触れず、結果の tightening.keepsCertificate = true で印だけ返す
// - 通らない案は例外にせず、理由つきで返す（不合格・不適用は普通の結果）。保存・走行の失敗（Kill Switch・動いている走行・差分が合わない）は AppError

import type { RehearsalRunRow, SessionCtx, Uuid, WsCtx } from "@open-team/db";
import { getAgentSnapshotRow } from "@open-team/db/edge";
import { getLatestWorkspacePolicy, listConnectors, listConnectorTools } from "@open-team/db/app";
import { findActiveRehearsalRun, getJobStage, getRehearsalRun, listActiveRehearsalCases, listRehearsalScenarios, type CaseSubject } from "@open-team/db/rehearsal";
import { listSlippedWriteSources, type SlippedWriteSource } from "@open-team/db/rehearsal-tighten";
import { getWorkspace } from "@open-team/db";
import { DEFAULT_CEILINGS, checkTighteningProposal, parseWorkspacePolicy } from "@open-team/kernel";
import type { AgentDefinitionInput, CandidateRule, ClassifyContext, Json, JsonObject, SlippedWrite, Subject, TighteningRejectReason } from "@open-team/kernel";
import { AppError } from "@open-team/platform";
import { applyJsonPatch, proposeTightening, type DiscardedProposal, type PatchOp, type SlippedCase, type TightenHints } from "@open-team/rehearsal";
import { findToolManifest, type ShopState, type TighteningProposal } from "@open-team/sim-core";
import { KNOWN_CONNECTORS } from "../connectors/known.ts";
import type { AppDeps } from "../deps.ts";
import { catalogOf } from "../owner-setup.ts";
import { applyTightening, type ApplyTighteningResult } from "./apply.ts";
import { buildJobMaterials } from "./launch.ts";
import { reportFromScenarioRows, type RehearsalReport } from "./report.ts";
import type { RehearsalRunDeps } from "./run.ts";
import { KillSwitchBeforeStart, runRehearsalSuite, type SuiteOutcome } from "./suite.ts";

// ---- 材料の読み出し ----

type MaterialDeps = Pick<RehearsalRunDeps, "db" | "simClient" | "clock">;

/** 締める提案の検証に使う、ワークスペースのポリシーとコネクタの状態（apply.ts と同じ材料） */
async function classifyContextOf(db: RehearsalRunDeps["db"], ctx: WsCtx): Promise<ClassifyContext> {
  const policyRow = await getLatestWorkspacePolicy(db, ctx);
  if (policyRow === null) throw new AppError("INTERNAL_ERROR", "ワークスペースのポリシーがありません");
  return {
    ceilings: DEFAULT_CEILINGS,
    workspacePolicy: parseWorkspacePolicy(policyRow.policy),
    tools: catalogOf(await listConnectors(db, ctx), await listConnectorTools(db, ctx)),
  };
}

/**
 * 走行の行に残した候補のルール（tool_hash を持たない）を、kernel の判定し直しに使える形にする。
 * tool_hash は走行の行のツールの指紋（run.tool_hashes。action で引く）から。引けない候補は使わない
 * （その候補で通った書き込みは判定し直しで塞がらないままになり、案は捨てられる＝安全側）
 */
export function kernelCandidatesOf(run: Pick<RehearsalRunRow, "candidate_rules" | "tool_hashes"> | null): CandidateRule[] {
  if (run?.candidate_rules == null) return [];
  const out: CandidateRule[] = [];
  for (const c of run.candidate_rules) {
    const hash = run.tool_hashes?.find((t) => t.action === c.action)?.toolHash;
    if (hash !== undefined) out.push({ action: c.action, match: c.match, free: c.free, tool_hash: hash });
  }
  return out;
}

/** 判定の記録の matched_rule（'rules.items[N]'）の添字。ルールの場所でなければ null */
export function ruleIndexOf(matchedRule: string | null): number | null {
  const m = matchedRule === null ? null : /^rules\.items\[(\d+)\]$/.exec(matchedRule);
  return m === null ? null : Number(m[1]);
}

/** 仕事の今の定義（今のスナップショット）。なければ null */
async function currentDefinitionOf(db: RehearsalRunDeps["db"], ctx: WsCtx, jobId: Uuid): Promise<AgentDefinitionInput | null> {
  const stage = await getJobStage(db, ctx, jobId);
  if (stage === null) return null;
  const snapshot = await getAgentSnapshotRow(db, ctx, stage.agent_snapshot_id);
  return snapshot?.definition == null ? null : (snapshot.definition as unknown as AgentDefinitionInput);
}

/** oracle_results.governed のオラクルの失敗が指す書き込み（intentId）。形が合わないものは無視する */
export function blamedIntentIds(oracleResults: Json | null): Uuid[] {
  if (oracleResults === null || typeof oracleResults !== "object" || Array.isArray(oracleResults)) return [];
  const governed = (oracleResults as JsonObject).governed;
  if (!Array.isArray(governed)) return [];
  const ids: Uuid[] = [];
  for (const verdict of governed) {
    const failures = verdict !== null && typeof verdict === "object" && !Array.isArray(verdict) ? (verdict as JsonObject).failures : undefined;
    if (!Array.isArray(failures)) continue;
    for (const f of failures) {
      const writes = f !== null && typeof f === "object" && !Array.isArray(f) ? (f as JsonObject).writes : undefined;
      if (!Array.isArray(writes)) continue;
      for (const w of writes) {
        const id = w !== null && typeof w === "object" && !Array.isArray(w) ? (w as JsonObject).intentId : undefined;
        if (typeof id === "string" && !ids.includes(id)) ids.push(id);
      }
    }
  }
  return ids;
}

/** 判定の記録の subject を、判定し直せる Subject にする（ツール呼び出しの call は判定に使わないので外す）。足りなければ null */
export function subjectOfSource(raw: JsonObject | null): Subject | null {
  if (raw === null) return null;
  if (raw.kind !== "tool_call" || raw.actionType !== "mcp_call" || typeof raw.action !== "string") return null;
  if (raw.args === null || typeof raw.args !== "object" || Array.isArray(raw.args)) return null;
  if (raw.tool === null || typeof raw.tool !== "object" || Array.isArray(raw.tool)) return null;
  const { call: _call, ...rest } = raw;
  return { ...rest, paths: Array.isArray(raw.paths) ? (raw.paths as string[]) : [] } as unknown as Subject;
}

interface JobSlips {
  jobId: Uuid;
  jobSlug: string;
  slipped: SlippedCase[];
  /** 判定の記録がなくて判定し直せなかった書き込みの数（案の材料にしない） */
  skippedWrites: number;
  /** 状況の行の id → その走行の世界の最終状態（案の数値の材料）。取れなければ入らない */
  states: ShopState[];
}

/** 走行の「失敗した状況」から、原因とされた書き込みを仕事ごとにまとめる */
async function collectSlips(deps: MaterialDeps, ctx: WsCtx, runIds: readonly Uuid[], only?: { scenarioIds?: readonly string[]; jobId?: Uuid }): Promise<JobSlips[]> {
  const { db } = deps;
  const rows = (await Promise.all(runIds.map((id) => listRehearsalScenarios(db, ctx, id)))).flat().filter((r) => r.status === "done" && r.verdict === "fail");
  const scenarios = rows.filter((r) => only?.scenarioIds === undefined || only.scenarioIds.length === 0 || only.scenarioIds.includes(r.id));
  const intentIds = scenarios.flatMap((r) => blamedIntentIds(r.oracle_results));
  const sources: SlippedWriteSource[] = (await listSlippedWriteSources(db, ctx, intentIds)).filter((s) => only?.jobId === undefined || s.jobId === only.jobId);
  const byJob = new Map<Uuid, JobSlips>();
  // matched_rule の添字を、書き込みのときの実効ポリシー（走行に残したもの、なければタスクのスナップショット）のルール id に直す
  const runCache = new Map<Uuid, RehearsalRunRow | null>();
  const ruleIdOf = async (src: SlippedWriteSource, runId: Uuid | undefined): Promise<string | null> => {
    const idx = ruleIndexOf(src.matchedRule);
    if (idx === null) return null;
    if (runId !== undefined && !runCache.has(runId)) runCache.set(runId, await getRehearsalRun(db, ctx, runId));
    const fromRun = runId === undefined ? null : (runCache.get(runId)?.effective_policies?.[src.jobSlug]?.policy ?? null);
    const policy = fromRun ?? (await getAgentSnapshotRow(db, ctx, src.agentSnapshotId))?.effective_policies?.[src.jobSlug]?.policy ?? null;
    return policy?.rules.items[idx]?.id ?? null;
  };
  const stateCache = new Map<Uuid, ShopState | null>();
  for (const s of sources) {
    const slot = byJob.get(s.jobId) ?? { jobId: s.jobId, jobSlug: s.jobSlug, slipped: [], skippedWrites: 0, states: [] };
    byJob.set(s.jobId, slot);
    const subject = subjectOfSource(s.subject);
    if (subject === null) {
      slot.skippedWrites++;
      continue;
    }
    const row = scenarios.find((r) => r.id === s.scenarioId);
    slot.slipped.push({ id: s.scenarioId, jobId: s.jobSlug, subject, ruleId: await ruleIdOf(s, row?.rehearsal_run_id) });
    const executionId = row?.governed_execution_id ?? null;
    if (executionId !== null && !stateCache.has(executionId)) {
      try {
        const d = await deps.simClient.getExecution({ workspaceId: ctx.workspaceId, executionId });
        stateCache.set(executionId, d.state as ShopState);
      } catch {
        stateCache.set(executionId, null); // 世界の状態が取れなければ数値の材料なし（ガードの案は作らない）
      }
    }
    const st = executionId === null ? null : (stateCache.get(executionId) ?? null);
    if (st !== null && !slot.states.includes(st)) slot.states.push(st);
  }
  return [...byJob.values()];
}

/**
 * 案の数値の材料（世界ごとに固定した「通常」の値：O-05）。発注（supplier.place_order）で、すり抜けた注文の SKU の通常の値から：
 * 数量は通常の発注量の3倍まで、単価は通常の単価の1.5倍まで。複数の SKU・状況があれば最も厳しい値（安全側）を使う。
 * 通常の値が分からないものは作らない（値を作り出さない）
 */
export function shopHintsOf(slipped: readonly SlippedCase[], states: readonly ShopState[]): TightenHints {
  let qty: number | null = null;
  let price: number | null = null;
  for (const s of slipped) {
    if (!s.subject.action?.endsWith(".place_order")) continue;
    const items = (s.subject.args as JsonObject).items;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const sku = it !== null && typeof it === "object" && !Array.isArray(it) ? (it as JsonObject).sku : undefined;
      if (typeof sku !== "string") continue;
      for (const st of states) {
        const normal = st.normal[sku];
        if (normal === undefined) continue;
        qty = Math.min(qty ?? Infinity, 3 * normal.orderQty);
        price = Math.min(price ?? Infinity, Math.floor(1.5 * normal.unitPrice));
      }
    }
  }
  const bounds: Record<string, { max: number }> = {};
  if (qty !== null) bounds["items[].quantity"] = { max: qty };
  if (price !== null) bounds["items[].unit_price"] = { max: price };
  return { bounds };
}

/**
 * 案の文に出すルールの中身（「山田珈琲への発注は以後も許可」）。内部の ID（r-0001）を画面に出さないため（D-108）。
 * 宛先を固定した値を、仕入れ先なら世界の仕入れ先の名前に直す（分からなければ値のまま）。宛先が読めないルールは操作だけ（「発注は以後も許可」）。
 * 操作の名前が分からないルールは入れない（tighten.ts が「以後も許可にしたルール（N番目）」と出す）
 */
export function shopRuleLabelsOf(
  rules: AgentDefinitionInput["rules"] | ReadonlyArray<{ id: string; action: string; match?: Readonly<Record<string, Json>> }>,
  states: ReadonlyArray<Pick<ShopState, "suppliers">>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules ?? []) {
    const found = findToolManifest(KNOWN_CONNECTORS, rule.action.replace(/^mcp\./, ""));
    if (found === null) continue;
    const match = (rule.match ?? {}) as Record<string, Json>;
    const dests = Object.entries(found.tool.argRoles)
      .filter(([path, role]) => role === "destination" && Object.hasOwn(match, path))
      .map(([path]) => {
        const v = match[path];
        const raw = Array.isArray(v) ? v.join("・") : typeof v === "string" || typeof v === "number" ? String(v) : null;
        if (raw === null) return null;
        if (path === "supplier_id") return states.flatMap((st) => st.suppliers).find((x) => x.id === raw)?.name ?? raw;
        return raw;
      })
      .filter((x): x is string => x !== null && x.trim() !== "");
    out[rule.id] = dests.length > 0 ? `${dests.join("・")}への${found.tool.actionNoun}は以後も許可` : `${found.tool.actionNoun}は以後も許可`;
  }
  return out;
}

// ---- 提案 ----

export interface TightenSuggestion {
  jobId: Uuid;
  jobSlug: string;
  /** narrow で、その書き込みを塞ぐ案だけ（種類・差分の順） */
  proposals: TighteningProposal[];
  /** 捨てた案（理由つき。narrow でない・塞がらない・当てられない）。ユーザーには出さず、監査・試験のために返す */
  discarded: DiscardedProposal[];
  /** 判定し直せなくて材料にしなかった書き込みの数 */
  skippedWrites: number;
}

export interface ProposeInput {
  /** 失敗を探す走行（初回・適応の走行） */
  runIds: readonly Uuid[];
}

/**
 * すり抜けた失敗から、締める提案を作る（仕事ごと）。失敗がなければ空の配列。
 * 案が残る条件は kernel の checkTighteningProposal だけ（自前の分類はしない）。classification が narrow 以外のものは念のためここでも落とす
 */
export async function proposeTighteningForRuns(deps: MaterialDeps, ctx: WsCtx, input: ProposeInput): Promise<TightenSuggestion[]> {
  const { db } = deps;
  if (input.runIds.length === 0) return [];
  const first = await getRehearsalRun(db, ctx, input.runIds[0]!);
  const candidateRules = kernelCandidatesOf(first);
  const classifyCtx = await classifyContextOf(db, ctx);
  const out: TightenSuggestion[] = [];
  for (const job of await collectSlips(deps, ctx, input.runIds)) {
    const before = await currentDefinitionOf(db, ctx, job.jobId);
    if (before === null || job.slipped.length === 0) continue;
    const r = proposeTightening({
      before,
      ctx: classifyCtx,
      slipped: job.slipped,
      ...(candidateRules.length > 0 ? { candidateRules } : {}),
      hints: { ...shopHintsOf(job.slipped, job.states), ruleLabels: shopRuleLabelsOf(before.rules, job.states) },
    });
    const narrowOnly = r.proposals.filter((p) => p.classification === "narrow");
    out.push({
      jobId: job.jobId,
      jobSlug: job.jobSlug,
      proposals: narrowOnly,
      discarded: [...r.discarded, ...r.proposals.filter((p) => p.classification !== "narrow").map((p): DiscardedProposal => ({ kind: p.kind, reason: "not_narrow", fixes: p.fixes }))],
      skippedWrites: job.skippedWrites,
    });
  }
  return out;
}

// ---- 案の検証 ----

/** 外から来た差分（保存した案・画面から戻ってきた案）の形を確かめる。add・replace・remove だけ。違えば null */
export function parsePatch(raw: unknown): PatchOp[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) return null;
  const ops: PatchOp[] = [];
  for (const x of raw) {
    if (x === null || typeof x !== "object" || Array.isArray(x)) return null;
    const o = x as Record<string, unknown>;
    if (typeof o.path !== "string" || !o.path.startsWith("/") || o.path.length > 200) return null;
    if (o.op === "remove") ops.push({ op: "remove", path: o.path });
    else if ((o.op === "add" || o.op === "replace") && "value" in o) ops.push({ op: o.op, path: o.path, value: o.value as Json });
    else return null;
  }
  return ops;
}

export type VetReject = TighteningRejectReason | "not_applicable" | "bad_patch" | "no_such_job";
export type VetResult = { ok: true; patch: PatchOp[]; jobId: Uuid } | { ok: false; reason: VetReject };

export interface VetInput {
  /** 案のもとになった走行（と、すり抜けを探す走行） */
  runIds: readonly Uuid[];
  /** 締める対象の仕事（uuid） */
  jobId: Uuid;
  patch: unknown;
  /** 案が塞ぐとされた状況の行（TighteningProposal.fixes）。空なら、その仕事のすべての失敗を塞ぐかで確かめる */
  fixes?: readonly string[];
}

/**
 * 案を適用してよいか：差分の形 → 今の定義に当たるか → kernel の checkTighteningProposal（narrow であること・すり抜けた書き込みを塞ぐこと）。
 * 判定は kernel に任せる。決定論（同じ定義・同じ書き込みなら同じ結果）なので、エージェントの揺らぎには左右されない。
 * すり抜けた書き込みの記録が見つからない（材料がない）ときは、塞ぐことの確認は省き、narrow であることだけを見る（締める変更は害がない）
 */
export async function vetProposal(deps: MaterialDeps, ctx: WsCtx, input: VetInput): Promise<VetResult> {
  const { db } = deps;
  const patch = parsePatch(input.patch);
  if (patch === null) return { ok: false, reason: "bad_patch" };
  const before = await currentDefinitionOf(db, ctx, input.jobId);
  if (before === null) return { ok: false, reason: "no_such_job" };
  let after: unknown;
  try {
    after = applyJsonPatch(before, patch);
  } catch {
    return { ok: false, reason: "not_applicable" };
  }
  const classifyCtx = await classifyContextOf(db, ctx);
  const slips = (await collectSlips(deps, ctx, input.runIds, { jobId: input.jobId, ...(input.fixes ? { scenarioIds: input.fixes } : {}) })).find((j) => j.jobId === input.jobId);
  const slipped: SlippedWrite[] = (slips?.slipped ?? []).map((s) => ({ jobId: s.jobId, subject: s.subject }));
  const candidateRules = kernelCandidatesOf(await getRehearsalRun(db, ctx, input.runIds[0]!));
  const check = checkTighteningProposal({
    before,
    after,
    ctx: classifyCtx,
    ...(slipped.length > 0 ? { slipped } : {}),
    ...(candidateRules.length > 0 ? { candidateRules } : {}),
  });
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, patch, jobId: input.jobId };
}

// ---- [適用] と再試験 ----

export interface ApplyAndRetestInput {
  /** 案のもとになった走行（再試験の親。シード・モデル・試した候補のルールを引き継ぐ） */
  runId: Uuid;
  /** 報告で比べる元・すり抜けを探す走行（初回と適応の走行）。既定は [runId] */
  baselineRunIds?: readonly Uuid[];
  /** 依頼（chain）の走行のとき、締める担当の仕事。仕事の走行では省略 */
  jobId?: Uuid;
  proposal: { id?: string; patch: unknown; fixes?: readonly string[] };
  signal?: AbortSignal;
}

export type ApplyAndRetestResult =
  | {
      ok: true;
      applied: ApplyTighteningResult;
      /** 同じシードの再試験（影は走らせない）。走行・結果・合格証の発行の結果 */
      retest: SuiteOutcome;
      /** 3段の報告（初回・適応の結果 → 再試験） */
      report: RehearsalReport;
      /** 締める変更：合格証は失効させない（FR-067。失効の配線は別。ここでは触れていない） */
      tightening: { classification: "narrow"; keepsCertificate: true };
    }
  | { ok: false; reason: VetReject };

type ApplyDeps = Pick<RehearsalRunDeps, "db" | "log" | "clock" | "ids" | "llm" | "gatewayClient" | "simClient" | "registry" | "env"> & Pick<AppDeps, "db" | "clock">;

/**
 * [適用]：案を検証して設定変更として保存し、同じシードで再試験する（呼び出しは再試験が終わるまで待つ）。
 * 通らない案は ok: false と理由を返し、何も保存しない。例外（AppError）：Kill Switch 中 423、動いている走行がある 409、
 * 走行・仕事がない 404、差分がすでに適用済み 409（CHANGE_NOT_PENDING）
 */
export async function applyTighteningAndRetest(deps: ApplyDeps, s: SessionCtx, input: ApplyAndRetestInput): Promise<ApplyAndRetestResult> {
  const { db } = deps;
  const ctx: WsCtx = s;
  const parent = await getRehearsalRun(db, ctx, input.runId);
  if (parent === null) throw new AppError("NOT_FOUND");
  const jobId = parent.job_id ?? input.jobId;
  if (jobId === undefined) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "jobId", reason: "依頼の走行では、締める担当の仕事を指定してください" }] });
  const subject: CaseSubject = parent.job_id !== null ? { jobId: parent.job_id } : { askId: parent.ask_id as Uuid };
  const ws = await getWorkspace(db, ctx);
  if (ws === null) throw new AppError("NOT_FOUND");
  if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");
  const active = await findActiveRehearsalRun(db, ctx, subject);
  if (active !== null) throw new AppError("REHEARSAL_ALREADY_RUNNING", undefined, { details: { runId: active.id } });

  const baselineRunIds = input.baselineRunIds ?? [input.runId];
  // 案の検証（適用の直前にもう一度）。通らなければ何も保存しない
  const vet = await vetProposal(deps, ctx, {
    runIds: baselineRunIds,
    jobId,
    patch: input.proposal.patch,
    ...(input.proposal.fixes ? { fixes: input.proposal.fixes } : {}),
  });
  if (!vet.ok) return vet;

  const applied = await applyTightening(deps, s, { runId: input.runId, ...(parent.job_id === null ? { jobId } : {}), patch: vet.patch });

  // 再試験：今の試験を、親と同じシード・モデル・候補のルールで。新しい状況は作らない（生成は呼ばない）。影は走らせない（shouldRunShadow が retest を除く）
  const materials = await buildJobMaterials(deps, s, subject);
  const cases = await listActiveRehearsalCases(db, ctx, subject);
  const retest = await (async () => {
    try {
      return await runRehearsalSuite(deps, {
        ctx,
        requesterId: s.userId,
        subject,
        trigger: "retest",
        parentRunId: parent.id,
        configChangeId: applied.change.id,
        cases,
        seed: parent.seed,
        modelId: parent.model_id,
        generatorModelId: parent.generator_model_id,
        candidateRules: parent.candidate_rules,
        effectivePolicies: materials.effectivePolicies,
        policyHash: materials.policyHash,
        toolHashes: materials.toolHashes,
        requireNoKillSwitch: true,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (e) {
      // 適用の直後に Kill Switch が入った：適用は済んでいる。再試験は /retest でやり直せる
      if (e instanceof KillSwitchBeforeStart) throw new AppError("KILL_SWITCH_ENGAGED");
      throw e;
    }
  })();

  const baselineRows = (await Promise.all(baselineRunIds.map((id) => listRehearsalScenarios(db, ctx, id)))).flat();
  const retestRows = await listRehearsalScenarios(db, ctx, retest.run.id);
  return { ok: true, applied, retest, report: reportFromScenarioRows(baselineRows, retestRows), tightening: { classification: "narrow", keepsCertificate: true } };
}

/** 走行の行から、再試験の対象（仕事か依頼）を決める（テスト・呼び出し側の補助） */
export function subjectOfRun(run: Pick<RehearsalRunRow, "job_id" | "ask_id">): CaseSubject {
  return run.job_id !== null ? { jobId: run.job_id } : { askId: run.ask_id as Uuid };
}
