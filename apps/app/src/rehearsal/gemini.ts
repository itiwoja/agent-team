// リハーサルのうちタスクの外で Gemini を呼ぶところ（悪い日の生成・自分の言葉の解釈）の LlmClient。
// edge の callGemini を通す：Kill Switch・費用の上限（走行 $3・ゲスト1日・全体1日。BR-62）・usage_records（phase = 目的）・llm.called のログ。
// 通さないと、費用が走行・1日の集計に入らず、画面にも生成の費用が出ない（2026-10-05 の本番の通し確認で見つけた）

import type { Uuid, WsCtx } from "@open-team/db";
import { GeminiCallError, callGemini } from "@open-team/edge";
import type { LlmClient } from "@open-team/llm";
import { AppError } from "@open-team/platform";
import type { AppDeps } from "../deps.ts";

/** 費用の持ち主（usage_records の CHECK：どれか1つ以上）。走行ができていれば走行、まだなら依頼か担当 */
export interface RehearsalLlmOwner {
  rehearsalRunId?: Uuid;
  askId?: Uuid;
  agentId?: Uuid;
}

export function rehearsalLlm(
  deps: Pick<AppDeps, "db" | "llm" | "clock" | "log">,
  ctx: WsCtx,
  owner: RehearsalLlmOwner,
  purpose: "rehearsal_generate" | "rehearsal_interpret",
): LlmClient {
  return {
    async generate(req, opts = {}) {
      const { response } = await callGemini(
        { db: deps.db, llm: deps.llm, clock: deps.clock, log: deps.log },
        {
          workspaceId: ctx.workspaceId,
          workspaceKind: ctx.kind,
          taskId: null,
          agentId: owner.agentId ?? null,
          askId: owner.askId ?? null,
          rehearsalRunId: owner.rehearsalRunId ?? null,
          purpose,
          phase: purpose,
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        },
        req,
      );
      return response;
    },
  };
}

/** callGemini の失敗を API のエラーにする（Kill Switch 423・費用の上限 429・それ以外 502）。callGemini の失敗でなければ null */
export function geminiCallAppError(e: unknown): AppError | null {
  if (!(e instanceof GeminiCallError)) return null;
  if (e.kind === "kill_switch" || e.kind === "aborted") return new AppError("KILL_SWITCH_ENGAGED");
  if (e.kind === "budget") return new AppError("REHEARSAL_BUDGET_EXCEEDED");
  return new AppError("LLM_UPSTREAM_ERROR", undefined, { cause: e });
}
