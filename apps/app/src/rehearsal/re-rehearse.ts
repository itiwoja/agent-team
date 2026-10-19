// 合格証の失効と自動の再リハーサル（FR-067・D-78）：切れたら今の試験だけをもう一度走らせ、全件合格なら新しい合格証を出す。
// - 切れる契機：広げる変更（widen）の適用・使うツールの tool_hash の変化（gateway が切る）・モデルの変更・試験の追加（incident-hook・user-case が切る）。
//   widen の適用とモデルの変更は expireJobCertificate / tick の最初の手順で revokeJobCertificate を呼ぶ。締める変更では切らない（apply.ts）
// - 再リハーサルは毎分の tick の手順（reRehearsalStep）。新しい状況は作らず（Gemini の生成を呼ばない）、影の走行もしない（trigger = recertify）。
//   同じシード・今のモデル・今のスナップショットの指紋で走らせるので、全件合格なら suite.ts → certify.ts が合格証を出す
// - 不合格のときは合格証を出さず、走行を done のまま残す（結果の画面から締める提案 FR-045 を出せる）。切れたあとに走行があれば拾い直さない（毎分の無限の再実行を避ける）
// - 費用の上限（1日の上限・リハーサル1回の上限）で止まった再リハーサル（failed・abort_reason = budget）は、同じ日には拾い直さず（毎分同じ上限に当たるだけ）、
//   翌日（Asia/Tokyo の0時から）に1日1回やり直す（D-107。system.scanPendingRecertifications）。止まっている間、依頼のページは「費用の上限に達したため…」を出す
// - 切れている間の本番は decide() が certificate_missing で確認に回す（kernel）。ここは再試験を回すだけ

import type { RehearsalCertificateRow, SessionCtx, Uuid, WsCtx } from "@open-team/db";
import { getWorkspace, system, wsCtxOf } from "@open-team/db";
import { findActiveRehearsalRun, listActiveRehearsalCases, revokeJobCertificate } from "@open-team/db/rehearsal";
import type { AppDeps, TickStep } from "../deps.ts";
import { buildJobMaterials } from "./launch.ts";
import { KillSwitchBeforeStart, runRehearsalSuite } from "./suite.ts";

type ReRehearseDeps = Pick<AppDeps, "db" | "log" | "clock" | "ids" | "llm" | "gatewayClient" | "simClient" | "registry" | "env">;

/** 1回の tick で走らせる再リハーサルの数の上限（DB の接続は2本：SO §4.6。残りは次の tick） */
export const RE_REHEARSALS_PER_TICK = 2;

/** 仕事の有効な合格証を切る（広げる変更の適用・モデルの変更の呼び出し側が使う）。切れたものがなければ null。再リハーサルは次の tick が走らせる */
export async function expireJobCertificate(
  deps: Pick<AppDeps, "db" | "clock">,
  ctx: WsCtx,
  jobId: Uuid,
  reason: "widen" | "model",
): Promise<RehearsalCertificateRow | null> {
  return deps.db.transaction((tx) => revokeJobCertificate(tx, ctx, jobId, reason, deps.clock.now()));
}

export type ReRehearseOutcome = "passed" | "failed" | "skipped";

/** 切れた仕事を1件、今の試験だけで再リハーサルする。走らせたら passed（合格証を出した）か failed（出さなかった）、走らせなかったら skipped */
export async function reRehearseJob(
  deps: ReRehearseDeps,
  hit: { workspaceId: Uuid; workspaceKind: "owner" | "guest"; jobId: Uuid; reason: "widen" | "tool_hash" | "model" | "case_added"; seed: number | null; requestedBy: Uuid | null },
): Promise<ReRehearseOutcome> {
  const ctx = wsCtxOf({ id: hit.workspaceId, kind: hit.workspaceKind }, hit.requestedBy);
  const subject = { jobId: hit.jobId };
  // 起こした人がいない（削除された）試験は、誰の名前でも走らせない。合格証がないままで締める側に残る
  if (hit.requestedBy === null) {
    deps.log.warn("rehearsal.recertify_skipped", "再リハーサルの依頼者がいないので走らせない", { workspaceId: hit.workspaceId, jobId: hit.jobId });
    return "skipped";
  }
  if ((await findActiveRehearsalRun(deps.db, ctx, subject)) !== null) return "skipped";
  const cases = await listActiveRehearsalCases(deps.db, ctx, subject);
  if (cases.length === 0) return "skipped";

  // 今のスナップショットの指紋（合格証の policyHash・toolHashes になる）
  const materials = await buildJobMaterials(deps, { ...ctx, userId: hit.requestedBy } as unknown as SessionCtx, subject);
  if (materials.policyHash === null || materials.toolHashes === null) return "skipped";

  // 指紋を作る間に Kill Switch が入ったかもしれない。ここで見て、行を作る瞬間にも（suite 側で）ロックの下で確かめる
  const ws = await getWorkspace(deps.db, ctx);
  if (ws === null || ws.kill_switch_engaged) return "skipped";

  const controller = new AbortController();
  const key = deps.ids.newId();
  deps.registry.register(key, ctx.workspaceId, controller, "rehearsal_run");
  let registeredAs = key;
  try {
    const outcome = await runRehearsalSuite(deps, {
      ctx,
      requesterId: hit.requestedBy,
      subject,
      trigger: "recertify",
      requireNoKillSwitch: true,
      reason: hit.reason,
      cases,
      // 同じ試験を同じシードで。モデルは今のもの（モデルの変更で切れたときの確かめ）
      seed: hit.seed ?? 0,
      modelId: deps.env.gemini.agentModel,
      effectivePolicies: materials.effectivePolicies,
      policyHash: materials.policyHash,
      toolHashes: materials.toolHashes,
      signal: controller.signal,
      onRunCreated: (run) => {
        // Kill Switch の見回り・通知は登録簿の ID で探す。走行の ID に付け替える（同じ controller）
        deps.registry.unregister(registeredAs);
        registeredAs = run.id;
        deps.registry.register(run.id, ctx.workspaceId, controller, "rehearsal_run");
      },
    });
    const issued = outcome.certificate?.issued === true;
    if (!issued) {
      deps.log.warn("rehearsal.recertify_not_passed", "再リハーサルで合格証を出せなかった（結果から締める提案を出せる）", {
        workspaceId: hit.workspaceId,
        jobId: hit.jobId,
        runId: outcome.run.id,
        status: outcome.run.status,
        reason: outcome.certificate?.issued === false ? outcome.certificate.reason : null,
      });
    }
    return issued ? "passed" : "failed";
  } catch (e) {
    // 開始の直前に Kill Switch が入った：走行の行は作っていない。止まりが解けたら次の tick が拾い直す
    if (e instanceof KillSwitchBeforeStart) return "skipped";
    throw e;
  } finally {
    deps.registry.unregister(registeredAs);
  }
}

/** tick の手順：モデルの変更で切れた合格証を切り、切れた仕事を今の試験だけで再リハーサルする */
export const reRehearsalStep: TickStep = {
  name: "rehearsal.re-rehearse",
  async run(deps, now) {
    // モデルの変更：有効な合格証のモデルが今のエージェントのモデルと違えば切る
    for (const d of await system.scanModelDriftedCertificates(deps.db, deps.env.gemini.agentModel)) {
      await deps.db.transaction((tx) => revokeJobCertificate(tx, wsCtxOf({ id: d.workspaceId, kind: d.workspaceKind }), d.jobId, "model", now));
    }
    let started = 0;
    for (const hit of await system.scanPendingRecertifications(deps.db, RE_REHEARSALS_PER_TICK, now)) {
      try {
        const outcome = await reRehearseJob(deps, { ...hit, workspaceKind: hit.workspaceKind });
        if (outcome !== "skipped") started += 1;
      } catch (error) {
        // 1件の失敗（同時の起動など）でほかを止めない。切れたあとの走行ができていれば拾い直さない
        deps.log.error("rehearsal.recertify_failed", "再リハーサルが失敗した", { workspaceId: hit.workspaceId, jobId: hit.jobId, error });
      }
    }
    return { reRehearsals: started };
  },
};
