// 送る前の確認に出す「前例」（同じ仕事・同じ action の過去のリハーサル）。集計はSQLのCOUNT・MAXで行う。
// - 数えるのは判定まで終わった試験（rehearsal_scenarios.status = done）で、外していない試験（rehearsal_cases.removed_at IS NULL）
// - 同じ action の Intent を含む試験：その状況の走行のタスク（tasks.rehearsal_scenario_id）の action_intents.action が一致するもの
// - 最大損害は影（統制なし）の損害 shadow_damage_jpy。影を走らせなかった試験は件数に入り、最大の対象には入らない
// - 0件なら undefined（画面は何も出さない）。文は決まった形（LLM に書かせない）。ワークスペースで絞る（README §1）

import type { Queryable, WsCtx } from "@open-team/db";
import type { Precedent } from "./contract.ts";
import { actionNounOf } from "./reasons.ts";
import { yen } from "../rehearsal/report.ts";

/** 前例の材料：1つの試験（状況）。shadowDamageJpy は影を走らせていなければ null */
export interface PrecedentRow {
  scenarioId: string;
  shadowDamageJpy: number | null;
}

export interface PrecedentSummary {
  trials: number;
  maxShadowDamageJpy: number | null;
}

/** SQL の集計行からカード用の前例を作る（DB の bigint は float8 で受ける） */
export function precedentSummaryOf(row: { trials: number; maxShadowDamageJpy: number | null }): PrecedentSummary | undefined {
  return row.trials === 0 ? undefined : row;
}

/** 試験の件数と、影の損害の最大（純粋関数。同じ状況は1件として数える） */
export function precedentOf(rows: readonly PrecedentRow[]): PrecedentSummary | undefined {
  const byId = new Map<string, PrecedentRow>();
  for (const r of rows) byId.set(r.scenarioId, r);
  if (byId.size === 0) return undefined;
  let max: number | null = null;
  for (const r of byId.values()) {
    if (r.shadowDamageJpy !== null && (max === null || r.shadowDamageJpy > max)) max = r.shadowDamageJpy;
  }
  return { trials: byId.size, maxShadowDamageJpy: max };
}

/** 1行の文（「練習で同じ種類の発注を12件試し、承認した場合の最大損害は ¥48,000」）。影の損害がなければ件数だけ */
export function precedentText(action: string, s: PrecedentSummary): string {
  const noun = actionNounOf(action);
  const head = `練習で同じ種類の${noun}を${s.trials}件試し`;
  return s.maxShadowDamageJpy === null ? `${head}ました` : `${head}、承認した場合の最大損害は ${yen(s.maxShadowDamageJpy)}`;
}

/** 承認のカードに付ける前例（0件なら undefined） */
export function precedentView(action: string, rows: readonly PrecedentRow[]): Precedent | undefined {
  const s = precedentOf(rows);
  if (s === undefined) return undefined;
  return { trials: s.trials, maxShadowDamageJpy: s.maxShadowDamageJpy, text: precedentText(action, s) };
}

/** 同じ仕事・同じ action の判定済みの試験を集計（読み取りのみ）。bigint の損害は float8 で受ける */
export async function loadPrecedentSummary(q: Queryable, ctx: WsCtx, jobId: string, action: string): Promise<PrecedentSummary | undefined> {
  const r = await q.query<{ trials: number; max_shadow_damage_jpy: number | null }>(
    `SELECT COUNT(DISTINCT s.id)::int AS trials, MAX(s.shadow_damage_jpy)::float8 AS max_shadow_damage_jpy
       FROM rehearsal_scenarios s
       JOIN rehearsal_cases c ON c.workspace_id = s.workspace_id AND c.id = s.case_id
      WHERE s.workspace_id = $1 AND c.removed_at IS NULL AND s.status = 'done'
        AND EXISTS (
          SELECT 1 FROM tasks t
            JOIN action_intents i ON i.workspace_id = t.workspace_id AND i.task_id = t.id
           WHERE t.workspace_id = s.workspace_id AND t.rehearsal_scenario_id = s.id AND t.job_id = $2 AND i.action = $3
        )`,
    [ctx.workspaceId, jobId, action],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  return precedentSummaryOf({ trials: Number(row.trials), maxShadowDamageJpy: row.max_shadow_damage_jpy === null ? null : Number(row.max_shadow_damage_jpy) });
}

/** 承認の行の前例（取得と集計をまとめた入口。0件なら undefined） */
export async function precedentFor(q: Queryable, ctx: WsCtx, jobId: string, action: string): Promise<Precedent | undefined> {
  const summary = await loadPrecedentSummary(q, ctx, jobId, action);
  return summary === undefined ? undefined : { ...summary, text: precedentText(action, summary) };
}
