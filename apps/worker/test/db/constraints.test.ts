// スキーマの制約の試験（packages/db/src/constraints.test.ts の WorkspaceDO 版。db-schema.md §7.1 の T-08〜T-29 と M-07・M-16・M-20・M-32〜M-34）。
// DO にない表（workspaces・sessions）・ワークスペースの複数の話・Postgres だけの守り（TRUNCATE・occurred_at のマイクロ秒）は落とした。
// 監査ログの守り（T-01）は audit.test.ts。SQLite の一意の違反は制約の名前でなく '表.列' で見分ける
import { describe, expect, it } from "vitest";
import { isCheckViolation, isTriggerAbort, isUniqueViolation, newId, run, type Param, type WsDb } from "../../src/db/sqlite.ts";
import {
  fxAgent,
  fxApproval,
  fxAsk,
  fxAskMember,
  fxConnector,
  fxHash,
  fxIntent,
  fxTask,
  inWorkspace,
  type FxAgent,
  type FxWorkspace,
} from "./fixtures.ts";

function caught(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}
/** CHECK の違反（names のどれか。省くと何でも） */
function expectCheck(fn: () => unknown, ...names: string[]): void {
  const e = caught(fn);
  expect(e, `CHECK ${names.join(" / ")} で止まるはず`).not.toBeNull();
  expect(isCheckViolation(e), String((e as Error).message)).toBe(true);
  if (names.length > 0) expect(names.some((n) => isCheckViolation(e, n)), String((e as Error).message)).toBe(true);
}
function expectUnique(fn: () => unknown, target: string): void {
  const e = caught(fn);
  expect(isUniqueViolation(e, target), String((e as Error | null)?.message)).toBe(true);
}

/** tasks に1行入れる（列を上書きして CHECK を試す） */
function insertTask(db: WsDb, ws: FxWorkspace, agent: FxAgent, cols: Record<string, Param>): void {
  const row: Record<string, Param> = {
    id: newId(),
    requester_id: ws.userId,
    agent_id: agent.agentId,
    agent_snapshot_id: agent.snapshotId,
    job_id: agent.jobId,
    trigger_type: "manual",
    status: "running",
    ...cols,
  };
  const keys = Object.keys(row);
  run(db, `INSERT INTO tasks (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...Object.values(row));
}

describe("タスク（T-20、M-32、BR-38）", () => {
  it("T-20 halted なのに halt_reason がない・failed なのに fail_reason がない・終わったのに finished_at がない", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      expectCheck(() => insertTask(db, ws, agent, { status: "halted", finished_at: new Date() }), "tasks_halt_reason_chk");
      expectCheck(() => insertTask(db, ws, agent, { status: "failed", finished_at: new Date() }), "tasks_fail_reason_chk");
      expectCheck(() => insertTask(db, ws, agent, { status: "completed" }), "tasks_finished_chk");
      expectCheck(() => insertTask(db, ws, agent, { status: "running", halt_reason: "timeout" }), "tasks_halt_reason_chk");
    });
  });

  it("M-32 trigger_type 'ask' と fail_reason 'sandbox_lost' は入り、'runner_lost' は入らない", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      insertTask(db, ws, agent, { trigger_type: "ask" });
      insertTask(db, ws, agent, { status: "failed", fail_reason: "sandbox_lost", finished_at: new Date() });
      expectCheck(() => insertTask(db, ws, agent, { status: "failed", fail_reason: "runner_lost", finished_at: new Date() }));
      expectCheck(() => insertTask(db, ws, agent, { trigger_type: "dry_run" }), "tasks_dry_run_trigger_chk");
    });
  });

  it("BR-38 一度汚染したタスクは汚染なしに戻せない", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent, { tainted: true });
      const e = caught(() => run(db, "UPDATE tasks SET tainted = 0, taint_sources = '[]' WHERE id = ?", taskId));
      expect(isTriggerAbort(e, "tasks.tainted cannot go back to false")).toBe(true);
      expectCheck(() => insertTask(db, ws, agent, { tainted: false, taint_sources: [{ kind: "web_search", at: "x" }] }), "tasks_taint_chk");
    });
  });

  it("報告の出典（M-31）は報告と一緒にだけ入る", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      insertTask(db, ws, agent, { report: "本文", report_kind: "answer", report_sources: [{ kind: "agent", agentName: "受信箱係" }] });
      expectCheck(() => insertTask(db, ws, agent, { report_sources: [] }), "tasks_report_sources_chk");
      expectCheck(() => insertTask(db, ws, agent, { report: "本文" }), "tasks_report_kind_chk");
    });
  });
});

describe("T-08・T-10・T-12・T-13・T-29：費用・スナップショット・依頼・エージェント・仕事", () => {
  it("T-08 持ち主（task・agent・ask）のない費用の行は CHECK usage_records_owner_chk。M-32：phase 'implement' は入る", async () => {
    await inWorkspace((db) => {
      const agent = fxAgent(db);
      const ins = (agentId: string | null, phase: string) =>
        run(
          db,
          `INSERT INTO usage_records (id, agent_id, provider, model, phase, input_tokens, output_tokens, estimated_cost_micro_usd, cost_micro_usd, latency_ms, prompt_hash)
           VALUES (?, ?, 'google', 'g', ?, 1, 1, 0, 0, 1, 'h')`,
          newId(),
          agentId,
          phase,
        );
      expectCheck(() => ins(null, "plan"), "usage_records_owner_chk");
      ins(agent.agentId, "implement");
      ins(agent.agentId, "rehearsal_tighten");
      expectCheck(() => ins(agent.agentId, "design"));
    });
  });

  it("T-10 スナップショットとワークスペースのポリシーは UPDATE できない", async () => {
    await inWorkspace((db) => {
      const agent = fxAgent(db);
      expect(() => run(db, "UPDATE agent_snapshots SET warnings = '[1]' WHERE id = ?", agent.snapshotId)).toThrow("agent_snapshots is immutable");
      run(db, "INSERT INTO workspace_policies (id, version, policy, policy_hash) VALUES (?, 1, '{}', ?)", newId(), fxHash("wp"));
      expect(() => run(db, "UPDATE workspace_policies SET version = 2")).toThrow("workspace_policies is immutable");
    });
  });

  it("T-12 同じ依頼に窓口を2つ置けない（ask_members_spokesperson_uq）。M-34：depends_on は段の番号（1〜6）", async () => {
    await inWorkspace((db, ws) => {
      const a = fxAgent(db, { name: "受信箱係" });
      const b = fxAgent(db, { name: "仕入れ係" });
      const { askId } = fxAsk(db, ws);
      fxAskMember(db, { askId, agent: a, position: 1, isSpokesperson: true });
      expectUnique(() => fxAskMember(db, { askId, agent: b, position: 2, isSpokesperson: true }), "ask_members.ask_id");
      const { memberId } = fxAskMember(db, { askId, agent: b, position: 2 });
      run(db, "UPDATE ask_members SET depends_on = '[1]' WHERE id = ?", memberId);
      run(db, "UPDATE ask_members SET depends_on = '[1,2,3,4,5,6]' WHERE id = ?", memberId);
      expectCheck(() => run(db, "UPDATE ask_members SET depends_on = '[7]' WHERE id = ?", memberId), "ask_members_depends_on_check");
      expectCheck(() => run(db, "UPDATE ask_members SET depends_on = '[0]' WHERE id = ?", memberId), "ask_members_depends_on_check");
      expectCheck(() => run(db, "UPDATE ask_members SET depends_on = '[12]' WHERE id = ?", memberId), "ask_members_depends_on_check");
      expectCheck(() => run(db, `UPDATE ask_members SET depends_on = '["1"]' WHERE id = ?`, memberId), "ask_members_depends_on_check");
    });
  });

  it("T-13 同じ名前のエージェントは作れない（removed は除く）", async () => {
    await inWorkspace((db) => {
      const a = fxAgent(db, { name: "仕入れ係" });
      expectUnique(() => fxAgent(db, { name: "仕入れ係" }), "agents.name");
      run(db, "UPDATE agents SET status = 'removed' WHERE id = ?", a.agentId);
      fxAgent(db, { name: "仕入れ係" });
    });
  });

  it("T-29 同じエージェントに同じ slug の仕事を2つ作れない（agent_jobs_agent_slug_uq）", async () => {
    await inWorkspace((db) => {
      const agent = fxAgent(db);
      expectUnique(
        () => run(db, "INSERT INTO agent_jobs (id, agent_id, slug, kind, template) VALUES (?, ?, ?, 'once', 'researcher')", newId(), agent.agentId, agent.jobSlug),
        "agent_jobs.agent_id, agent_jobs.slug",
      );
    });
  });
});

describe("T-17〜T-19：依頼。M-33・M-47：実行", () => {
  it("T-17 生成中（shape NULL）の依頼は入る。T-18・T-19 は CHECK", async () => {
    await inWorkspace((db, ws) => {
      fxAsk(db, ws, { status: "generating" });
      const ins = (status: string, shape: string | null, reason: string | null) =>
        run(db, "INSERT INTO asks (id, created_by, text, status, shape, failure_reason) VALUES (?, ?, 't', ?, ?, ?)", newId(), ws.userId, status, shape, reason);
      expectCheck(() => ins("failed", null, null), "asks_generation_failed_chk");
      expectCheck(() => ins("running", null, null), "asks_shape_after_generating_chk");
      expectCheck(() => ins("running", "chain", "timeout"), "asks_failure_reason_chk");
      ins("failed", null, "planner_error");
      expectCheck(
        () => run(db, "INSERT INTO asks (id, created_by, text, next_run_at) VALUES (?, ?, 't', ?)", newId(), ws.userId, new Date()),
        "asks_next_run_needs_trigger_chk",
      );
    });
  });

  it("ask_runs：trigger_type に initial。回数は依頼ごとに一意", async () => {
    await inWorkspace((db, ws) => {
      const { askId } = fxAsk(db, ws);
      const ins = (runNo: number, triggerType: string) =>
        run(db, "INSERT INTO ask_runs (id, ask_id, run_no, trigger_type) VALUES (?, ?, ?, ?)", newId(), askId, runNo, triggerType);
      ins(1, "initial");
      expectUnique(() => ins(1, "schedule"), "ask_runs.ask_id, ask_runs.run_no");
      ins(2, "schedule");
    });
  });
});

describe("T-14・T-21・T-22：Intent・承認。M-07・M-16・M-20", () => {
  function setup(db: WsDb, ws: FxWorkspace) {
    const agent = fxAgent(db);
    const conn = fxConnector(db);
    const { taskId } = fxTask(db, ws, agent);
    return { agent, conn, taskId };
  }

  it("T-14 executed_at も resolution もない executed の Intent は CHECK action_intents_executed_chk", async () => {
    await inWorkspace((db, ws) => {
      const { agent, conn, taskId } = setup(db, ws);
      const { intentId } = fxIntent(db, { taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "executing" });
      expectCheck(() => run(db, "UPDATE action_intents SET status = 'executed' WHERE id = ?", intentId), "action_intents_executed_chk");
      run(db, "UPDATE action_intents SET status = 'executed', resolution = 'confirmed_delivered' WHERE id = ?", intentId);
    });
  });

  it("T-22 expired なのに expire_reason がない → CHECK。superseded・policy_changed（M-20）は入る", async () => {
    await inWorkspace((db, ws) => {
      const { agent, conn, taskId } = setup(db, ws);
      const { intentId } = fxIntent(db, { taskId, jobId: agent.jobId, connectorId: conn.connectorId });
      expectCheck(() => run(db, "UPDATE action_intents SET status = 'expired' WHERE id = ?", intentId), "action_intents_expire_reason_chk");
      run(db, "UPDATE action_intents SET status = 'expired', expire_reason = 'superseded' WHERE id = ?", intentId);
      run(db, "UPDATE action_intents SET expire_reason = 'policy_changed' WHERE id = ?", intentId);
      expectCheck(
        () => run(db, "UPDATE action_intents SET status = 'pending_approval', expire_reason = NULL, expires_at = NULL WHERE id = ?", intentId),
        "action_intents_pending_expiry_chk",
      );
    });
  });

  it("M-07 tool_hash だけ 'sha256:' つき。destination_key・option_digest・intent_hash は接頭辞なしの64桁", async () => {
    await inWorkspace((db, ws) => {
      const { agent, conn, taskId } = setup(db, ws);
      const { intentId } = fxIntent(db, { taskId, jobId: agent.jobId, connectorId: conn.connectorId });
      expectCheck(() => run(db, "UPDATE action_intents SET destination_key = ? WHERE id = ?", `sha256:${fxHash("d")}`, intentId));
      expectCheck(() => run(db, "UPDATE action_intents SET option_digest = 'abc' WHERE id = ?", intentId));
      expectCheck(() => run(db, "UPDATE action_intents SET tool_hash = ? WHERE id = ?", fxHash("t"), intentId));
      expectCheck(() => run(db, "UPDATE action_intents SET intent_hash = ? WHERE id = ?", `sha256:${fxHash("i")}`, intentId));
    });
  });

  it("T-21 remember なのに created_rule_id がない承認は CHECK approvals_remember_chk。1つの Intent に承認は1つ", async () => {
    await inWorkspace((db, ws) => {
      const { agent, conn, taskId } = setup(db, ws);
      const { intentId } = fxIntent(db, { taskId, jobId: agent.jobId, connectorId: conn.connectorId });
      const { approvalId } = fxApproval(db, ws, { taskId, intentId, status: "approved" });
      expectCheck(() => run(db, "UPDATE approvals SET remember = 1 WHERE id = ?", approvalId), "approvals_remember_chk");
      run(db, "UPDATE approvals SET remember = 1, created_rule_id = 'r-7f3a' WHERE id = ?", approvalId);
      expectCheck(() => run(db, "UPDATE approvals SET status = 'rejected', decided_at = NULL WHERE id = ?", approvalId));
      expectUnique(() => fxApproval(db, ws, { taskId, intentId }), "approvals.intent_id");
    });
  });

  it("M-16 tool_call の判定にも intent_id を入れられる。intent の判定は intent_id が要る", async () => {
    await inWorkspace((db, ws) => {
      const { agent, conn, taskId } = setup(db, ws);
      const { intentId } = fxIntent(db, { taskId, jobId: agent.jobId, connectorId: conn.connectorId });
      const ins = (kind: string, intent: string | null) =>
        run(
          db,
          `INSERT INTO policy_decisions (id, task_id, intent_id, subject_kind, subject, counters, flags, decision, reason_code, inputs_hash, kernel_version, detail)
           VALUES (?, ?, ?, ?, '{}', '{}', '{}', 'approve', 'guard_exceeded', ?, '0.1.0', ?)`,
          newId(),
          taskId,
          intent,
          kind,
          fxHash("in"),
          { kind: "guard", argPath: "items[0].quantity" },
        );
      ins("tool_call", intentId);
      ins("llm_call", null);
      expectCheck(() => ins("intent", null), "policy_decisions_intent_kind_chk");
    });
  });
});

describe("コネクタ・ツール（MT §3.12.4）", () => {
  it("kind は mcp_remote だけ。needs_review は pending つきか、消えた印の NULL", async () => {
    await inWorkspace((db) => {
      expectCheck(
        () => run(db, "INSERT INTO connectors (id, slug, display_name, kind, url) VALUES (?, 'bank', 'bank', 'sim', 'https://x')", newId()),
        "connectors_kind_check",
      );
      const conn = fxConnector(db);
      const toolId = conn.tools.place_order!.id;
      run(db, "UPDATE connector_tools SET status = 'needs_review', pending = ? WHERE id = ?", {
        description: "新しい説明",
        inputSchema: {},
        annotations: null,
        detectedAt: "2026-10-12T09:00:00Z",
      }, toolId);
      run(db, "UPDATE connector_tools SET pending = NULL WHERE id = ?", toolId);
      expectCheck(() => run(db, "UPDATE connector_tools SET status = 'ok', pending = '{}' WHERE id = ?", toolId), "connector_tools_pending_chk");
    });
  });
});
