// 依頼の試験の道具（apps/app/src/test-helpers.ts の jsonReply・ワークスペースのポリシー・台本の設定プランナーで編成を保存する道具・事象と監査ログの読み出し）
import { defaultWorkspacePolicy, hashCanonical, type JsonObject } from "@open-team/kernel";
import { ScriptedLlmClient, type ScriptedReply } from "@open-team/llm";
import { loadPlannerMaterials, materializeFormation } from "../../src/asks/generate.ts";
import { planFormation } from "../../src/asks/planner.ts";
import { insertWorkspacePolicyIfMissing } from "../../src/db/repo/app.ts";
import { insertGeneratingAsk } from "../../src/db/repo/asks.ts";
import { all, type WsDb } from "../../src/db/sqlite.ts";
import type { Uuid } from "../../src/db/types.ts";

/** モデルが返す JSON の台本 */
export function jsonReply(value: unknown, usage = { inputTokens: 1000, outputTokens: 500, thinkingTokens: 0 }): ScriptedReply {
  return { parts: [{ type: "text", text: JSON.stringify(value) }], usage };
}

/** ワークスペースのポリシー v1（kernel の既定。オーナーの初期投入と同じ） */
export function fxPolicy(db: WsDb, now: Date, enabledConnectors: readonly string[] = []): void {
  const policy = defaultWorkspacePolicy(enabledConnectors);
  insertWorkspacePolicyIfMissing(db, { policy: policy as unknown as JsonObject, policyHash: hashCanonical(policy), createdBy: null, now });
}


/** 新しい担当の下書き（設定プランナーの members の1人） */
export const draftMember = (over: Record<string, unknown> = {}) => ({
  summary: "調べる",
  template: "researcher",
  instructions: "調べて短く報告してください。",
  grants: [],
  ...over,
});

/** 依頼を generating で作り、台本の設定プランナーで編成を作って保存する（依頼は running） */
export async function formAsk(
  db: WsDb,
  userId: Uuid,
  now: Date,
  formation: Record<string, unknown>,
  text = "調べて https://example.com/a を見て",
): Promise<{ askId: Uuid }> {
  const ask = insertGeneratingAsk(db, { createdBy: userId, text, mentionAgentId: null, now });
  const mats = loadPlannerMaterials(db, ask.id);
  if (mats === null) throw new Error("材料がない");
  const plan = await planFormation(mats.input, { llm: new ScriptedLlmClient([jsonReply({ formation })]), model: "m" });
  if (plan.kind !== "formation") throw new Error("編成のはず");
  const formed = materializeFormation(db, { askId: ask.id, requesterId: userId, planned: plan.formation, now });
  if (formed === null) throw new Error("保存できなかった");
  return { askId: ask.id };
}

/** SSE の事象（workspace_events）を古い順に */
export function events(db: WsDb, type?: string): Array<{ type: string; data: Record<string, unknown> }> {
  const rows = all<{ type: string; data: string }>(db, {}, "SELECT type, data FROM workspace_events ORDER BY id");
  return rows.filter((r) => type === undefined || r.type === type).map((r) => ({ type: r.type, data: JSON.parse(r.data) as Record<string, unknown> }));
}

/** 監査ログの event_type（古い順） */
export function auditTypes(db: WsDb): string[] {
  return all<{ event_type: string }>(db, {}, "SELECT event_type FROM audit_logs ORDER BY seq").map((r) => r.event_type);
}
