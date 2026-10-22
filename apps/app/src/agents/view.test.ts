// エージェントの一覧のビュー（固定の文・生まれた依頼・いまの様子）の純粋な試験
import type { AgentRow } from "@open-team/db";
import type { AgentAskRow, AgentJobSummaryRow, AgentListRow } from "@open-team/db/agents";
import { describe, expect, it } from "vitest";
import { activityOf, growthLineOf, libraryItem } from "./view.ts";

const T = new Date("2026-10-14T01:00:00.000Z");
const WS = "00000000-0000-4000-8000-000000000001";
const A1 = "00000000-0000-4000-8000-00000000000a";

function agent(over: Partial<AgentRow> = {}): AgentRow {
  return {
    id: A1,
    workspace_id: WS,
    slug: "a-abcdefgh",
    name: "仕入れ係",
    name_source: "suggested",
    role: "assist",
    appearance: {},
    status: "active",
    current_snapshot_id: null,
    disabled_by: null,
    disabled_reason: null,
    disabled_at: null,
    created_at: T,
    updated_at: T,
    ...over,
  };
}

function row(over: Partial<AgentListRow> = {}): AgentListRow {
  return { agent: agent(), jobCount: 2, askCount: 2, taskCount: 3, lastActiveAt: new Date(T.getTime() + 60_000), running: false, awaitingApproval: false, reuseCount: 0, bornAskId: null, allowedRuleCount: 0, skillCount: 0, ...over };
}

const ask = (askId: string, at: Date, over: Partial<AgentAskRow> = {}): AgentAskRow => ({
  agent_id: A1,
  ask_id: askId,
  ask_text: "在庫を見て発注して",
  ask_status: "done",
  summary: "在庫を見て発注する",
  is_new: false,
  is_spokesperson: true,
  is_aggregator: false,
  position: 2,
  ask_created_at: at,
  ...over,
});

describe("activityOf", () => {
  it("止めている > 動いている > 確認待ち > 待機中 の順で決め、文は固定", () => {
    expect(activityOf(row({ agent: agent({ status: "disabled" }), running: true }))).toEqual({ state: "disabled", text: "止めています" });
    expect(activityOf(row({ running: true, awaitingApproval: true }))).toEqual({ state: "running", text: "動いています" });
    expect(activityOf(row({ awaitingApproval: true }))).toEqual({ state: "awaiting_approval", text: "確認待ち" });
    expect(activityOf(row())).toEqual({ state: "idle", text: "待機中" });
  });
});

describe("libraryItem", () => {
  it("役割・仕事の種類は固定の文にし、生まれた依頼は is_new の依頼のうちいちばん古いもの", () => {
    const newer = "00000000-0000-4000-8000-000000000b02";
    const older = "00000000-0000-4000-8000-000000000b01";
    const asks = [ask(newer, new Date(T.getTime() + 10_000), { is_new: true }), ask(older, T, { is_new: true })];
    const jobs: AgentJobSummaryRow[] = [{ id: "00000000-0000-4000-8000-000000000c01", agent_id: A1, slug: "ask-1-2", kind: "once", template: "assistant", status: "active", created_at: T }];
    const item = libraryItem(row(), asks, jobs);
    expect(item).toMatchObject({
      name: "仕入れ係",
      roleLabel: "手伝う係",
      activity: "idle",
      activityText: "待機中",
      disabledReason: null,
      bornAskId: older,
      lastActiveAt: new Date(T.getTime() + 60_000).toISOString(),
    });
    expect(item.asks.map((k) => k.askId)).toEqual([newer, older]);
    expect(item.jobs).toEqual([expect.objectContaining({ kindLabel: "1回", templateLabel: "手伝う", status: "active" })]);
  });

  it("使い回しだけの担当は bornAskId が null。停止中は理由を出す。役割がなければ roleLabel も null", () => {
    const item = libraryItem(row({ agent: agent({ role: null, status: "disabled", disabled_reason: "誤検知が多い", disabled_at: T }), lastActiveAt: null }), [ask("00000000-0000-4000-8000-000000000b01", T)], []);
    expect(item).toMatchObject({ roleLabel: null, status: "disabled", activity: "disabled", disabledReason: "誤検知が多い", bornAskId: null, lastActiveAt: null, jobs: [] });
  });
});

describe("growthLineOf", () => {
  it("0 でない項目だけを順に並べ、全部 0 なら null", () => {
    expect(growthLineOf({ reuseCount: 4, allowedRuleCount: 2, skillCount: 3 })).toBe("使い回し 4回 · 以後も許可にした 2回 · スキル 3件");
    expect(growthLineOf({ reuseCount: 0, allowedRuleCount: 2, skillCount: 1 })).toBe("以後も許可にした 2回 · スキル 1件");
    expect(growthLineOf({ reuseCount: 0, allowedRuleCount: 0, skillCount: 0 })).toBeNull();
  });
  it("bornAskId は行の値（全期間）を優先する", () => {
    const born = "00000000-0000-4000-8000-000000000b99";
    expect(libraryItem(row({ bornAskId: born, reuseCount: 1 }), [], [])).toMatchObject({ bornAskId: born, growthLine: "使い回し 1回" });
  });
});
