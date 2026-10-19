// 自分の悪い日（trigger = user_case の走行）の結果（D-93）：結果の取得（GET …/rehearsals/{runId}/result）の userCases に、押された画面の走行から足した分を古い順に並べる。
// 1件ごとに、入力の解釈の1行・走行の状態・状況の行（判定・損害・式と元の値）。やめた・解釈できなかった入力は走行がないので scenario は null

import type { RehearsalRunRow, SessionCtx } from "@open-team/db";
import { listRehearsalScenarios, listUserCaseRunsOf } from "@open-team/db/rehearsal";
import type { AppDeps } from "../deps.ts";
import { rehearsalScenarioView } from "./scenario-view.ts";

export async function userCaseResultsOf(deps: Pick<AppDeps, "db">, s: SessionCtx, parent: RehearsalRunRow) {
  const rows = await listUserCaseRunsOf(deps.db, s, parent.id);
  const out = [];
  for (const { run, input } of rows) {
    const [scenario] = await listRehearsalScenarios(deps.db, s, run.id);
    const line = input?.interpretation?.line;
    out.push({
      id: input?.id ?? run.id,
      text: input?.text ?? null,
      status: input?.status ?? null,
      interpretation: typeof line === "string" ? line : null,
      caseId: input?.case_id ?? null,
      faultIds: scenario?.fault_ids ?? [],
      runId: run.id,
      runStatus: run.status,
      damageJpy: run.damage_jpy,
      withoutControlDamageJpy: run.shadow_damage_jpy,
      preventedDamageJpy: run.prevented_damage_jpy,
      createdAt: run.created_at.toISOString(),
      finishedAt: run.finished_at?.toISOString() ?? null,
      scenario: scenario === undefined ? null : rehearsalScenarioView(scenario),
    });
  }
  return out;
}
