// 依頼のページの「やったこと」の文（apps/app/src/asks/activity.test.ts の WorkspaceDO 版）
import { describe, expect, it } from "vitest";
import { activityByTask, activityLabel, activityOutcome } from "../../src/views/asks/activity.ts";

describe("activityLabel", () => {
  it("MCP のツールは manifest の名詞にする", () => {
    expect(activityLabel("mcp.gcal.list_events")).toBe("予定の確認");
    expect(activityLabel("mcp.gcal.create_event")).toBe("予定の登録");
  });
  it("manifest にないツールはツール名、MCP 以外は固定の言い方", () => {
    expect(activityLabel("mcp.unknown.do_it")).toBe("do_it");
    expect(activityLabel("submit_report")).toBe("報告をまとめる");
    expect(activityLabel(null)).toBe("ツールの呼び出し");
  });
});

describe("activityOutcome", () => {
  it("判定を画面の結果にする", () => {
    expect(activityOutcome("allow")).toBe("done");
    expect(activityOutcome("approve")).toBe("approval");
    expect(activityOutcome("deny")).toBe("denied");
    expect(activityOutcome("handoff")).toBe("denied");
    expect(activityOutcome("halt")).toBe("halted");
  });
});

describe("activityByTask", () => {
  it("タスクごとに順に並べる", () => {
    const at = new Date("2026-10-08T00:00:00Z");
    const m = activityByTask([
      { task_id: "t1", action: "mcp.gcal.list_events", decision: "allow", created_at: at },
      { task_id: "t2", action: "mcp.gcal.create_event", decision: "approve", created_at: at },
      { task_id: "t1", action: "submit_report", decision: "allow", created_at: at },
    ]);
    expect(m.get("t1")?.map((a) => a.label)).toEqual(["予定の確認"]);
    expect(m.get("t2")).toEqual([{ label: "予定の登録", outcome: "approval", at: at.toISOString() }]);
  });
  it("必ず通る手順は止まったときだけ出す", () => {
    const at = new Date("2026-10-08T00:00:00Z");
    const m = activityByTask([
      { task_id: "t1", action: "finish", decision: "allow", created_at: at },
      { task_id: "t1", action: "submit_report", decision: "deny", created_at: at },
    ]);
    expect(m.get("t1")?.map((a) => a.label)).toEqual(["報告をまとめる"]);
  });
});
