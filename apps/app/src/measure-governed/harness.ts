// 統制ありの計測の走らせ方（試験からだけ呼ぶ：DB は @open-team/db/testing の試験ごとのデータベース）。
// リハーサルの試験の世界（startRehearsalWorld：sim-world・gateway・edge・runner・Postgres が本物）に、用意した依頼（受信箱係 → 仕入れ係）を入れ、
// 統制なしの計測と同じ状況（F-01〜F-07・同じパラメータ・同じシード）を1件ずつリハーサルの走行（runRehearsalSuite）にかける。
// - 設定は aggregate.ts の MEASURE_CONFIGS の順。締めたあと（tightened）は「以後も許可」の設定の走行ですり抜けたものから
//   リハーサルの締める提案（proposeTighteningForRuns：決定論）を作り、すべて当てた定義で走らせる
// - 影（統制なし）は「ルールなし」の走行でだけ走らせる（影は Kernel の判定を記録だけにするので設定に左右されない）
// - 走行ごとに費用の日を1日進める（担当の1日 $1 の予算と全体の日次の上限に当たらないように。判定・ガード・承認には効かない）

import { insertWorkspacePolicyIfMissing } from "@open-team/db/app";
import type { Db, Uuid } from "@open-team/db";
import { defaultWorkspacePolicy, hashCanonical, type AgentDefinitionInput, type JsonObject, type ToolHash } from "@open-team/kernel";
import { ScriptedLlmClient, type LlmClient } from "@open-team/llm";
import { measureScenario, measureSeeds, type MeasureFaultId } from "@open-team/measure";
import { applyJsonPatch } from "@open-team/rehearsal";
import { CANDIDATE_RULE } from "../guest-rehearsal/scenarios.ts";
import { T0, addCase, seedChainAsk, startRehearsalWorld, supplierDefinition, type RehearsalWorld } from "../rehearsal/__fixtures__/world.ts";
import { runRehearsalSuite } from "../rehearsal/suite.ts";
import { proposeTighteningForRuns } from "../rehearsal/tighten-apply.ts";
import { branchObs, stoppedByText, type GovernedRunRecord, type MeasureConfig } from "./aggregate.ts";

const DAY_MS = 86_400_000;

/** 試験用のデータベース（@open-team/db/testing の openTestDb）。オーナーのワークスペースは1つの DB に1つなので、設定ごとに開き直す */
export interface MeasureDb {
  db: Db;
  /** sim-world を ot_sim のロールで開くのに使う */
  url: string;
  cleanup(): Promise<void>;
}

export interface GovernedMeasureOptions {
  openDb: () => Promise<MeasureDb>;
  llm: LlmClient;
  modelId: string;
  faults: readonly MeasureFaultId[];
  runs: number;
  baseSeed: number;
  configs: readonly MeasureConfig[];
  /** 計測全体の費用の上限（マイクロドル）。次の走行の前に「使った額 + これまでの1走行の最大」で超えるなら止める */
  maxCostMicroUsd: number;
  /** 走行ごとに呼ぶ（進み具合の表示） */
  onRecord?: (r: GovernedRunRecord, done: number, total: number) => void;
  /** 台本の LLM のとき、状況が変わるごとに呼ぶ（台本を状況で切り替える） */
  onCase?: (fault: MeasureFaultId) => void;
}

export interface GovernedMeasureResult {
  records: GovernedRunRecord[];
  tighteningApplied: string[];
  tighteningNote: string | null;
  stopped: "budget" | null;
  costMicroUsd: number;
}

type DefinitionOf = (h: { placeOrderHash: ToolHash }) => AgentDefinitionInput;

const noRule: DefinitionOf = () => supplierDefinition();
const candidateRule: DefinitionOf = (h) =>
  supplierDefinition({
    rules: [{ id: "r-0001", ...structuredClone(CANDIDATE_RULE), tool_hash: h.placeOrderHash, added_by: "owner", added_at: T0.toISOString() } as never],
  });

/** 統制ありの枝の書き込み（Intent）の判定を数える */
async function governedWriteCounts(db: Db, w: RehearsalWorld, runId: Uuid): Promise<{ asked: number; auto: number; blocked: number }> {
  const r = await db.query<{ decision: string; n: string }>(
    `SELECT i.decision, count(*)::text AS n FROM action_intents i JOIN tasks t ON t.id = i.task_id
      WHERE t.workspace_id = $1 AND t.rehearsal_run_id = $2 AND t.execution_variant = 'governed' GROUP BY i.decision`,
    [w.ws.workspaceId, runId],
  );
  const n = (d: string) => Number(r.rows.find((x) => x.decision === d)?.n ?? 0);
  return { asked: n("approve"), auto: n("allow"), blocked: n("deny") + n("halt") + n("handoff") };
}

interface World {
  w: RehearsalWorld;
  askId: Uuid;
}

async function openWorld(db: Db, url: string, def: DefinitionOf): Promise<World> {
  const w = await startRehearsalWorld(db, url, { agentDefinition: def });
  const policy = defaultWorkspacePolicy(w.ws.kind);
  await db.transaction((tx) => insertWorkspacePolicyIfMissing(tx, w.ws.ctx, { policy: policy as unknown as JsonObject, policyHash: hashCanonical(policy), createdBy: null, now: T0 }));
  const { askId } = await seedChainAsk(w);
  return { w, askId };
}

export async function runGovernedMeasurement(o: GovernedMeasureOptions): Promise<GovernedMeasureResult> {
  const seeds = measureSeeds({ baseSeed: o.baseSeed, faults: o.faults, runs: o.runs, seedMode: "per_scenario" });
  const records: GovernedRunRecord[] = [];
  const total = o.configs.length * o.faults.length * o.runs;
  let spent = 0;
  let maxOne = 0;
  let stopped: "budget" | null = null;
  let tighteningApplied: string[] = [];
  let tighteningNote: string | null = null;
  // 費用の日を走行ごとに進め、同じ時刻の並びが揺れないように呼ばれるたびに1秒進める（build.test.ts と同じ）
  let day = 0;
  let ticks = 0;
  const clock = { now: () => new Date(T0.getTime() + day * DAY_MS + ticks++ * 1000) };
  const dummy = new ScriptedLlmClient(() => {
    throw new Error("使わない");
  });
  let tightenedDef: DefinitionOf | null = null;

  for (const config of o.configs) {
    let def: DefinitionOf;
    if (config === "no_rule") def = noRule;
    else if (config === "candidate_rule") def = candidateRule;
    else {
      if (tightenedDef === null) {
        tighteningNote ??= "「以後も許可」の設定を走らせていない";
        continue;
      }
      def = tightenedDef;
    }
    const mdb = await o.openDb();
    let world: World | null = null;
    const runIds: Uuid[] = [];
    try {
      const wd = (world = await openWorld(mdb.db, mdb.url, def));
      // 回ごとに状況を一巡させる（費用で途中で止まっても状況ごとの回数がそろう）
      for (let rep = 1; rep <= o.runs && stopped === null; rep++) {
        for (const fault of o.faults) {
          if (spent + maxOne > o.maxCostMicroUsd) {
            stopped = "budget";
            break;
          }
          const seed = seeds[fault][rep - 1]!;
          const c = await addCase(wd.w, measureScenario(fault, seed), "generated", { askId: wd.askId });
          o.onCase?.(fault);
          day += 1;
          const out = await runRehearsalSuite(wd.w.deps(dummy, { llm: o.llm, clock, edge: {} }), {
            ctx: wd.w.ws.ctx,
            requesterId: wd.w.ws.userId,
            subject: { askId: wd.askId },
            trigger: "manual",
            seed,
            modelId: o.modelId,
            cases: [c],
            shadowFor: () => config === "no_rule",
          });
          runIds.push(out.run.id);
          spent += out.costMicroUsd;
          maxOne = Math.max(maxOne, out.costMicroUsd);
          const oc = out.outcomes[0];
          const writes = await governedWriteCounts(mdb.db, wd.w, out.run.id);
          const base = { config, fault, rep, seed, costMicroUsd: out.costMicroUsd, approvalsAsked: writes.asked, writesAutoAllowed: writes.auto, writesBlocked: writes.blocked };
          const rec: GovernedRunRecord =
            oc?.kind === "done"
              ? {
                  ...base,
                  status: "done",
                  error: null,
                  outcome: oc.result.outcome,
                  stoppedBy: stoppedByText(oc.result.stoppedBy),
                  governed: branchObs(oc.result.governed),
                  approveBranch: branchObs(oc.result.approveBranch, true),
                  shadow: branchObs(oc.result.shadow),
                }
              : {
                  ...base,
                  status: oc?.kind ?? "error",
                  error: oc === undefined ? "結果がない" : oc.kind === "error" ? oc.error : oc.kind === "aborted" ? String(oc.reason) : JSON.stringify(oc.kind === "not_started" ? oc.reason : null),
                  outcome: null,
                  stoppedBy: null,
                  governed: null,
                  approveBranch: null,
                  shadow: null,
                };
          records.push(rec);
          o.onRecord?.(rec, records.length, total);
        }
      }
      if (config === "candidate_rule") {
        // 締める提案（すり抜けた書き込みから決定論で作る。narrow で塞がる案だけ）をすべて当てる
        const suggestions = await proposeTighteningForRuns(wd.w.deps(dummy, { clock }), wd.w.ws.ctx, { runIds });
        const buyer = suggestions.find((s) => s.jobId === wd.w.agent.jobId);
        // 同じすり抜けを塞ぐ別の案（ガードを付ける／ルールを取り消す…）が並ぶので、案の順（緩い変更が先）に、
        // まだ塞いでいないすり抜けを塞ぐ案だけを当てる（利用者が1つ選んで [適用] するのに近づける）
        const covered = new Set<string>();
        const proposals = (buyer?.proposals ?? []).filter((p) => {
          if (p.fixes.every((id) => covered.has(id))) return false;
          for (const id of p.fixes) covered.add(id);
          return true;
        });
        if (proposals.length === 0) {
          tighteningNote = "「以後も許可」の設定ですり抜けがなく、締める提案がなかった";
        } else {
          tighteningApplied = proposals.map((p) => `${p.text}（${p.kind}）`);
          tightenedDef = (h) => {
            let d = candidateRule(h);
            for (const p of proposals) {
              try {
                d = applyJsonPatch(d, p.patch as never);
              } catch {
                // 前の案と重なって当てられない案は飛ばす（同じ穴を塞ぐ別の案）
              }
            }
            return d;
          };
        }
      }
    } finally {
      await world?.w.close();
      await mdb.cleanup();
    }
  }
  return { records, tighteningApplied, tighteningNote, stopped, costMicroUsd: spent };
}
