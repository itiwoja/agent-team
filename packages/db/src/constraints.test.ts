// DDL の制約の試験（db-schema.md §7.1 の T-01〜T-29 と、cross-check の結論 M-07・M-16・M-20・M-27〜M-29・M-32〜M-34・M-41・M-47）
import { describe, expect, it } from "vitest";
import { appendAuditLog } from "./audit.ts";
import { isCheckViolation, isForeignKeyViolation, isUniqueViolation, pgErrorInfo, type Db } from "./client.ts";
import {
  fxAgent,
  fxApproval,
  fxAsk,
  fxAskMember,
  fxConnector,
  fxHash,
  fxIntent,
  fxRehearsalCase,
  fxRehearsalRun,
  fxSimExecution,
  fxSimSnapshot,
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

  it("T-02 GUC なしで監査ログのあるゲストのワークスペースを消すと、カスケードの削除も止まる", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { audit: true });
    await expect(db.query("DELETE FROM workspaces WHERE id = $1", [ws.workspaceId])).rejects.toThrow(/append-only/);
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
    await fxWorkspace(db, { kind: "owner" });
    await expectUnique(fxWorkspace(db, { kind: "owner" }), "workspaces_single_owner_uq");
  });

  it("T-09 オーナーのワークスペースに削除予約は入れられない", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { kind: "owner" });
    await expectCheck(db.query("UPDATE workspaces SET delete_requested_at = now() WHERE id = $1", [ws.workspaceId]), "workspaces_owner_never_deleted_chk");
    await expectCheck(db.query("UPDATE workspaces SET seed_version = 'x' WHERE id = $1", [ws.workspaceId]), "workspaces_seed_only_guest_chk");
  });

  it("I-28 オーナーのワークスペースは DELETE できず、kind は変えられない", async () => {
    const { db } = T();
    const owner = await fxWorkspace(db, { kind: "owner" });
    await expect(db.query("DELETE FROM workspaces WHERE id = $1", [owner.workspaceId])).rejects.toThrow("owner workspace cannot be deleted");
    const guest = await fxWorkspace(db);
    await expect(db.query("UPDATE workspaces SET kind = 'owner' WHERE id = $1", [guest.workspaceId])).rejects.toThrow("workspaces.kind is immutable");
  });

  it("T-11 メンバーでないワークスペースのセッションは作れない（sessions_membership_fk）", async () => {
    const { db } = T();
    const a = await fxWorkspace(db);
    const b = await fxWorkspace(db);
    await expectFk(
      db.query(
        "INSERT INTO sessions (workspace_id, user_id, token_hash, csrf_token, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')",
        [b.workspaceId, a.userId, Buffer.alloc(32, 1), "x".repeat(43)],
      ),
      "sessions_membership_fk",
    );
  });
});

describe("タスク（T-04・T-20、M-32・M-41、BR-38）", () => {
  it("T-04 影は rehearsal_run_id ありのタスクだけ", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    await expectCheck(
      insertTask(db, ws, agent, { shadow: true }),
      "tasks_shadow_only_rehearsal_chk",
      "tasks_shadow_variant_chk",
      "tasks_execution_variant_chk",
    );
    await expectCheck(
      insertTask(db, ws, agent, { shadow: true, execution_variant: "shadow" }),
      "tasks_shadow_only_rehearsal_chk",
      "tasks_execution_variant_chk",
    );
  });

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

  it("M-41 リハーサルのタスクは governed / governed_approve / shadow、本番は NULL か live", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    const run = await fxRehearsalRun(db, ws, { jobId: agent.jobId });
    const c = await fxRehearsalCase(db, ws, { jobId: agent.jobId });
    const sc = await db.query<{ id: string }>(
      "INSERT INTO rehearsal_scenarios (workspace_id, rehearsal_run_id, case_id, ordinal, fault_ids, scenario, seed) VALUES ($1, $2, $3, 1, '{F-04}', '{}', 1) RETURNING id",
      [ws.workspaceId, run.runId, c.caseId],
    );
    const scenarioId = sc.rows[0]?.id;
    const reh = { trigger_type: "dry_run", is_dry_run: true, rehearsal_run_id: run.runId, rehearsal_scenario_id: scenarioId };
    await insertTask(db, ws, agent, { ...reh, execution_variant: "governed" });
    await insertTask(db, ws, agent, { ...reh, execution_variant: "governed_approve" });
    await insertTask(db, ws, agent, { ...reh, execution_variant: "shadow", shadow: true });
    await expectCheck(insertTask(db, ws, agent, { ...reh }), "tasks_execution_variant_chk");
    await expectCheck(insertTask(db, ws, agent, { ...reh, execution_variant: "live" }), "tasks_execution_variant_chk");
    await expectCheck(insertTask(db, ws, agent, { ...reh, execution_variant: "governed", shadow: true }), "tasks_shadow_variant_chk");
    await expectCheck(insertTask(db, ws, agent, { ...reh, execution_variant: "shadow" }), "tasks_shadow_variant_chk");
    await insertTask(db, ws, agent, { execution_variant: "live" });
    await expectCheck(insertTask(db, ws, agent, { execution_variant: "governed" }), "tasks_execution_variant_chk");
    // リハーサルのタスクは dry_run（rehearsal_run_id なら is_dry_run）
    await expectCheck(
      insertTask(db, ws, agent, { rehearsal_run_id: run.runId, rehearsal_scenario_id: scenarioId, execution_variant: "governed" }),
      "tasks_rehearsal_is_dry_run_chk",
    );
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

describe("T-05・T-07・T-16・T-23〜T-25・T-27・T-28：リハーサル", () => {
  it("T-05 sim_snapshot_id のない incident の試験は CHECK rehearsal_cases_incident_chk", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    await expectCheck(fxRehearsalCase(db, ws, { jobId: agent.jobId, source: "incident", simSnapshotId: null }), "rehearsal_cases_incident_chk");
  });

  it("T-07 fault_ids = {F-99} は CHECK。M-28：incident は空でよく、ほかは1つ以上", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    const ins = (source: string, faultIds: string[], extra: Record<string, unknown> = {}) =>
      db.query(
        `INSERT INTO rehearsal_cases (workspace_id, job_id, source, fault_ids, scenario, seed, user_text, sim_snapshot_id, reason_code, incident_kind)
         VALUES ($1, $2, $3, $4, '{}', 1, $5, $6, $7, $8)`,
        [
          ws.workspaceId,
          agent.jobId,
          source,
          faultIds,
          source === "user" ? "文" : null,
          extra.snap ?? null,
          extra.reason ?? null,
          extra.kind ?? null,
        ],
      );
    await expectCheck(ins("generated", ["F-99"]));
    await expectCheck(ins("generated", []), "rehearsal_cases_fault_ids_chk");
    const live = await fxSimExecution(db, ws);
    const { taskId } = await fxTask(db, ws, agent);
    const snap = await fxSimSnapshot(db, ws, { executionId: live.executionId, sourceTaskId: taskId });
    await ins("incident", [], { snap: snap.snapshotId, reason: "kill_switch", kind: "kill_switch" });
    // M-27：止まり方は user_reject（user_rejected は入らない）
    await ins("incident", ["F-03"], { snap: snap.snapshotId, reason: "user_reject", kind: "user_reject" });
    await expectCheck(ins("incident", ["F-03"], { snap: snap.snapshotId, reason: "user_reject", kind: "user_rejected" }));
  });

  it("M-29 外した理由に regenerated を使える。removed_at と removed_reason はそろえる", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    const { caseId } = await fxRehearsalCase(db, ws, { jobId: agent.jobId });
    await db.query("UPDATE rehearsal_cases SET removed_at = now(), removed_reason = 'regenerated' WHERE id = $1", [caseId]);
    await expectCheck(db.query("UPDATE rehearsal_cases SET removed_at = NULL WHERE id = $1", [caseId]), "rehearsal_cases_removed_chk");
  });

  it("T-16 試験が参照している sim のスナップショットは消せない（FK）", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    const live = await fxSimExecution(db, ws);
    const { taskId } = await fxTask(db, ws, agent);
    const snap = await fxSimSnapshot(db, ws, { executionId: live.executionId, sourceTaskId: taskId });
    await fxRehearsalCase(db, ws, { jobId: agent.jobId, source: "incident", simSnapshotId: snap.snapshotId, sourceTaskId: taskId });
    await expectFk(db.query("DELETE FROM sim.snapshots WHERE id = $1", [snap.snapshotId]), "rehearsal_cases_sim_snapshot_fk");
  });

  it("T-23 対象が job と ask の両方・どちらもない走行は CHECK rehearsal_runs_subject_chk", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    const { askId } = await fxAsk(db, ws);
    await expectCheck(fxRehearsalRun(db, ws, { jobId: agent.jobId, askId }), "rehearsal_runs_subject_chk");
    await expectCheck(fxRehearsalRun(db, ws, {}), "rehearsal_runs_subject_chk");
  });

  it("T-24 同じ依頼に動いている走行は1つ（rehearsal_runs_one_active_uq）。終わった走行は数えない", async () => {
    const { db } = T();
    const { ws } = await base(db);
    const { askId } = await fxAsk(db, ws);
    await fxRehearsalRun(db, ws, { askId, status: "running" });
    await expectUnique(fxRehearsalRun(db, ws, { askId, status: "queued" }), "rehearsal_runs_one_active_uq");
    await fxRehearsalRun(db, ws, { askId, status: "done" });
  });

  it("T-25 recertify なのに reason がない・retest なのに親がない", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    const ins = (trigger: string, reason: string | null, parent: string | null) =>
      db.query(
        "INSERT INTO rehearsal_runs (workspace_id, job_id, trigger, reason, parent_run_id, status, seed, model_id) VALUES ($1, $2, $3, $4, $5, 'done', 1, 'm')",
        [ws.workspaceId, agent.jobId, trigger, reason, parent],
      );
    await expectCheck(ins("recertify", null, null), "rehearsal_runs_reason_chk");
    await expectCheck(ins("manual", "widen", null), "rehearsal_runs_reason_chk");
    await expectCheck(ins("retest", null, null), "rehearsal_runs_retest_chk");
    await ins("recertify", "tool_hash", null);
  });

  it("T-27 防いだ損害は max(0, 影 − 本番)。影がなければ NULL（BR-79 の生成列）", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    const run = await fxRehearsalRun(db, ws, { jobId: agent.jobId });
    const c = await fxRehearsalCase(db, ws, { jobId: agent.jobId });
    const cases: Array<[number, number | null, number | null]> = [
      [0, 184_000, 184_000],
      [38_000, null, null],
      [5_000, 1_000, 0],
    ];
    let ordinal = 0;
    for (const [main, shadow, prevented] of cases) {
      ordinal += 1;
      const r = await db.query<{ prevented_damage_jpy: number | null }>(
        `INSERT INTO rehearsal_scenarios (workspace_id, rehearsal_run_id, case_id, ordinal, fault_ids, scenario, seed, damage_jpy, shadow_damage_jpy)
         VALUES ($1, $2, $3, $4, '{F-04}', '{}', 1, $5, $6) RETURNING prevented_damage_jpy`,
        [ws.workspaceId, run.runId, c.caseId, ordinal, main, shadow],
      );
      expect(r.rows[0]?.prevented_damage_jpy).toBe(prevented);
    }
  });

  it("T-28 並列の依頼の担当2人の仕事で、別々の走行を同時に動かせる（対象は仕事ごと）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const a = await fxAgent(db, ws, { name: "担当A" });
    const b = await fxAgent(db, ws, { name: "担当B" });
    await fxRehearsalRun(db, ws, { jobId: a.jobId, status: "running" });
    await fxRehearsalRun(db, ws, { jobId: b.jobId, status: "running" });
  });

  it("状況：done ⇔ verdict、止めたのが kernel ⇔ stopped_by_decision、abort_reason は cancelled / error だけ（M-46）", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    const run = await fxRehearsalRun(db, ws, { jobId: agent.jobId });
    const c = await fxRehearsalCase(db, ws, { jobId: agent.jobId });
    let ordinal = 0;
    const ins = (cols: Record<string, unknown>) => {
      ordinal += 1;
      const row = { status: "queued", verdict: null, stopped_by: null, stopped_by_decision: null, abort_reason: null, ...cols };
      return db.query(
        `INSERT INTO rehearsal_scenarios (workspace_id, rehearsal_run_id, case_id, ordinal, fault_ids, scenario, seed, status, verdict,
                                          stopped_by, stopped_by_decision, abort_reason)
         VALUES ($1, $2, $3, $4, '{F-04}', '{}', 1, $5, $6, $7, $8, $9)`,
        [ws.workspaceId, run.runId, c.caseId, ordinal, row.status, row.verdict, row.stopped_by, row.stopped_by_decision, row.abort_reason],
      );
    };
    await ins({ status: "done", verdict: "pass", stopped_by: "kernel", stopped_by_decision: "approve" });
    await ins({ status: "done", verdict: "fail", stopped_by: "none" });
    await ins({ status: "cancelled", abort_reason: "budget" });
    await expectCheck(ins({ status: "done" }), "rehearsal_scenarios_verdict_chk");
    await expectCheck(ins({ status: "running", verdict: "pass" }), "rehearsal_scenarios_verdict_chk");
    await expectCheck(ins({ status: "done", verdict: "pass", stopped_by: "kernel" }), "rehearsal_scenarios_stopped_by_chk");
    await expectCheck(ins({ status: "done", verdict: "pass", stopped_by: "agent", stopped_by_decision: "deny" }), "rehearsal_scenarios_stopped_by_chk");
    await expectCheck(ins({ status: "running", abort_reason: "timeout" }), "rehearsal_scenarios_abort_chk");
  });
});

describe("T-06：合格証", () => {
  it("同じ仕事に有効な合格証は1つ（rehearsal_certificates_active_uq）。監査ログの seq を指す（FK）", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    const run = await fxRehearsalRun(db, ws, { jobId: agent.jobId, status: "done" });
    const seq = await db.transaction(async (tx) => (await appendAuditLog(tx, ws.workspaceId, { eventType: "rehearsal.certificate_issued", actorType: "system", actorId: "app", payload: {} }, new Date("2026-10-12T09:00:00Z"))).seq);
    const ins = (auditSeq: number, revoked: boolean) =>
      db.query(
        `INSERT INTO rehearsal_certificates (workspace_id, job_id, rehearsal_run_id, policy_hash, tool_hashes, model_id, case_set_hash,
                                             case_count, summary, cost_usd, certificate_hash, audit_seq, revoked_at, revoke_reason)
         VALUES ($1, $2, $3, $4, $5, 'm', $6, 12, '{}', '0.120000', $7, $8, $9, $10)`,
        [
          ws.workspaceId,
          agent.jobId,
          run.runId,
          fxHash("p"),
          [{ action: "mcp.supplier.place_order", toolHash: fxToolHash("t") }],
          fxHash("c"),
          fxHash(`cert-${Math.random()}`),
          auditSeq,
          revoked ? new Date() : null,
          revoked ? "superseded" : null,
        ],
      );
    await ins(seq, false);
    await expectUnique(ins(seq, false), "rehearsal_certificates_active_uq");
    await ins(seq, true);
    await expectFk(ins(seq + 99, true), "rehearsal_certificates_audit_fk");
  });
});

describe("T-08・T-10・T-12・T-13・T-29：費用・スナップショット・依頼・エージェント・仕事", () => {
  it("T-08 持ち主（task・agent・ask・run）のない費用の行は CHECK usage_records_owner_chk。M-32：phase 'implement' は入る", async () => {
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
    const other = await fxWorkspace(db);
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

  it("T-26 締める提案（rehearsal_tighten）は narrow で走行つきだけ", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    const run = await fxRehearsalRun(db, ws, { jobId: agent.jobId, status: "done" });
    const ins = (classification: string, runId: string | null) =>
      db.query(
        `INSERT INTO agent_config_changes (workspace_id, agent_id, job_id, origin, rehearsal_run_id, patch, classification, widened_items)
         VALUES ($1, $2, $3, 'rehearsal_tighten', $4, '[]', $5, $6)`,
        [ws.workspaceId, agent.agentId, agent.jobId, runId, classification, classification === "widen" ? [] : null],
      );
    await expectCheck(ins("widen", run.runId), "agent_config_changes_tighten_chk");
    await expectCheck(ins("narrow", null), "agent_config_changes_tighten_chk");
    await ins("narrow", run.runId);
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

  it("ask_runs：trigger_type に initial。本番の回数は依頼ごとに一意、リハーサルの実行は走行と状況を持つ", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    const { askId } = await fxAsk(db, ws);
    const ins = (cols: Record<string, unknown>) => {
      const row = { run_no: 1, mode: "live", trigger_type: "initial", rehearsal_run_id: null, rehearsal_scenario_id: null, ...cols };
      return db.query(
        "INSERT INTO ask_runs (workspace_id, ask_id, run_no, mode, trigger_type, rehearsal_run_id, rehearsal_scenario_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [ws.workspaceId, askId, row.run_no, row.mode, row.trigger_type, row.rehearsal_run_id, row.rehearsal_scenario_id],
      );
    };
    await ins({});
    await expectUnique(ins({ trigger_type: "schedule" }), "ask_runs_live_no_uq");
    await ins({ run_no: 2, trigger_type: "schedule" });
    await expectCheck(ins({ run_no: 3, mode: "rehearsal" }), "ask_runs_mode_chk");
    const run = await fxRehearsalRun(db, ws, { askId });
    const c = await fxRehearsalCase(db, ws, { askId });
    const sc = await db.query<{ id: string }>(
      "INSERT INTO rehearsal_scenarios (workspace_id, rehearsal_run_id, case_id, ordinal, fault_ids, scenario, seed) VALUES ($1, $2, $3, 1, '{F-04}', '{}', 1) RETURNING id",
      [ws.workspaceId, run.runId, c.caseId],
    );
    // リハーサルの実行は本番の回数と別に数える（同じ run_no でもよい）
    await ins({ run_no: 1, mode: "rehearsal", rehearsal_run_id: run.runId, rehearsal_scenario_id: sc.rows[0]?.id });
    await expectCheck(ins({ run_no: 1, mode: "rehearsal", rehearsal_run_id: run.runId }), "ask_runs_scenario_chk");
    void agent;
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

describe("コネクタ・ツール（BR-66、MT §3.12.4）", () => {
  it("sim のコネクタに認証情報は置けない。needs_review は pending つきか、消えた印の NULL", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    await expectCheck(
      db.query("INSERT INTO connectors (workspace_id, slug, display_name, kind, url, auth) VALUES ($1, 'bank', 'bank', 'sim', 'https://x', $2)", [
        ws.workspaceId,
        { type: "api_key", ciphertext: "x" },
      ]),
      "connectors_sim_no_secret_chk",
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

describe("sim スキーマ（M-40）", () => {
  it("デモ店舗は (ワークスペース, 世界) に1つ。live ⇔ rehearsal_run_id なし", async () => {
    const { db } = T();
    const { ws, agent } = await base(db);
    await fxSimExecution(db, ws);
    await expectUnique(fxSimExecution(db, ws), "sim_executions_demo_store_uq");
    const run = await fxRehearsalRun(db, ws, { jobId: agent.jobId });
    await fxSimExecution(db, ws, { rehearsalRunId: run.runId, variant: "governed" });
    await fxSimExecution(db, ws, { rehearsalRunId: run.runId, variant: "shadow" });
    await expectCheck(fxSimExecution(db, ws, { rehearsalRunId: run.runId, variant: "live" }), "sim_executions_live_chk");
    await expectCheck(fxSimExecution(db, ws, { world: "brief", variant: "governed" }), "sim_executions_live_chk");
  });

  it("事象は追記だけ。event の seq・kind は列とそろえる", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const { executionId } = await fxSimExecution(db, ws);
    const ins = (seq: number, event: unknown) =>
      db.query("INSERT INTO sim.events (execution_id, seq, workspace_id, event) VALUES ($1, $2, $3, $4)", [executionId, seq, ws.workspaceId, event]);
    await ins(1, { seq: 1, at: "2026-10-12T18:00:00+09:00", kind: "tool_call", tool: "supplier.place_order", intentId: null, caller: "sa-gateway" });
    await ins(2, { seq: 2, at: "2026-10-13T07:00:00+09:00", kind: "delivery", caller: "clock" });
    await expectCheck(ins(3, { seq: 4, kind: "clock", caller: "clock" }));
    await expectCheck(ins(3, { seq: 3, kind: "nope", caller: "clock" }));
    await expectUnique(ins(2, { seq: 2, kind: "clock", caller: "clock" }), "sim_events_pk");
    await expect(db.query("UPDATE sim.events SET event = event WHERE execution_id = $1", [executionId])).rejects.toThrow("events is immutable");
    const r = await db.query<{ kind: string; intent_id: string | null; event: unknown }>(
      "SELECT kind, intent_id, event FROM sim.events WHERE execution_id = $1 ORDER BY seq",
      [executionId],
    );
    expect(r.rows[0]).toEqual({
      kind: "tool_call",
      intent_id: null,
      event: { seq: 1, at: "2026-10-12T18:00:00+09:00", kind: "tool_call", tool: "supplier.place_order", intentId: null, caller: "sa-gateway" },
    });
    expect(r.rows[1]?.event).toEqual({ seq: 2, at: "2026-10-13T07:00:00+09:00", kind: "delivery", caller: "clock" });
  });
});
