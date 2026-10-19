// SG-03 の照合（apps/gateway/src/provenance.ts）が当てにする判定の記録の形が、edge の本物の記録と合っていることの試験。
// gateway の試験（apps/gateway/src/test-helpers.ts の insertKernelEvidence）は判定の行と監査ログを手で作った写しで試すので、
// ここでは本物の edge（LLM Proxy の judgeToolCalls → recordMcpIntent・recordDecision）が書いた policy_decisions・decision.made・
// intent.proposed に gateway の照合（P-1）をそのまま当てる。リハーサルの本番の経路（governed）のタスクは本番と同じ形で記録を残す
import { ScriptedLlmClient } from "@open-team/llm";
import type { ActionIntentRow } from "@open-team/db";
import { listKernelDecisionsOfIntent, listTaskAuditEvents } from "@open-team/db/gateway";
import { insertRehearsalRun } from "@open-team/db/rehearsal";
import { useTestDb } from "@open-team/db/testing";
import { judgeKernelEvidence } from "@open-team/gateway";
import { afterEach, describe, expect, it } from "vitest";
import { BIG_ORDER, addCase, orderScript, scenarioOf, startRehearsalWorld, withOrderRule, type RehearsalWorld, type StartWorldOptions } from "./__fixtures__/world.ts";
import { runRehearsalCase } from "./run.ts";

const T = useTestDb();
let world: RehearsalWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

const PRICE_SURGE = { id: "F-05", sku: "BEAN-HOUSE", multiplier: 3, noticeEmail: false } as const;

/** 本番の経路（governed）で、台本どおり発注した Intent を1件 */
async function governedIntent(o: StartWorldOptions): Promise<{ w: RehearsalWorld; intent: ActionIntentRow }> {
  const { db, url } = T();
  const w = (world = await startRehearsalWorld(db, url, o));
  const run = await insertRehearsalRun(db, w.ws.ctx, { subject: { jobId: w.agent.jobId }, trigger: "initial", seed: 1, modelId: "gemini-test", now: w.clock.now() });
  const c = await addCase(w, scenarioOf("豆の発注が多すぎる", [PRICE_SURGE]));
  const out = await runRehearsalCase(w.deps(new ScriptedLlmClient(orderScript(BIG_ORDER))), { ctx: w.ws.ctx, requesterId: w.ws.userId, runId: run.id, case: c, ordinal: 1 });
  expect(out.kind).toBe("done");
  const rows = await db.query<ActionIntentRow>(
    `SELECT i.* FROM action_intents i JOIN tasks t ON t.id = i.task_id WHERE i.workspace_id = $1 AND t.execution_variant = 'governed' ORDER BY i.created_at`,
    [w.ws.workspaceId],
  );
  expect(rows.rows).toHaveLength(1);
  return { w, intent: rows.rows[0]! };
}

async function kernelEvidenceOf(w: RehearsalWorld, intent: ActionIntentRow) {
  const decisions = await listKernelDecisionsOfIntent(w.db, w.ws.ctx, intent);
  const audits = await listTaskAuditEvents(w.db, w.ws.ctx, intent.task_id);
  return { decisions, audits, result: judgeKernelEvidence(intent, decisions, audits) };
}

describe("SG-03：edge の本物の判定の記録に gateway の照合（P-1）を当てる", () => {
  it("承認へ回った書き込み（approve・approval_required）：判定の行・decision.made・intent.proposed が gateway の照合と一致する", async () => {
    const { w, intent } = await governedIntent({});
    expect(intent).toMatchObject({ decision: "approve", reason_code: "approval_required", enforced: true });
    const { decisions, audits, result } = await kernelEvidenceOf(w, intent);
    expect(result).toMatchObject({ ok: true });
    expect(decisions).toHaveLength(1);
    // 順番：提案 → 判定（同じトランザクション。seq は詰まった連番）
    const seqOf = (type: string) => audits.find((a) => a.event_type === type && a.payload.intentId === intent.id)!.seq;
    expect(seqOf("intent.proposed")).toBeLessThan(seqOf("decision.made"));
    if (result.ok) expect(result.decisionSeq).toBe(seqOf("decision.made"));
  }, 90_000);

  it("ルールで allow の書き込み（rule_matched）：判定の行の flags.certificateValid と記録の形が gateway の照合と一致する", async () => {
    const { w, intent } = await governedIntent({ agentDefinition: (h) => withOrderRule(h) });
    expect(intent).toMatchObject({ decision: "allow", reason_code: "rule_matched", matched_rule: "rules.items[0]", enforced: true });
    const { decisions, result } = await kernelEvidenceOf(w, intent);
    expect(result).toMatchObject({ ok: true });
    expect(decisions[0]!.flags).toMatchObject({ certificateValid: true });
  }, 90_000);
});
