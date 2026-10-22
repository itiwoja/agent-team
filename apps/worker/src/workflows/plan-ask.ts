// 依頼の編成を作る Workflow（FR-061。apps/app/src/asks/create.ts の generateAsk の Workflows 版）。依頼を受けた・質問に答えたあと DO が起動する。
// 歩み：materials（DO：材料）→ plan（設定プランナー。LLM の呼び出しは edge/llm-call.ts の callLlm、費用の記録は DO）→ save（DO：保存して最初の実行を始める）。
// - plan の歩みはやり直さない（LLM のやり直しは callLlm の中だけ。二重に課金しない）。失敗は値（kind: "failed"）にして save に渡す
// - 打ち切りは30秒（A-98。plan の歩みの中の AbortController）。Kill Switch は callLlm の前（DO の llmGate）と保存（materializeFormation）で止まる
// 作ったタスクを動かすのは 4c

import { FORMATION_LIMITS } from "@open-team/kernel";
import { modelForPurpose, type LlmClient } from "@open-team/llm";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { failureReasonOf } from "../asks/generate.ts";
import type { PlanSaveOutcome, PlanStepResult } from "../asks/plan-steps.ts";
import { planFormation } from "../asks/planner.ts";
import { callLlm, type LlmCallTarget } from "../edge/llm-call.ts";
import { llmOf } from "../llm.ts";

export interface PlanAskParams {
  workspaceId: string;
  askId: string;
  /** 依頼した人（実行の requester） */
  userId: string;
}

const NO_RETRY = { retries: { limit: 0, delay: 1_000 } } as const;

/** 試験だけ：生成の打ち切りを短くする */
export const planAskTiming = { generationTimeoutMs: FORMATION_LIMITS.generationTimeoutMs };

export class PlanAskWorkflow extends WorkflowEntrypoint<Env, PlanAskParams> {
  async run(event: WorkflowEvent<PlanAskParams>, step: WorkflowStep): Promise<PlanSaveOutcome> {
    const { workspaceId, askId, userId } = event.payload;
    const ws = () => this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId));

    const input = await step.do("materials", async () => ws().planMaterials(askId));
    if (input === null) return { outcome: "skipped" };

    const result = await step.do("plan", NO_RETRY, async (): Promise<PlanStepResult> => {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, planAskTiming.generationTimeoutMs);
      try {
        const { client, config } = llmOf(this.env);
        const target: LlmCallTarget = { taskId: null, agentId: null, askId, purpose: "planner", phase: "planner" };
        const llm: LlmClient = {
          generate: async (req, opts = {}) =>
            (await callLlm({ ledger: ws(), llm: client, now: () => new Date() }, target, req, opts.signal ?? controller.signal)).response,
        };
        return await planFormation(input, {
          llm,
          model: modelForPurpose(config, "planner"),
          signal: controller.signal,
          onAttempt: async () => {
            await ws().bumpPlannerAttempts(askId);
          },
        });
      } catch (e) {
        return { kind: "failed", reason: failureReasonOf(e, timedOut), detail: e instanceof Error ? e.message : String(e) };
      } finally {
        clearTimeout(timer);
      }
    });

    return step.do("save", async () => ws().planSave({ askId, requesterId: userId, result }));
  }
}
