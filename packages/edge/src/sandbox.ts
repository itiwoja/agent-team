// 作業場（サンドボックス）の道具と sandbox-edge（D-116）。
// - 担当の作業場の道具（list_files・read_file・search・write_file・delete_file・run_command）は LLM Proxy で判定済み（edit_code・run_tests）。
//   callTool はそのコマンドを sandbox_commands に積み、作業場の実行役が結果を書くまで待つ。作業場は最初の道具の呼び出しで起こす
// - 作業場は判定済みのコマンドしか受け取れず、LLM も呼べない（トークンはその作業場だけのもの）。結果は外から来た内容として <untrusted> で包み、
//   run_command の出力はタスクを汚染する（入れたパッケージ・書いたコードの出力：ADR-024）
// - sandbox-edge（app の /sandbox/v1）：claim（最初の中身）・next（コマンドを待つ）・result（結果）・archive（ファイルの控え）
// - 汚染の持ち越し（SG-05）：控えには残したタスクの汚染を写し（archive）、汚染された控えを受け取ったタスクは workspace_snapshot で汚染する（claim）。
//   load_skill は運営のパックと同じ中身のスキルだけを信頼して渡し、それ以外は <untrusted> で包んで skill で汚染する（skill-trust.ts）

import { createHash, randomBytes } from "node:crypto";
import { addTaintSource, operationOfCommand, taintOnWorkspaceSnapshot, taintedByOutsideContent, wrapUntrusted, type JsonObject, type TaintState } from "@open-team/kernel";
import { EdgeError, toolErrorText, type ToolCallResult } from "@open-team/runner";
import { sleepMs } from "@open-team/llm";
import { maskSecrets } from "@open-team/platform";
import { appendAuditLog, lockWorkspace, system, wsCtxOf, type PolicyDecisionRow, type SandboxCommandRow, type SandboxSessionRow, type SandboxTool, type TaskRow, type Uuid, type WsCtx } from "@open-team/db";
import { getTask, lockTask, setTaskTaint, touchTaskHeartbeat } from "@open-team/db/edge";
import {
  claimNextSandboxCommand,
  closeSandboxSession,
  completeSandboxCommand,
  enqueueSandboxCommand,
  expireSandboxCommand,
  getInitialSandboxSnapshot,
  getOpenSandboxSession,
  getSandboxCommand,
  insertWorkspaceSnapshot,
  listAgentSkills,
  openSandboxSession,
  peekQueuedSandboxCommand,
  refuseSandboxCommand,
  SANDBOX_COMMAND_REFUSED_OUTPUT,
  pruneAgentSnapshots,
  setSandboxProviderRef,
  touchSandboxSession,
} from "@open-team/db/sandbox";
import type { EdgeRuntime } from "./runtime.ts";
import { RUN_SHELL_TAINTED_TEXT } from "./sandbox-command.ts";
import { isTrustedSkill } from "./skill-trust.ts";
import { haltedDetails } from "./tokens.ts";
import { isPlainObject } from "./util.ts";

/** 作業場の道具（Kernel のカタログの名前） */
export const SANDBOX_TOOL_SET: ReadonlySet<string> = new Set<SandboxTool>(["list_files", "read_file", "search", "write_file", "delete_file", "run_command"]);

/** 作業場の上限（edge 側） */
export const SANDBOX_EDGE_LIMITS = {
  /** 作業場が起きるまで待つ（コンテナの起動には時間がかかる） */
  startupWaitSec: 180,
  /** コマンドの既定の時間・上限（作業場の実行役と同じ） */
  commandTimeoutSec: 120,
  commandTimeoutMaxSec: 300,
  /** 結果を待つときの余裕 */
  resultGraceSec: 30,
  /** 控えの大きさ */
  archiveMaxBytes: 10 * 1024 * 1024,
  /** 担当ごとに残す控えの数 */
  snapshotsKeep: 10,
  /** 閉じたあとに控えを受け付ける時間（最後の控え） */
  archiveGraceMs: 5 * 60_000,
  /** next の長い待ちの上限（秒） */
  nextWaitMaxSec: 25,
};

/** 作業場が閉じた・始められなかったときの文 */
export const SANDBOX_START_FAILED_TEXT = "作業場を起こせませんでした。作業場を使わずにできる範囲で進め、その旨を報告してください。";
export const SANDBOX_TIMEOUT_TEXT = "作業場から返事がありませんでした（時間切れ）。同じことを繰り返さず、できる範囲で進めてください。";
export const SANDBOX_CLOSED_TEXT = "作業場が閉じました。";

export function hashSandboxToken(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

function newSandboxToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 道具の引数を作業場に渡す形に整える（形の崩れは VALIDATION_ERROR：担当が直して呼び直せる） */
export function sandboxArgsOf(tool: SandboxTool, raw: unknown): JsonObject {
  const a = isPlainObject(raw) ? raw : {};
  const str = (k: string, required: boolean): string | undefined => {
    const v = a[k];
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string" || (required && v.trim() === "")) {
      throw new EdgeError("VALIDATION_ERROR", { issues: [{ field: k, reason: `${k} は文字列で指定してください` }] });
    }
    return v;
  };
  switch (tool) {
    case "list_files": {
      const path = str("path", false);
      return path === undefined ? {} : { path };
    }
    case "read_file":
    case "delete_file":
      return { path: str("path", true)! };
    case "search": {
      const path = str("path", false);
      return { pattern: str("pattern", true)!, ...(path === undefined ? {} : { path }) };
    }
    case "write_file": {
      const content = a.content;
      if (typeof content !== "string") throw new EdgeError("VALIDATION_ERROR", { issues: [{ field: "content", reason: "content は文字列で指定してください" }] });
      return { path: str("path", true)!, content, ...(a.executable === true ? { executable: true } : {}) };
    }
    case "run_command": {
      const t = a.timeout_sec;
      const timeout = typeof t === "number" && Number.isFinite(t) ? Math.max(1, Math.min(Math.floor(t), SANDBOX_EDGE_LIMITS.commandTimeoutMaxSec)) : undefined;
      return { command: str("command", true)!, ...(timeout === undefined ? {} : { timeout_sec: timeout }) };
    }
  }
}

/** タスクの作業場を用意する（なければ開いて起こす）。起こせなければ null */
async function ensureSession(rt: EdgeRuntime, ctx: WsCtx, task: TaskRow): Promise<{ session: SandboxSessionRow; fresh: boolean } | null> {
  const open = await getOpenSandboxSession(rt.db, ctx, task.id);
  if (open !== null) return { session: open, fresh: false };
  if (rt.sandbox === null) return null;
  const token = newSandboxToken();
  const now = rt.clock.now();
  const created = await rt.db.transaction(async (tx) => {
    await lockWorkspace(tx, ctx);
    const s = await openSandboxSession(tx, ctx, { taskId: task.id, agentId: task.agent_id, tokenHash: hashSandboxToken(token), provider: rt.sandbox!.name, now });
    if (s !== null) {
      await appendAuditLog(
        tx,
        ctx.workspaceId,
        { eventType: "sandbox.session.opened", actorType: "system", actorId: "edge", taskId: task.id, payload: { taskId: task.id, sessionId: s.id, provider: s.provider } },
        now,
      );
    }
    return s;
  });
  // 同時に開かれた：もう一方を使う
  if (created === null) {
    const other = await getOpenSandboxSession(rt.db, ctx, task.id);
    return other === null ? null : { session: other, fresh: false };
  }
  try {
    const started = await rt.sandbox.start({ ctx, sessionId: created.id, taskId: task.id, token });
    await setSandboxProviderRef(rt.db, ctx, created.id, started.ref);
  } catch (e) {
    rt.log.warn("sandbox.start_failed", "作業場を起こせなかった", { workspaceId: ctx.workspaceId, taskId: task.id, error: e });
    await closeSandboxSession(rt.db, ctx, created.id, "start_failed", rt.clock.now());
    return null;
  }
  return { session: created, fresh: true };
}

/** 作業場の道具（callTool から）：コマンドを積んで結果を待つ */
export async function sandboxTool(rt: EdgeRuntime, ctx: WsCtx, task: TaskRow, row: PolicyDecisionRow, tool: SandboxTool): Promise<ToolCallResult> {
  const args = sandboxArgsOf(tool, row.subject.args);
  const ensured = await ensureSession(rt, ctx, task);
  if (ensured === null) return { kind: "text", text: `${toolErrorText("SANDBOX_NOT_AVAILABLE")} ${SANDBOX_START_FAILED_TEXT}` };
  const { session } = ensured;
  const cmd = await enqueueSandboxCommand(rt.db, ctx, { sessionId: session.id, taskId: task.id, tool, args, now: rt.clock.now() });

  const timeout = tool === "run_command" && typeof args.timeout_sec === "number" ? args.timeout_sec : SANDBOX_EDGE_LIMITS.commandTimeoutSec;
  // まだ作業場が来ていなければ、起動を待つ分を足す
  const startup = session.status === "starting" ? SANDBOX_EDGE_LIMITS.startupWaitSec : 0;
  const pollMs = Math.max(1, rt.limits.teamWaitPollMs);
  const polls = Math.max(1, Math.ceil(((timeout + SANDBOX_EDGE_LIMITS.resultGraceSec + startup) * 1000) / pollMs));
  const sleep = rt.retry.sleep ?? sleepMs;
  const signal = rt.signalFor?.(task.id);

  let done: SandboxCommandRow | null = null;
  for (let i = 0; ; i += 1) {
    const c = await getSandboxCommand(rt.db, ctx, cmd.id);
    if (c === null) return { kind: "text", text: toolErrorText("SANDBOX_COMMAND_NOT_FOUND") };
    if (c.status === "done") {
      done = c;
      break;
    }
    if (c.status === "expired") {
      // SG-07：作業場が受け取った控えの汚染で判定し直して断ったコマンド（claimWithTaint）
      if (c.output === SANDBOX_COMMAND_REFUSED_OUTPUT) return { kind: "text", text: `${toolErrorText("SANDBOX_COMMAND_REFUSED")} ${RUN_SHELL_TAINTED_TEXT}` };
      return { kind: "text", text: `${toolErrorText("SANDBOX_CLOSED")} ${SANDBOX_CLOSED_TEXT}` };
    }
    const t = await getTask(rt.db, ctx, task.id);
    if (t === null || t.status !== "running" || signal?.aborted === true) {
      await expireSandboxCommand(rt.db, ctx, cmd.id, rt.clock.now());
      return { kind: "halted", reasonCode: t === null ? "task_terminated" : haltedDetails(t).haltReason };
    }
    if (i + 1 >= polls) {
      // 時間切れで待ちを諦めても、run_command は実行役が取った時点で sandbox_run の汚染が付いている（sandboxNext：SG-05）。
      // あとから届く結果は捨てる（completeSandboxCommand は running のときだけ書く）
      await expireSandboxCommand(rt.db, ctx, cmd.id, rt.clock.now());
      return { kind: "text", text: `${toolErrorText("SANDBOX_TIMEOUT")} ${SANDBOX_TIMEOUT_TEXT}` };
    }
    await touchTaskHeartbeat(rt.db, ctx, task.id, rt.clock.now());
    try {
      await sleep(pollMs, signal);
    } catch {
      await expireSandboxCommand(rt.db, ctx, cmd.id, rt.clock.now());
      return { kind: "halted", reasonCode: "kill_switch" };
    }
  }

  const output = maskSecrets(done.output ?? "", rt.knownSecrets);
  const head = done.ok ? "" : "（失敗）\n";
  // run_command の出力でタスクを汚染する（コミットしてから返す：MT §3.10-8d と同じ）。
  // 実行役が取った時点でも付けている（sandboxNext：SG-05）ので、ここは二重になるが害はない（同じ鍵で1件）
  if (tool === "run_command") {
    const after = await rt.db.transaction(
      async (tx) => {
        const now = rt.clock.now();
        await lockWorkspace(tx, ctx);
        const t = await lockTask(tx, ctx, task.id);
        if (t === null) return null;
        const current: TaintState = { tainted: t.tainted, sources: Array.isArray(t.taint_sources) ? t.taint_sources : [] };
        await setTaskTaint(tx, ctx, t.id, addTaintSource(current, { kind: "sandbox_run", at: now.toISOString() }), now);
        return t;
      },
      { retryOnce: true },
    );
    if (after === null) throw new EdgeError("UNAUTHORIZED");
    if (after.status !== "running") return { kind: "halted", reasonCode: haltedDetails(after).haltReason };
  }
  return { kind: "text", text: wrapUntrusted(`sandbox:${tool}`, `${head}${output}`) };
}

/**
 * タスクの汚染を変えてコミットする（ワークスペース → タスクの順にロック。web.ts の commitTaint と同じ形）。
 * next は今の汚染から次の汚染を作る。タスクがなければ null、あれば変える前の行
 */
async function commitTaskTaint(rt: EdgeRuntime, ctx: WsCtx, taskId: Uuid, next: (current: TaintState, now: Date) => TaintState): Promise<TaskRow | null> {
  return rt.db.transaction(
    async (tx) => {
      const now = rt.clock.now();
      await lockWorkspace(tx, ctx);
      const t = await lockTask(tx, ctx, taskId);
      if (t === null) return null;
      const current: TaintState = { tainted: t.tainted, sources: Array.isArray(t.taint_sources) ? t.taint_sources : [] };
      const after = next(current, now);
      if (after !== current) await setTaskTaint(tx, ctx, t.id, after, now);
      return t;
    },
    { retryOnce: true },
  );
}

/**
 * load_skill：担当自身のスキルを名前で読む（パックで入った手順書。外へは出ない）。
 * 運営のパックの定数と同じ中身（(pack_id, 名前) の (名前, 説明, 本文) の SHA-256 が一致：skill-trust.ts）なら信頼された手順書として渡す。
 * それ以外（カタログにない・書き換えられた）は <untrusted> で包み、読んだタスクを skill で汚染する（コミットしてから返す：SG-05）
 */
export async function loadSkill(rt: EdgeRuntime, ctx: WsCtx, task: TaskRow, row: PolicyDecisionRow): Promise<ToolCallResult> {
  const raw = isPlainObject(row.subject.args) ? row.subject.args : {};
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const skills = await listAgentSkills(rt.db, ctx, task.agent_id);
  const hit = skills.find((s) => s.name === name) ?? skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (hit === undefined) {
    // 一覧に出すのは信頼できるスキルの名前だけ（DB の名前を包まずに返さない：SG-05）。探した名前は担当が書いたもの
    const names = skills.filter((s) => isTrustedSkill(rt.trustedSkills, s)).map((s) => s.name);
    return { kind: "text", text: `スキル「${name}」はありません。使えるスキル：${names.join("、") || "（なし）"}` };
  }
  const body = maskSecrets(hit.body, rt.knownSecrets);
  if (isTrustedSkill(rt.trustedSkills, hit)) return { kind: "text", text: `# スキル「${hit.name}」\n\n${body}` };

  const before = await commitTaskTaint(rt, ctx, task.id, (current, now) =>
    addTaintSource(current, { kind: "skill", name: hit.name, packId: hit.pack_id, at: now.toISOString() }),
  );
  if (before === null) return { kind: "halted", reasonCode: "task_terminated" };
  if (before.status !== "running") return { kind: "halted", reasonCode: haltedDetails(before).haltReason };
  return { kind: "text", text: wrapUntrusted(`skill:${hit.name}`, body) };
}

// ---- sandbox-edge（作業場からの呼び出し。app の /sandbox/v1 が使う） ----

export interface ResolvedSandbox {
  ctx: WsCtx;
  session: SandboxSessionRow;
  killSwitch: boolean;
}

/** 作業場のトークンを確かめる。閉じた作業場は allowClosed のときだけ通す：true（最後の控え）は閉じてから少しのあいだ、"always"（next に done を返す）はいつでも */
export async function resolveSandbox(rt: EdgeRuntime, rawToken: unknown, o: { allowClosed?: boolean | "always" } = {}): Promise<ResolvedSandbox> {
  if (typeof rawToken !== "string" || rawToken === "" || rawToken.length > 200) throw new EdgeError("UNAUTHORIZED");
  const hit = await system.findSandboxSessionByTokenHash(rt.db, hashSandboxToken(rawToken));
  if (hit === null) throw new EdgeError("UNAUTHORIZED");
  const { session, workspace } = hit;
  if (session.status === "closed") {
    const closedAt = session.closed_at?.getTime() ?? 0;
    const allowed = o.allowClosed === "always" || (o.allowClosed === true && rt.clock.now().getTime() - closedAt <= SANDBOX_EDGE_LIMITS.archiveGraceMs);
    if (!allowed) throw new EdgeError("TASK_HALTED", { reason: "sandbox_closed" });
  }
  return { ctx: wsCtxOf(workspace), session, killSwitch: workspace.kill_switch_engaged };
}

/**
 * claim：最初の中身（担当の最新の控え）を渡す。
 * 控えが汚染されていれば（汚染されたタスクが残した）、渡す前に受け取るタスクを workspace_snapshot で汚染してコミットする（SG-05）。
 * 中身がタスクに届くのは、このあとのコマンドの結果からなので、汚染は必ずその前に付いている。パックの控えは汚染なし
 */
export async function sandboxClaim(rt: EdgeRuntime, rawToken: unknown): Promise<{ taskId: string; archiveBase64: string | null }> {
  const { ctx, session } = await resolveSandbox(rt, rawToken);
  await touchSandboxSession(rt.db, ctx, session.id, rt.clock.now());
  const snap = await getInitialSandboxSnapshot(rt.db, ctx, session.task_id);
  if (snap === null) return { taskId: session.task_id, archiveBase64: null };
  const snapTaint: TaintState = { tainted: snap.tainted, sources: Array.isArray(snap.taint_sources) ? snap.taint_sources : [] };
  if (snapTaint.tainted || snapTaint.sources.length > 0) {
    const before = await commitTaskTaint(rt, ctx, session.task_id, (current, now) =>
      taintOnWorkspaceSnapshot(current, { snapshotId: snap.id, fromTaskId: snap.task_id, taint: snapTaint }, session.task_id, now.toISOString()),
    );
    // タスクがない（消えた）なら控えは渡さない
    if (before === null) throw new EdgeError("UNAUTHORIZED");
  }
  return { taskId: session.task_id, archiveBase64: snap.archive.toString("base64") };
}

/**
 * 次のコマンドを取る（queued → running）。run_command なら、同じトランザクションでタスクを sandbox_run で汚染する（SG-05）。
 * 実行役に渡す前にコミットするので、結果が来ないまま時間切れになっても・作業場がファイルを書き換えても、タスクは汚染されている。
 * タスクが動いていなければ取らない（next の次の回で done を返す）
 */
async function claimWithTaint(rt: EdgeRuntime, ctx: WsCtx, session: SandboxSessionRow, now: Date): Promise<SandboxCommandRow | null> {
  return rt.db.transaction(
    async (tx) => {
      await lockWorkspace(tx, ctx);
      const t = await lockTask(tx, ctx, session.task_id);
      if (t === null || t.status !== "running") return null;
      const cmd = await claimNextSandboxCommand(tx, ctx, session.id, now);
      if (cmd !== null && cmd.tool === "run_command") {
        const current: TaintState = { tainted: t.tainted, sources: Array.isArray(t.taint_sources) ? t.taint_sources : [] };
        // SG-07：判定（LLM Proxy）のあとで、作業場が受け取った控えの汚染（sandboxClaim）がタスクに付いていることがある
        // （同じ担当の別のタスクが判定と受け取りの間に汚染された控えを残した）。今の汚染で写し先を決め直し、
        // run_shell になったら実行役に渡さずに断る（固定の拒否の文は sandboxTool が返す）。汚染は付けない（動かしていない）
        if (operationOfCommand(cmd.args.command, taintedByOutsideContent(current)) === "run_shell") {
          await refuseSandboxCommand(tx, ctx, cmd.id, now);
          return null;
        }
        await setTaskTaint(tx, ctx, t.id, addTaintSource(current, { kind: "sandbox_run", at: now.toISOString() }), now);
      }
      return cmd;
    },
    { retryOnce: true },
  );
}

/** next：コマンドを待つ（waitSec まで）。タスクが終わった・止められたら作業場を閉じて done（閉じてから時間が経っていても done。実行役を確実に終わらせる） */
export async function sandboxNext(
  rt: EdgeRuntime,
  rawToken: unknown,
  waitSec: number,
): Promise<{ kind: "command"; command: { id: string; tool: SandboxTool; args: JsonObject } } | { kind: "idle" } | { kind: "done" }> {
  const { ctx, session } = await resolveSandbox(rt, rawToken, { allowClosed: "always" });
  if (session.status === "closed") return { kind: "done" };
  const pollMs = Math.max(1, rt.limits.teamWaitPollMs);
  const wait = Math.max(0, Math.min(Number.isFinite(waitSec) ? waitSec : 0, SANDBOX_EDGE_LIMITS.nextWaitMaxSec));
  const polls = Math.max(1, Math.ceil((wait * 1000) / pollMs));
  const sleep = rt.retry.sleep ?? sleepMs;
  for (let i = 0; ; i += 1) {
    const now = rt.clock.now();
    await touchSandboxSession(rt.db, ctx, session.id, now);
    const t = await getTask(rt.db, ctx, session.task_id);
    const ws = await system.findSandboxSessionByTokenHash(rt.db, session.token_hash);
    if (t === null || t.status !== "running" || ws === null || ws.workspace.kill_switch_engaged || ws.session.status === "closed") {
      await closeSandboxSession(rt.db, ctx, session.id, t === null || t.status !== "running" ? "task_ended" : "stopped", now);
      return { kind: "done" };
    }
    const cmd = (await peekQueuedSandboxCommand(rt.db, ctx, session.id)) === null ? null : await claimWithTaint(rt, ctx, session, now);
    if (cmd !== null) return { kind: "command", command: { id: cmd.id, tool: cmd.tool, args: cmd.args } };
    if (i + 1 >= polls) return { kind: "idle" };
    await sleep(pollMs);
  }
}

/** result：コマンドの結果を書く。知らない・終わったコマンドなら false */
export async function sandboxResult(rt: EdgeRuntime, rawToken: unknown, commandId: string, body: unknown): Promise<boolean> {
  const { ctx, session } = await resolveSandbox(rt, rawToken);
  const b = isPlainObject(body) ? body : {};
  if (typeof b.ok !== "boolean" || typeof b.output !== "string") throw new EdgeError("VALIDATION_ERROR", { issues: [{ field: "body", reason: "ok（真偽）と output（文字列）が要る" }] });
  const exitCode = typeof b.exitCode === "number" && Number.isInteger(b.exitCode) ? b.exitCode : null;
  return completeSandboxCommand(rt.db, ctx, {
    sessionId: session.id,
    commandId,
    ok: b.ok,
    output: b.output.slice(0, 200_000),
    exitCode,
    now: rt.clock.now(),
  });
}

/**
 * 控えに写す汚染（SG-05）：残したタスクの今の汚染。
 * run_command は実行役が取った時点でタスクに sandbox_run が付いている（sandboxNext）ので、結果より先に届く控え・
 * 待ちを諦めたあとに届く控えにも、ここで写る
 */
async function snapshotTaintOf(rt: EdgeRuntime, ctx: WsCtx, session: SandboxSessionRow): Promise<TaintState> {
  const t = await getTask(rt.db, ctx, session.task_id);
  return t === null ? { tainted: false, sources: [] } : { tainted: t.tainted, sources: Array.isArray(t.taint_sources) ? t.taint_sources : [] };
}

/** archive：ファイルの控え（tar.gz）を残す。閉じた直後の最後の控えも受け付ける。控えには残したタスクの汚染を写す（SG-05） */
export async function sandboxArchive(rt: EdgeRuntime, rawToken: unknown, archive: Buffer, meta: { files: number; bytes: number }): Promise<void> {
  const { ctx, session } = await resolveSandbox(rt, rawToken, { allowClosed: true });
  if (archive.length === 0 || archive.length > SANDBOX_EDGE_LIMITS.archiveMaxBytes) {
    throw new EdgeError("VALIDATION_ERROR", { issues: [{ field: "archive", reason: `控えは1〜${SANDBOX_EDGE_LIMITS.archiveMaxBytes}バイト` }] });
  }
  // gzip の先頭（1f 8b）でなければ受け取らない
  if (archive[0] !== 0x1f || archive[1] !== 0x8b) throw new EdgeError("VALIDATION_ERROR", { issues: [{ field: "archive", reason: "tar.gz ではない" }] });
  const files = Number.isInteger(meta.files) && meta.files >= 0 ? meta.files : 0;
  const bytes = Number.isInteger(meta.bytes) && meta.bytes >= 0 ? meta.bytes : 0;
  const taint = await snapshotTaintOf(rt, ctx, session);
  await insertWorkspaceSnapshot(rt.db, ctx, { agentId: session.agent_id, taskId: session.task_id, source: "task", archive, files, bytes, taint, now: rt.clock.now() });
  await pruneAgentSnapshots(rt.db, ctx, session.agent_id, SANDBOX_EDGE_LIMITS.snapshotsKeep);
}

/** タスクが終わったら作業場を閉じる（実行役は次の next で done を受け取り、最後の控えを送って終える） */
export async function closeSandboxOfTask(rt: EdgeRuntime, ctx: WsCtx, taskId: string): Promise<void> {
  const open = await getOpenSandboxSession(rt.db, ctx, taskId);
  if (open !== null) await closeSandboxSession(rt.db, ctx, open.id, "task_ended", rt.clock.now());
}

/** sandbox-edge の入口（app の /sandbox/v1 と、同じプロセスの作業場が使う）。EdgeDeps から作る */
export interface SandboxEdge {
  claim(token: string): Promise<{ taskId: string; archiveBase64: string | null }>;
  next(token: string, waitSec: number): ReturnType<typeof sandboxNext>;
  result(token: string, commandId: string, body: unknown): Promise<boolean>;
  archive(token: string, archive: Buffer, meta: { files: number; bytes: number }): Promise<void>;
}

export function sandboxEdgeOf(rt: EdgeRuntime): SandboxEdge {
  return {
    claim: (token) => sandboxClaim(rt, token),
    next: (token, waitSec) => sandboxNext(rt, token, waitSec),
    result: (token, commandId, body) => sandboxResult(rt, token, commandId, body),
    archive: (token, archive, meta) => sandboxArchive(rt, token, archive, meta),
  };
}
