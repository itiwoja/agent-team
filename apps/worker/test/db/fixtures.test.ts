// 試験の道具がスキーマの制約（CHECK・外部キー）を満たす行を作れること
import { describe, expect, it } from "vitest";
import { CODECS } from "../../src/db/codecs.ts";
import { one } from "../../src/db/sqlite.ts";
import type { ActionIntentRow, TaskRow } from "../../src/db/types.ts";
import { fxAgent, fxApproval, fxAsk, fxAskMember, fxAskRun, fxConnector, fxIntent, fxTask, fxUsage, inWorkspace } from "./fixtures.ts";

describe("試験の道具", () => {
  it("どの道具も行を作れ、codec で読み戻せる", async () => {
    await inWorkspace((db, ws) => {
      const c = fxConnector(db);
      const agent = fxAgent(db);
      const { askId } = fxAsk(db, ws);
      const { askRunId } = fxAskRun(db, askId);
      fxAskMember(db, { askId, agent, position: 1, isSpokesperson: true });
      const { taskId } = fxTask(db, ws, agent, { askId, askRunId, tainted: true });
      const { intentId } = fxIntent(db, { taskId, jobId: agent.jobId, connectorId: c.connectorId });
      fxApproval(db, ws, { taskId, intentId });
      fxUsage(db, { taskId });

      const task = one<TaskRow>(db, CODECS.tasks, "SELECT * FROM tasks WHERE id = ?", taskId)!;
      expect(task).toMatchObject({ trigger_type: "ask", tainted: true, is_dry_run: false, cost_micro_usd: 0, input_task_ids: [] });
      expect(task.created_at).toBeInstanceOf(Date);
      const intent = one<ActionIntentRow>(db, CODECS.action_intents, "SELECT * FROM action_intents WHERE id = ?", intentId)!;
      expect(intent).toMatchObject({ status: "pending_approval", enforced: true, taint_snapshot: { sources: [], tainted: false } });
    });
  });
});
