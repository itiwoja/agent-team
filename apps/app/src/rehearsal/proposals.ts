// 結果の画面の「締める提案」（FR-045・D-93）：結果の取得のたびに、すり抜けた失敗から作り直す（proposeTighteningForRuns。LLM なし・保存しない）。
// 提案の id は packages/rehearsal の TighteningProposal.id（種類と差分のハッシュ。同じ失敗なら同じ id）。POST …/tightening は proposalId にこの id を受け取れる。
// fixes は「塞ぐ状況の caseId」（画面の状況の行と合わせる）。label は提案の表示文（種類ごとの決まった文）をそのまま出す

import type { RehearsalRunRow, SessionCtx, Uuid } from "@open-team/db";
import { listRehearsalScenarios } from "@open-team/db/rehearsal";
import type { PatchOp } from "@open-team/rehearsal";
import type { AppDeps } from "../deps.ts";
import { proposeTighteningForRuns } from "./tighten-apply.ts";

export interface ProposalView {
  id: string;
  jobId: Uuid;
  label: string;
  patch: PatchOp[];
  /** 塞ぐ状況の caseId */
  fixes: string[];
}

/** 提案を作れる走行か：終わっていて（done）、最初・手動・適応の走行（再試験・自分の悪い日・回帰は、すり抜けを探す元にしない） */
function proposable(run: RehearsalRunRow): boolean {
  return run.status === "done" && run.trigger !== "retest" && run.trigger !== "user_case";
}

/** 走行の締める提案（仕事ごとの narrow の案。なければ空）。作れなくても結果の取得は止めない（空を返す） */
export async function proposalsOfRun(deps: Pick<AppDeps, "db" | "simClient" | "clock" | "log">, s: SessionCtx, run: RehearsalRunRow): Promise<ProposalView[]> {
  if (!proposable(run)) return [];
  try {
    const scenarios = await listRehearsalScenarios(deps.db, s, run.id);
    const caseOf = new Map(scenarios.map((x) => [x.id as string, x.case_id as string]));
    const suggestions = await proposeTighteningForRuns(deps, s, { runIds: [run.id] });
    return suggestions.flatMap((sg) =>
      sg.proposals.map((p) => ({
        id: p.id,
        jobId: sg.jobId,
        label: p.text,
        patch: p.patch as PatchOp[],
        fixes: [...new Set(p.fixes.map((f) => caseOf.get(f) ?? f))],
      })),
    );
  } catch (e) {
    deps.log.error("rehearsal.proposals_failed", "締める提案を作れなかった", { workspaceId: s.workspaceId, runId: run.id, error: e });
    return [];
  }
}
