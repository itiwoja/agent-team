// DDL の制約の試験（db-schema.md §7.1 の T-01〜T-29 と、cross-check の結論 M-07・M-16・M-20・M-27〜M-29・M-32〜M-34・M-41・M-47）
import { describe, expect, it } from "vitest";
import { isCheckViolation, isForeignKeyViolation, isUniqueViolation, pgErrorInfo, type Db } from "./client.ts";
import {
  fxAgent,
  fxApproval,
  fxAsk,
  fxAskMember,
  fxConnector,
  fxHash,
  fxIntent,
  fxTask,
  fxToolHash,
  fxWorkspace,
  useTestDb,
  type FxWorkspace,
} from "./testing.ts";

const T = useTestDb();

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}
/** CHECK の違反（names のどれか） */
async function expectCheck(p: Promise<unknown>, ...names: string[]): Promise<void> {
  const e = await caught(p);
  expect(e, `CHECK ${names.join(" / ")} で止まるはず`).not.toBeNull();
  expect(isCheckViolation(e), String((e as Error).message)).toBe(true);
  if (names.length > 0) expect(names).toContain(pgErrorInfo(e)?.constraint);
}
async function expectUnique(p: Promise<unknown>, name: string): Promise<void> {
  const e = await caught(p);
  expect(isUniqueViolation(e, name), String((e as Error | null)?.message)).toBe(true);
}
async function expectFk(p: Promise<unknown>, name: string): Promise<void> {
  const e = await caught(p);
  expect(isForeignKeyViolation(e, name), String((e as Error | null)?.message)).toBe(true);
}

async function base(db: Db): Promise<{ ws: FxWorkspace; agent: Awaited<ReturnType<typeof fxAgent>> }> {
  const ws = await fxWorkspace(db);
  const agent = await fxAgent(db, ws);
  return { ws, agent };
}

/** tasks に1行入れる（列を上書きして CHECK を試す） */
async function insertTask(db: Db, ws: FxWorkspace, agent: Awaited<ReturnType<typeof fxAgent>>, cols: Record<string, unknown>): Promise<void> {
  const row: Record<string, unknown> = {
    workspace_id: ws.workspaceId,
    requester_id: ws.userId,
    agent_id: agent.agentId,
    agent_snapshot_id: agent.snapshotId,
    job_id: agent.jobId,
    trigger_type: "manual",
    status: "running",
    ...cols,
  };
  const keys = Object.keys(row);
  await db.query(`INSERT INTO tasks (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
}

describe("T-01・T-02・T-15：監査ログの守り", () => {
  it("T-01 監査ログの UPDATE は拒む（audit_logs is append-only）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { audit: true });
    await expect(db.query("UPDATE audit_logs SET event_type = 'x' WHERE workspace_id = $1", [ws.workspaceId])).rejects.toThrow(
      "audit_logs is append-only",
    );
    await expect(db.query("TRUNCATE audit_logs CASCADE")).rejects.toThrow("audit_logs is append-only");
  });

  it("T-02 GUC なしで監査ログのあるワークスペースを消すと、オーナーの守りを外してもカスケードの削除で止まる", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { audit: true });
    await expect(
      db.transaction(async (tx) => {
        await tx.query("ALTER TABLE workspaces DISABLE TRIGGER workspaces_guard");
        await tx.query("DELETE FROM workspaces WHERE id = $1", [ws.workspaceId]);
      }),
    ).rejects.toThrow(/append-only/);
    const n = await db.query<{ n: number }>("SELECT count(*) AS n FROM workspaces WHERE id = $1", [ws.workspaceId]);
    expect(n.rows[0]?.n).toBe(1);
  });

  it("T-15 occurred_at にマイクロ秒があると CHECK audit_logs_ms_chk", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    await expectCheck(
      db.query(
        `INSERT INTO audit_logs (workspace_id, seq, occurred_at, event_type, actor_type, payload, prev_hash, hash)
         VALUES ($1, 1, '2026-10-12T09:00:00.123456Z', 'x.y', 'system', '{}', $2, $2)`,
        [ws.workspaceId, Buffer.alloc(32)],
      ),
      "audit_logs_ms_chk",
    );
  });
});

describe("ワークスペース・セッション（T-03・T-09・T-11、SO I-28）", () => {
  it("T-03 オーナーのワークスペースは1つだけ（workspaces_single_owner_uq）", async () => {
    const { db } = T();
    await fxWorkspace(db);
    await expectUnique(db.query("INSERT INTO workspaces (kind) VALUES ('owner')"), "workspaces_single_owner_uq");
    await expectCheck(db.query("INSERT INTO workspaces (kind) VALUES ('guest')"), "workspaces_kind_check");
  });

  it("T-09 ワークスペースに削除予約・シードの版は入れられない（ゲストのためだけだった列）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    await expectCheck(db.query("UPDATE workspaces SET delete_requested_at = now() WHERE id = $1", [ws.workspaceId]), "workspaces_no_delete_request_chk");
    await expectCheck(db.query("UPDATE workspaces SET seed_version = 'x' WHERE id = $1", [ws.workspaceId]), "workspaces_no_seed_version_chk");
  });

  it("I-28 オーナーのワークスペースは DELETE できず、kind は変えられない", async () => {
    const { db } = T();
    const owner = await fxWorkspace(db);
    await expect(db.query("DELETE FROM workspaces WHERE id = $1", [owner.workspaceId])).rejects.toThrow("owner workspace cannot be deleted");
    await expect(db.query("UPDATE workspaces SET kind = 'guest' WHERE id = $1", [owner.workspaceId])).rejects.toThrow("workspaces.kind is immutable");
  });

  it("T-11 メンバーでないワークスペースのセッションは作れない（sessions_membership_fk）", async () => {
    const { db } = T();
    const a = await fxWorkspace(db);
    const b = await fxWorkspace(db, { second: true });
    await expectFk(
      db.query(
        "INSERT INTO sessions (workspace_id, user_id, token_hash, csrf_token, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')",
        [b.workspaceId, a.userId, Buffer.alloc(32, 1), "x".repeat(43)],
      ),
      "sessions_membership_fk",
    );
  });
});

describe("タスク（T-20、M-32、BR-38）", () => {

  it("T-20 halted なのに halt_reason がない・failed なのに fail_reason がない・終わったのに finished_at がない", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    await expectCheck(insertTask(db, ws, agent, { status: "halted", finished_at: new Date() }), "tasks_halt_reason_chk");
    await expectCheck(insertTask(db, ws, agent, { status: "failed", finished_at: new Date() }), "tasks_fail_reason_chk");
    await expectCheck(insertTask(db, ws, agent, { status: "completed" }), "tasks_finished_chk");
    await expectCheck(insertTask(db, ws, agent, { status: "running", halt_reason: "timeout" }), "tasks_halt_reason_chk");
  });

  it("M-32 trigger_type 'ask' と fail_reason 'sandbox_lost' は入り、'runner_lost' は入らない", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    await insertTask(db, ws, agent, { trigger_type: "ask" });
    await insertTask(db, ws, agent, { status: "failed", fail_reason: "sandbox_lost", finished_at: new Date() });
    await expectCheck(insertTask(db, ws, agent, { status: "failed", fail_reason: "runner_lost", finished_at: new Date() }));
    await expectCheck(insertTask(db, ws, agent, { trigger_type: "dry_run" }), "tasks_dry_run_trigger_chk");
  });


  it("BR-38 一度汚染したタスクは汚染なしに戻せない", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    const { taskId } = await fxTask(db, ws, agent, { tainted: true });
    await expect(db.query("UPDATE tasks SET tainted = false, taint_sources = '[]' WHERE id = $1", [taskId])).rejects.toThrow(
      "tasks.tainted cannot go back to false",
    );
    await expectCheck(insertTask(db, ws, agent, { tainted: false, taint_sources: [{ kind: "web_search", at: "x" }] }), "tasks_taint_chk");
  });

  it("報告の出典（M-31）は報告と一緒にだけ入る", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    await insertTask(db, ws, agent, { report: "本文", report_kind: "answer", report_sources: [{ kind: "agent", agentName: "受信箱係" }] });
    await expectCheck(insertTask(db, ws, agent, { report_sources: [] }), "tasks_report_sources_chk");
    await expectCheck(insertTask(db, ws, agent, { report: "本文" }), "tasks_report_kind_chk");
  });
});

describe("T-08・T-10・T-12・T-13・T-29：費用・スナップショット・依頼・エージェント・仕事", () => {
  it("T-08 持ち主（task・agent・ask）のない費用の行は CHECK usage_records_owner_chk。M-32：phase 'implement' は入る", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    const ins = (agentId: string | null, phase: string) =>
      db.query(
        `INSERT INTO usage_records (workspace_id, agent_id, provider, model, phase, input_tokens, output_tokens, estimated_cost_usd, cost_usd, latency_ms, prompt_hash)
         VALUES ($1, $2, 'google', 'g', $3, 1, 1, 0, 0, 1, 'h')`,
        [ws.workspaceId, agentId, phase],
      );
    await expectCheck(ins(null, "plan"), "usage_records_owner_chk");
    await ins(agent.agentId, "implement");
    await ins(agent.agentId, "rehearsal_tighten");
    await expectCheck(ins(agent.agentId, "design"));
  });

  it("T-10 スナップショットとワークスペースのポリシーは UPDATE できない", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    await expect(db.query("UPDATE agent_snapshots SET warnings = '[1]' WHERE id = $1", [agent.snapshotId])).rejects.toThrow(
      "agent_snapshots is immutable",
    );
    await db.query("INSERT INTO workspace_policies (workspace_id, version, policy, policy_hash) VALUES ($1, 1, '{}', $2)", [
      ws.workspaceId,
      fxHash("wp"),
    ]);
    await expect(db.query("UPDATE workspace_policies SET version = 2 WHERE workspace_id = $1", [ws.workspaceId])).rejects.toThrow(
      "workspace_policies is immutable",
    );
  });

  it("T-12 同じ依頼に窓口を2つ置けない（ask_members_spokesperson_uq）。M-34：depends_on は段の番号", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const a = await fxAgent(db, ws, { name: "受信箱係" });
    const b = await fxAgent(db, ws, { name: "仕入れ係" });
    const { askId } = await fxAsk(db, ws);
    await fxAskMember(db, ws, { askId, agent: a, position: 1, isSpokesperson: true });
    await expectUnique(fxAskMember(db, ws, { askId, agent: b, position: 2, isSpokesperson: true }), "ask_members_spokesperson_uq");
    const { memberId } = await fxAskMember(db, ws, { askId, agent: b, position: 2 });
    await db.query("UPDATE ask_members SET depends_on = '{1}' WHERE id = $1", [memberId]);
    await expectCheck(db.query("UPDATE ask_members SET depends_on = '{7}' WHERE id = $1", [memberId]));
  });

  it("T-13 同じワークスペースに同じ名前のエージェントは作れない（removed は除く）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const a = await fxAgent(db, ws, { name: "仕入れ係" });
    await expectUnique(fxAgent(db, ws, { name: "仕入れ係" }), "agents_ws_name_uq");
    await db.query("UPDATE agents SET status = 'removed' WHERE id = $1", [a.agentId]);
    await fxAgent(db, ws, { name: "仕入れ係" });
    // 別のワークスペースなら同じ名前でよい
    const other = await fxWorkspace(db, { second: true });
    await fxAgent(db, other, { name: "仕入れ係" });
  });

  it("T-29 同じエージェントに同じ slug の仕事を2つ作れない（agent_jobs_agent_slug_uq）", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    await expectUnique(
      db.query("INSERT INTO agent_jobs (workspace_id, agent_id, slug, kind, template) VALUES ($1, $2, $3, 'once', 'researcher')", [
        ws.workspaceId,
        agent.agentId,
        agent.jobSlug,
      ]),
      "agent_jobs_agent_slug_uq",
    );
  });

});

describe("T-17〜T-19：依頼。M-33・M-47：実行", () => {
  it("T-17 生成中（shape NULL）の依頼は入る。T-18・T-19 は CHECK", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    await fxAsk(db, ws, { status: "generating" });
    const ins = (status: string, shape: string | null, reason: string | null) =>
      db.query("INSERT INTO asks (workspace_id, created_by, text, status, shape, failure_reason) VALUES ($1, $2, 't', $3, $4, $5)", [
        ws.workspaceId,
        ws.userId,
        status,
        shape,
        reason,
      ]);
    await expectCheck(ins("failed", null, null), "asks_generation_failed_chk");
    await expectCheck(ins("running", null, null), "asks_shape_after_generating_chk");
    await expectCheck(ins("running", "chain", "timeout"), "asks_failure_reason_chk");
    await ins("failed", null, "planner_error");
    await expectCheck(
      db.query("INSERT INTO asks (workspace_id, created_by, text, next_run_at) VALUES ($1, $2, 't', now())", [ws.workspaceId, ws.userId]),
      "asks_next_run_needs_trigger_chk",
    );
  });

  it("ask_runs：trigger_type に initial。回数は依頼ごとに一意", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const { askId } = await fxAsk(db, ws);
    const ins = (cols: Record<string, unknown>) => {
      const row = { run_no: 1, trigger_type: "initial", ...cols };
      return db.query("INSERT INTO ask_runs (workspace_id, ask_id, run_no, trigger_type) VALUES ($1, $2, $3, $4)", [
        ws.workspaceId,
        askId,
        row.run_no,
        row.trigger_type,
      ]);
    };
    await ins({});
    await expectUnique(ins({ trigger_type: "schedule" }), "ask_runs_no_uq");
    await ins({ run_no: 2, trigger_type: "schedule" });
  });
});

describe("T-14・T-21・T-22：Intent・承認。M-07・M-16・M-20", () => {
  async function setup(db: Db) {
    const { ws, agent } = await base(db);
    const conn = await fxConnector(db, ws);
    const { taskId } = await fxTask(db, ws, agent);
    return { ws, agent, conn, taskId };
  }

  it("T-14 executed_at も resolution もない executed の Intent は CHECK action_intents_executed_chk", async () => {
    const { db } = T();
    const { ws, agent, conn, taskId } = await setup(db);
    const { intentId } = await fxIntent(db, ws, { taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "executing" });
    await expectCheck(db.query("UPDATE action_intents SET status = 'executed' WHERE id = $1", [intentId]), "action_intents_executed_chk");
    await db.query("UPDATE action_intents SET status = 'executed', resolution = 'confirmed_delivered' WHERE id = $1", [intentId]);
  });

  it("T-22 expired なのに expire_reason がない → CHECK。superseded・policy_changed（M-20）は入る", async () => {
    const { db } = T();
    const { ws, agent, conn, taskId } = await setup(db);
    const { intentId } = await fxIntent(db, ws, { taskId, jobId: agent.jobId, connectorId: conn.connectorId });
    await expectCheck(db.query("UPDATE action_intents SET status = 'expired' WHERE id = $1", [intentId]), "action_intents_expire_reason_chk");
    await db.query("UPDATE action_intents SET status = 'expired', expire_reason = 'superseded' WHERE id = $1", [intentId]);
    await db.query("UPDATE action_intents SET expire_reason = 'policy_changed' WHERE id = $1", [intentId]);
    await expectCheck(db.query("UPDATE action_intents SET status = 'pending_approval', expire_reason = NULL, expires_at = NULL WHERE id = $1", [intentId]), "action_intents_pending_expiry_chk");
  });

  it("M-07 tool_hash だけ 'sha256:' つき。destination_key・option_digest・intent_hash は接頭辞なしの64桁", async () => {
    const { db } = T();
    const { ws, agent, conn, taskId } = await setup(db);
    const { intentId } = await fxIntent(db, ws, { taskId, jobId: agent.jobId, connectorId: conn.connectorId });
    await expectCheck(db.query("UPDATE action_intents SET destination_key = $2 WHERE id = $1", [intentId, `sha256:${fxHash("d")}`]));
    await expectCheck(db.query("UPDATE action_intents SET option_digest = 'abc' WHERE id = $1", [intentId]));
    await expectCheck(db.query("UPDATE action_intents SET tool_hash = $2 WHERE id = $1", [intentId, fxHash("t")]));
    await expectCheck(db.query("UPDATE action_intents SET intent_hash = $2 WHERE id = $1", [intentId, `sha256:${fxHash("i")}`]));
  });

  it("T-21 remember なのに created_rule_id がない承認は CHECK approvals_remember_chk", async () => {
    const { db } = T();
    const { ws, agent, conn, taskId } = await setup(db);
    const { intentId } = await fxIntent(db, ws, { taskId, jobId: agent.jobId, connectorId: conn.connectorId });
    const { approvalId } = await fxApproval(db, ws, { taskId, intentId, status: "approved" });
    await expectCheck(db.query("UPDATE approvals SET remember = true WHERE id = $1", [approvalId]), "approvals_remember_chk");
    await db.query("UPDATE approvals SET remember = true, created_rule_id = 'r-7f3a' WHERE id = $1", [approvalId]);
    await expectCheck(db.query("UPDATE approvals SET status = 'rejected', decided_at = NULL WHERE id = $1", [approvalId]));
    await expectUnique(fxApproval(db, ws, { taskId, intentId }), "approvals_intent_uq");
  });

  it("M-16 tool_call の判定にも intent_id を入れられる。intent の判定は intent_id が要る", async () => {
    const { db } = T();
    const { ws, agent, conn, taskId } = await setup(db);
    const { intentId } = await fxIntent(db, ws, { taskId, jobId: agent.jobId, connectorId: conn.connectorId });
    const ins = (kind: string, intent: string | null) =>
      db.query(
        `INSERT INTO policy_decisions (workspace_id, task_id, intent_id, subject_kind, subject, counters, flags, decision, reason_code, inputs_hash, kernel_version, detail)
         VALUES ($1, $2, $3, $4, '{}', '{}', '{}', 'approve', 'guard_exceeded', $5, '0.1.0', $6)`,
        [ws.workspaceId, taskId, intent, kind, fxHash("in"), { kind: "guard", argPath: "items[0].quantity" }],
      );
    await ins("tool_call", intentId);
    await ins("llm_call", null);
    await expectCheck(ins("intent", null), "policy_decisions_intent_kind_chk");
  });
});

describe("コネクタ・ツール（MT §3.12.4）", () => {
  it("kind は mcp_remote だけ（0023 で sim をやめた）。needs_review は pending つきか、消えた印の NULL", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    await expectCheck(
      db.query("INSERT INTO connectors (workspace_id, slug, display_name, kind, url) VALUES ($1, 'bank', 'bank', 'sim', 'https://x')", [ws.workspaceId]),
      "connectors_kind_check",
    );
    const conn = await fxConnector(db, ws);
    const toolId = conn.tools.place_order?.id;
    await db.query("UPDATE connector_tools SET status = 'needs_review', pending = $2 WHERE id = $1", [
      toolId,
      { description: "新しい説明", inputSchema: {}, annotations: null, detectedAt: "2026-10-12T09:00:00Z" },
    ]);
    await db.query("UPDATE connector_tools SET pending = NULL WHERE id = $1", [toolId]);
    await expectCheck(db.query("UPDATE connector_tools SET status = 'ok', pending = '{}' WHERE id = $1", [toolId]), "connector_tools_pending_chk");
  });
});

