// 連絡板（FR-064・BR-73〜77）の試験：team_post の検査と保存・team_wait で返事を受け取る・受け手の汚染・始める前に届いた連絡・追いのターン
// 「仕入れ係 → 受信箱係：20kg は確定？」の1往復（D-73）を、順番の2段（受信箱係 → 仕入れ係）で通す
import { describe, expect, it } from "vitest";
import { wrapUntrusted } from "@open-team/kernel";
import type { Db, Uuid } from "@open-team/db";
import { insertFollowupTask } from "@open-team/db/asks";
import { insertAskMessage } from "@open-team/db/edge";
import { useTestDb, type FxWorkspace } from "@open-team/db/testing";
import type { ScriptedStep } from "@open-team/llm";
import type { TaskContext } from "@open-team/runner";
import type { WsCtx } from "@open-team/db";
import { buildEdge, call, llmRequest, USAGE, type TestEdge } from "./__fixtures__/env.ts";
import {
  T0,
  fxWorkspace,
  inboxDefinition,
  seedAgent,
  seedChainAsk,
  seedShopConnectors,
  seedTask,
  supplierDefinition,
  tokenFor,
  type SeededAsk,
} from "./__fixtures__/shop.ts";
import { TEAM_NO_REPLY_TEXT, TEAM_POSTED_TEXT, TEAM_RECIPIENT_STOPPED_TEXT } from "./team.ts";

const T = useTestDb();

const QUESTION = "山田珈琲の20kgは確定？";

interface Posted {
  askId: Uuid;
  messageId: Uuid;
  kind: string;
  fromTaskId: Uuid;
  toMemberId: Uuid | null;
}

/** 受信箱係（1段目・済み）→ 仕入れ係（2段目・窓口）。受信箱係のタスクは報告つきで終わっている */
async function setup(db: Db, o: { inboxDone?: boolean } = {}) {
  const ws = await fxWorkspace(db, { kind: "guest", audit: true });
  await seedShopConnectors(db, ws);
  const inbox = await seedAgent(db, ws, inboxDefinition());
  const supplier = await seedAgent(db, ws, supplierDefinition());
  const ask = await seedChainAsk(db, ws, [
    { agent: inbox, jobSlug: "read-supplier-mail", position: 1, spokesperson: false },
    { agent: supplier, jobSlug: "reorder", position: 2, spokesperson: true },
  ]);
  const inboxTask = await seedTask(db, ws, inbox, "read-supplier-mail", { ask, memberName: "受信箱係" });
  if (o.inboxDone !== false) await finishTask(db, inboxTask, "succeeded");
  const supplierTask = await seedTask(db, ws, supplier, "reorder", { ask, memberName: "仕入れ係", inputTaskIds: [inboxTask] });
  return { ws, ask, inboxTask, supplierTask, ctx: ws.ctx as WsCtx };
}

async function finishTask(db: Db, taskId: Uuid, status: "succeeded" | "failed"): Promise<void> {
  await db.query(
    `UPDATE tasks SET status = $2, finished_at = $3, started_at = $3, fail_reason = $4,
                      report = 'A社から20kgの発注の連絡', report_title = 'メールの要約', report_kind = 'normal'
      WHERE id = $1`,
    [taskId, status, T0, status === "failed" ? "agent_unable" : null],
  );
}

function started(db: Db, o: { script: readonly ScriptedStep[] }): TestEdge & { posted: Posted[] } {
  const posted: Posted[] = [];
  const hooks: TestEdge["hooks"] = [];
  const env = buildEdge(db, {
    script: o.script,
    extra: {
      hooks: {
        onTeamMessagePosted: (_ctx, e) => void posted.push(e),
        onTaskTerminal: (_ctx, e) => void hooks.push({ hook: "onTaskTerminal", taskId: e.taskId, status: e.status }),
      },
    },
  });
  return Object.assign(env, { posted, hooks });
}

const post = (id: string, args: Record<string, unknown>) => ({ parts: [call(id, "team_post", args)], usage: USAGE });

/** 受信箱係の返事を、受信箱係のタスクから直接記録する（edge の外で作った連絡：本番では追いのターンが送る） */
async function insertReply(db: Db, ws: FxWorkspace, ask: SeededAsk, questionId: Uuid, fromTask: Uuid, o: { tainted: boolean; body?: string }): Promise<Uuid> {
  const m = await db.transaction((tx) =>
    insertAskMessage(tx, ws.ctx as WsCtx, {
      askId: ask.askId,
      askRunId: ask.askRunId,
      fromMember: ask.members["受信箱係"]!,
      toMember: ask.members["仕入れ係"]!,
      kind: "reply",
      body: o.body ?? "確定とは書かれていない",
      inReplyTo: questionId,
      tainted: o.tainted,
      fromTaskId: fromTask,
      now: T0,
    }),
  );
  return m.id;
}

describe("team_post（FR-064）", () => {
  it("2体の編成の担当には team_post・team_wait が入る（ひとりの編成では入らない：context.test）", async () => {
    const { db } = T();
    const w = await setup(db);
    const env = started(db, { script: [] });
    const ctx = await env.edge.getTaskContext(await tokenFor(db, w.ws, w.supplierTask));
    expect(ctx.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["team_post", "team_wait"]));
  });

  it("仕入れ係 → 受信箱係の question：検査を通って保存され（本文はマスク済み）、監査ログ ask.message.posted（本文なし）と onTeamMessagePosted が出る", async () => {
    const { db } = T();
    const w = await setup(db);
    const env = started(db, { script: [post("q1", { to: "受信箱係", kind: "question", body: QUESTION })] });
    const token = await tokenFor(db, w.ws, w.supplierTask);
    const ctx = await env.edge.getTaskContext(token);
    const res = await env.edge.llmMessages(token, llmRequest(ctx.tools));
    expect(res.governance.map((g) => `${g.toolCallId}:${g.decision}`)).toEqual(["q1:allow"]);
    const out = await env.edge.callTool(token, "q1");
    expect(out).toMatchObject({ kind: "text" });
    expect((out as { text: string }).text).toContain(TEAM_POSTED_TEXT);

    const rows = (await db.query<{ id: Uuid; kind: string; body: string; tainted: boolean; from_task_id: Uuid; to_member: Uuid }>("SELECT * FROM ask_messages WHERE ask_id = $1", [w.ask.askId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "question", body: QUESTION, tainted: false, from_task_id: w.supplierTask, to_member: w.ask.members["受信箱係"] });
    expect((out as { text: string }).text).toContain(rows[0]!.id);
    expect(env.posted).toEqual([{ askId: w.ask.askId, messageId: rows[0]!.id, kind: "question", fromTaskId: w.supplierTask, toMemberId: w.ask.members["受信箱係"] }]);

    const audit = (await db.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit_logs WHERE workspace_id = $1 AND event_type = 'ask.message.posted'", [w.ws.workspaceId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toMatchObject({ messageId: rows[0]!.id, kind: "question", tainted: false });
    expect(JSON.stringify(audit[0]!.payload)).not.toContain(QUESTION);
  });

  it("送り手が汚染されていれば tainted を付けて保存する（BR-75）", async () => {
    const { db } = T();
    const w = await setup(db);
    await db.query(`UPDATE tasks SET tainted = true, taint_sources = '[{"kind":"web_search","at":"2026-10-12T09:00:00.000Z"}]'::jsonb WHERE id = $1`, [w.supplierTask]);
    const env = started(db, { script: [post("q1", { to: "受信箱係", kind: "question", body: QUESTION })] });
    const token = await tokenFor(db, w.ws, w.supplierTask);
    const ctx = await env.edge.getTaskContext(token);
    await env.edge.llmMessages(token, llmRequest(ctx.tools));
    await env.edge.callTool(token, "q1");
    const row = (await db.query<{ tainted: boolean }>("SELECT tainted FROM ask_messages WHERE ask_id = $1", [w.ask.askId])).rows[0]!;
    expect(row.tainted).toBe(true);
  });

  it("断る：順番で前の段から後の段へ戻れない share・宛先がいない・空の本文は、理由つきのツールエラーで、保存せず ask.message.rejected だけ残す", async () => {
    const { db } = T();
    const w = await setup(db);
    const env = started(db, {
      script: [
        {
          parts: [
            call("a", "team_post", { to: "受信箱係", kind: "share", body: "先に調べました" }),
            call("b", "team_post", { to: "経理係", kind: "question", body: "どう？" }),
            call("c", "team_post", { to: "受信箱係", kind: "question", body: "   " }),
          ],
          usage: USAGE,
        },
      ],
    });
    const token = await tokenFor(db, w.ws, w.supplierTask);
    const ctx = await env.edge.getTaskContext(token);
    await env.edge.llmMessages(token, llmRequest(ctx.tools));
    const texts = [];
    for (const id of ["a", "b", "c"]) texts.push(((await env.edge.callTool(token, id)) as { text: string }).text);
    expect(texts[0]).toContain("TEAM_KIND_NOT_ALLOWED_FOR_SHAPE");
    expect(texts[1]).toContain("TEAM_RECIPIENT_NOT_IN_ASK");
    expect(texts[2]).toContain("TEAM_BODY_EMPTY");
    expect((await db.query("SELECT 1 FROM ask_messages WHERE ask_id = $1", [w.ask.askId])).rows).toHaveLength(0);
    const audit = (await db.query<{ payload: { reason: string } }>("SELECT payload FROM audit_logs WHERE workspace_id = $1 AND event_type = 'ask.message.rejected' ORDER BY seq", [w.ws.workspaceId])).rows;
    expect(audit.map((r) => r.payload.reason)).toEqual(["kind_not_allowed_for_shape", "recipient_not_in_ask", "body_empty"]);
    expect(env.posted).toEqual([]);
  });

  it("連絡板が閉じている（Kill Switch 中の依頼）と board_closed で断る", async () => {
    const { db } = T();
    const w = await setup(db);
    const env = started(db, { script: [post("q1", { to: "受信箱係", kind: "question", body: QUESTION })] });
    const token = await tokenFor(db, w.ws, w.supplierTask);
    const ctx = await env.edge.getTaskContext(token);
    await env.edge.llmMessages(token, llmRequest(ctx.tools));
    await db.query("UPDATE asks SET status = 'cancelled' WHERE id = $1", [w.ask.askId]);
    const out = (await env.edge.callTool(token, "q1")) as { text: string };
    expect(out.text).toContain("TEAM_BOARD_CLOSED");
  });
});

describe("team_wait と受け取り（BR-75）", () => {
  async function asked(db: Db) {
    const w = await setup(db);
    const env = started(db, { script: [post("q1", { to: "受信箱係", kind: "question", body: QUESTION })] });
    const token = await tokenFor(db, w.ws, w.supplierTask);
    const ctx = await env.edge.getTaskContext(token);
    await env.edge.llmMessages(token, llmRequest(ctx.tools));
    await env.edge.callTool(token, "q1");
    const q = (await db.query<{ id: Uuid }>("SELECT id FROM ask_messages WHERE ask_id = $1", [w.ask.askId])).rows[0]!.id;
    // team_wait の引数は判定のときの記録を使うので、本物の message_id で呼び直す
    const script = [{ parts: [call("w2", "team_wait", { message_id: q, timeout: 1 })], usage: USAGE }];
    const env2 = started(db, { script });
    await env2.edge.llmMessages(token, llmRequest(ctx.tools));
    return { w, env: env2, token, q };
  }

  it("返事が来ていれば、区切り・送った担当の名前・汚染の印つきで返し、受け手も汚染する（taintOnTeamMessage）。渡し済みに記録して2度渡さない", async () => {
    const { db } = T();
    const { w, env, token, q } = await asked(db);
    const replyId = await insertReply(db, w.ws, w.ask, q, w.inboxTask, { tainted: true });
    const out = (await env.edge.callTool(token, "w2")) as { kind: string; text: string };
    expect(out.kind).toBe("text");
    expect(out.text).toContain("# ほかの担当からの連絡");
    expect(out.text).toContain(`受信箱係からの返事（message_id: ${replyId}。外部の内容をもとにしています）：`);
    expect(out.text).toContain(wrapUntrusted("message:受信箱係", "確定とは書かれていない"));
    const t = (await db.query<{ tainted: boolean; taint_sources: Array<{ kind: string; messageId: string; fromAgentName: string }>; input_message_ids: string[] }>("SELECT tainted, taint_sources, input_message_ids FROM tasks WHERE id = $1", [w.supplierTask])).rows[0]!;
    expect(t.tainted).toBe(true);
    expect(t.taint_sources.map((s) => ({ kind: s.kind, messageId: s.messageId, from: s.fromAgentName }))).toEqual([{ kind: "team_message", messageId: replyId, from: "受信箱係" }]);
    expect(t.input_message_ids).toEqual([replyId]);
  });

  it("汚染されていない連絡では受け手を汚染しない", async () => {
    const { db } = T();
    const { w, env, token, q } = await asked(db);
    await insertReply(db, w.ws, w.ask, q, w.inboxTask, { tainted: false });
    await env.edge.callTool(token, "w2");
    const t = (await db.query<{ tainted: boolean }>("SELECT tainted FROM tasks WHERE id = $1", [w.supplierTask])).rows[0]!;
    expect(t.tainted).toBe(false);
  });

  it("返事がなければ timeout で「返事がないので、分かっている範囲で進めます」（待ち時間は最大 A-104、待つ間にハートビート）", async () => {
    const { db } = T();
    const { env, token } = await asked(db);
    expect(await env.edge.callTool(token, "w2")).toEqual({ kind: "text", text: TEAM_NO_REPLY_TEXT });
  });

  it("相手の担当が止まったら、返事を待たずに止まった旨を返す", async () => {
    const { db } = T();
    const { w, env, token } = await asked(db);
    await finishTask(db, w.inboxTask, "failed");
    expect(await env.edge.callTool(token, "w2")).toEqual({ kind: "text", text: TEAM_RECIPIENT_STOPPED_TEXT });
  });

  it("Kill Switch・タスクの停止ではすぐ halted で返る", async () => {
    const { db } = T();
    const { w, env, token } = await asked(db);
    await db.query("UPDATE workspaces SET kill_switch_engaged = true WHERE id = $1", [w.ws.workspaceId]);
    await db.query("UPDATE tasks SET status = 'halted', halt_reason = 'kill_switch', finished_at = $2 WHERE id = $1", [w.supplierTask, T0]);
    const out = await env.edge.callTool(token, "w2").then(
      (r) => r,
      (e: unknown) => e,
    );
    // トークンは Kill Switch で引き直せない（TASK_HALTED）。待たずに止まったことが分かる
    expect(out).toMatchObject({ code: "TASK_HALTED" });
  });

  it("自分が送っていない message_id を待とうとするとエラーの文を返す", async () => {
    const { db } = T();
    const w = await setup(db);
    const env = started(db, { script: [{ parts: [call("w1", "team_wait", { message_id: "00000000-0000-4000-8000-000000000000", timeout: 1 })], usage: USAGE }] });
    const token = await tokenFor(db, w.ws, w.supplierTask);
    const ctx = await env.edge.getTaskContext(token);
    await env.edge.llmMessages(token, llmRequest(ctx.tools));
    expect((await env.edge.callTool(token, "w1")) as { text: string }).toMatchObject({ text: expect.stringContaining("TEAM_MESSAGE_NOT_FOUND") });
  });
});

describe("始める前に届いた連絡・追いのターン", () => {
  it("始まる前に仕入れ係から届いていた question は、受信箱係のタスクの開始のとき teamMessages に載り、渡し済みになる", async () => {
    const { db } = T();
    const w = await setup(db, { inboxDone: false });
    // 仕入れ係のタスクが先に動いて、受信箱係へ question を送っていた（並列・まとめで起こり得る形を直接作る）
    const q = await db.transaction((tx) =>
      insertAskMessage(tx, w.ctx, {
        askId: w.ask.askId,
        askRunId: w.ask.askRunId,
        fromMember: w.ask.members["仕入れ係"]!,
        toMember: w.ask.members["受信箱係"]!,
        kind: "question",
        body: QUESTION,
        inReplyTo: null,
        tainted: true,
        fromTaskId: w.supplierTask,
        now: T0,
      }),
    );
    const env = started(db, { script: [] });
    const ctx = await env.edge.getTaskContext(await tokenFor(db, w.ws, w.inboxTask));
    expect(ctx.input.teamMessages).toEqual([{ messageId: q.id, fromAgentName: "仕入れ係", kind: "question", tainted: true, body: QUESTION }]);
    const row = (await db.query<{ input_message_ids: string[]; tainted: boolean }>("SELECT input_message_ids, tainted FROM tasks WHERE id = $1", [w.inboxTask])).rows[0]!;
    expect(row.input_message_ids).toEqual([q.id]);
    expect(row.tainted).toBe(true);
    // 2回目は渡さない
    const again = await started(db, { script: [] }).edge.getTaskContext(await tokenFor(db, w.ws, w.inboxTask));
    expect(again.input.teamMessages).toEqual([]);
  });

  async function followupOf(db: Db): Promise<{ w: Awaited<ReturnType<typeof setup>>; qid: Uuid; followupId: Uuid; ctx: TaskContext; token: string; env: ReturnType<typeof started> }> {
    const w = await setup(db);
    const q = await db.transaction((tx) =>
      insertAskMessage(tx, w.ctx, {
        askId: w.ask.askId,
        askRunId: w.ask.askRunId,
        fromMember: w.ask.members["仕入れ係"]!,
        toMember: w.ask.members["受信箱係"]!,
        kind: "question",
        body: QUESTION,
        inReplyTo: null,
        tainted: false,
        fromTaskId: w.supplierTask,
        now: T0,
      }),
    );
    const parent = (await db.query<import("@open-team/db").TaskRow>("SELECT * FROM tasks WHERE id = $1", [w.inboxTask])).rows[0]!;
    const followup = await db.transaction((tx) => insertFollowupTask(tx, w.ctx, { parent, messageId: q.id, taint: { tainted: false, sources: [] }, now: T0 }));
    const env = started(db, { script: [post("r1", { to: "仕入れ係", kind: "reply", body: "確定とは書かれていません", in_reply_to: q.id })] });
    const token = await tokenFor(db, w.ws, followup.id);
    const ctx = await env.edge.getTaskContext(token);
    return { w, qid: q.id, followupId: followup.id, ctx, token, env };
  }

  it("追いのターンの文脈：ツールは team_post と finish だけ、質問と前に出した報告が入力に載る", async () => {
    const { db } = T();
    const f = await followupOf(db);
    expect(f.ctx.tools.map((t) => t.name).sort()).toEqual(["finish", "team_post"]);
    expect(f.ctx.input.followupQuestion).toEqual({ messageId: f.qid, fromAgentName: "仕入れ係", body: QUESTION, originalReport: "A社から20kgの発注の連絡" });
    expect(f.ctx.input.teamMessages).toEqual([]);
    expect(f.ctx.input.prompt).toBeNull();
  });

  it("追いのターンが reply を1通送ると、返事を報告にしてタスクを終える（report_accepted・completed・onTaskTerminal）", async () => {
    const { db } = T();
    const f = await followupOf(db);
    await f.env.edge.llmMessages(f.token, llmRequest(f.ctx.tools));
    const out = await f.env.edge.callTool(f.token, "r1");
    expect(out).toEqual({ kind: "report_accepted", taskId: f.followupId });
    const t = (await db.query<{ status: string; report: string; kind: string }>("SELECT status, report, kind FROM tasks WHERE id = $1", [f.followupId])).rows[0]!;
    expect(t).toMatchObject({ status: "completed", report: "確定とは書かれていません", kind: "followup" });
    const m = (await db.query<{ kind: string; in_reply_to: Uuid; from_task_id: Uuid }>("SELECT kind, in_reply_to, from_task_id FROM ask_messages WHERE kind = 'reply'")).rows;
    expect(m).toEqual([{ kind: "reply", in_reply_to: f.qid, from_task_id: f.followupId }]);
    expect(f.env.hooks.filter((h) => h.hook === "onTaskTerminal").map((h) => h.status)).toEqual(["completed"]);
    expect(f.env.posted.map((p) => p.kind)).toEqual(["reply"]);
  });
});
