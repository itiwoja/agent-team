// 作業場の実行役（executor）。sandbox-edge から判定済みのコマンドを取り、作業場のディレクトリの中だけで実行して結果を返す（D-116）。
// - ファイルの道具は作業場の根（root）の中だけを触る（.. ・絶対パス・根の外へのリンクは拒否）
// - run_command は /bin/sh -c で、根を作業ディレクトリにして動かす。環境変数は最小（作業場のトークンを子に渡さない）。
//   uid・gid を渡すと、その利用者に落として動かす（本番のコンテナでは root の executor から権限のない利用者へ）
// - 書き換える道具のあとは、ファイルの控え（tar.gz）を送り直す（中身が変わったときだけ）
// - 通信の制限・認証情報がないことは作業場の外（コンテナと網）で守る（ADR-003 の非協調的な強制）

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_EXCLUDE_DIRS, MUTATING_TOOLS, SANDBOX_LIMITS, type CommandResult, type SandboxLimits, type SandboxCommand, type SandboxTransport } from "./protocol.ts";
import { createTarGz, readTarGz, safeRelativePath, type ArchiveFile } from "./tar.ts";

export interface ExecutorOptions {
  transport: SandboxTransport;
  /** 作業場の根（空のディレクトリ） */
  root: string;
  /** コマンドを動かす利用者（本番のコンテナ。手元・試験では省く） */
  runAs?: { uid: number; gid: number };
  /** 子のプロセスに渡す PATH（既定は今の PATH） */
  path?: string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** 止める（試験・プロセスの終了） */
  signal?: AbortSignal;
  /** 待ち（試験で差し替える） */
  sleep?: (ms: number) => Promise<void>;
  limits?: Partial<SandboxLimits>;
}

export class SandboxPathError extends Error {}

const enc = (s: string) => Buffer.from(s, "utf8");

/** 末尾を残して切る（コマンドの出力は最後の方に答えがある） */
export function clipTail(s: string, max: number): string {
  if (s.length <= max) return s;
  return `…（先頭の ${s.length - max} 文字を省きました）\n${s.slice(s.length - max)}`;
}

/** 作業場の中のパスにする。外を指すなら SandboxPathError */
async function resolveInRoot(root: string, rel: unknown, o: { allowRoot?: boolean } = {}): Promise<string> {
  if ((rel === undefined || rel === "" || rel === ".") && o.allowRoot) return root;
  const safe = safeRelativePath(typeof rel === "string" ? rel : "");
  if (safe === null) throw new SandboxPathError("パスは作業場の中の相対パスにしてください（.. や / で始まるパスは使えません）");
  const full = path.join(root, safe);
  // 既にあるいちばん深い親を実パスにして、根の外（リンクの先）を指していないか確かめる
  let probe = full;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new SandboxPathError("作業場の外を指すリンクは使えません");
      break;
    } catch (e) {
      if (e instanceof SandboxPathError) throw e;
      const parent = path.dirname(probe);
      if (parent === probe || parent.length < root.length) break;
      probe = parent;
    }
  }
  return full;
}

interface WalkEntry {
  rel: string;
  size: number;
  isDir: boolean;
}

/** 作業場を辿る（除外のディレクトリ・リンクは入らない） */
async function walk(root: string, dir: string, out: WalkEntry[], max: number, o: { includeExcluded?: boolean } = {}): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (out.length >= max) return;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (!o.includeExcluded && ARCHIVE_EXCLUDE_DIRS.includes(e.name)) {
        out.push({ rel: `${rel}/`, size: 0, isDir: true });
        continue;
      }
      out.push({ rel: `${rel}/`, size: 0, isDir: true });
      await walk(root, full, out, max, o);
    } else if (e.isFile()) {
      const st = await stat(full).catch(() => null);
      out.push({ rel, size: st?.size ?? 0, isDir: false });
    }
  }
}

/** 控えに入れるファイル（除外のディレクトリ・リンク・大きすぎるファイルは入れない） */
export async function collectFiles(root: string, o: { maxFileBytes?: number; maxTotalBytes?: number } = {}): Promise<{ files: ArchiveFile[]; skipped: string[] }> {
  const maxFile = o.maxFileBytes ?? 5 * 1024 * 1024;
  const maxTotal = o.maxTotalBytes ?? 50 * 1024 * 1024;
  const list: WalkEntry[] = [];
  await walk(root, root, list, 20_000);
  const files: ArchiveFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const e of list) {
    if (e.isDir) continue;
    if (e.size > maxFile || total + e.size > maxTotal) {
      skipped.push(e.rel);
      continue;
    }
    const full = path.join(root, e.rel);
    const st = await lstat(full).catch(() => null);
    if (st === null || !st.isFile()) continue;
    files.push({ path: e.rel, content: await readFile(full), executable: (st.mode & 0o111) !== 0 });
    total += e.size;
  }
  return { files, skipped };
}

/** 控えを作業場に展開する */
export async function extractArchive(root: string, archive: Buffer): Promise<number> {
  const files = readTarGz(archive);
  for (const f of files) {
    const full = await resolveInRoot(root, f.path);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, f.content, { mode: f.executable ? 0o755 : 0o644 });
  }
  return files.length;
}

/**
 * コマンドの環境変数（最小。作業場のトークンなどの親の環境は渡さない）。
 * pip は利用者の場所（HOME=作業場の .local）に入れる。npm のキャッシュも作業場の中（どちらも控えには入れない）。
 * SG-07：npm install の出力（資金の呼びかけ・監査・非推奨の文など、パッケージの作者が書ける文）を減らす。
 * 出力は担当の LLM に <untrusted> で渡るので、外の人が書ける面を小さくする（判定は変えない。残る危険は網で閉じる）
 */
export function commandEnv(root: string, pathEnv: string): Record<string, string> {
  return {
    PATH: `${root}/.local/bin:${pathEnv}`,
    HOME: root,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    CI: "1",
    PIP_USER: "1",
    PIP_BREAK_SYSTEM_PACKAGES: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    npm_config_cache: `${root}/.npm`,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_loglevel: "error",
  };
}

/** コマンドを1つ動かす（タイムアウトでプロセスのグループごと止める） */
function runShell(
  root: string,
  command: string,
  timeoutSec: number,
  o: { runAs?: { uid: number; gid: number }; pathEnv: string; maxChars: number; signal?: AbortSignal },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const env = commandEnv(root, o.pathEnv);
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: root,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(o.runAs === undefined ? {} : { uid: o.runAs.uid, gid: o.runAs.gid }),
    });
    let out = "";
    const add = (b: Buffer) => {
      out += b.toString("utf8");
      // 溜めすぎない（末尾だけ残す）
      if (out.length > o.maxChars * 4) out = out.slice(out.length - o.maxChars * 2);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    let timedOut = false;
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutSec * 1000);
    const onAbort = () => kill();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ ok: false, output: `コマンドを始められませんでした：${e.message}`, exitCode: null });
    });
    // TODO(SG-05 監査)：close は stdout・stderr を握る子孫がすべて閉じるまで来ない。setsid などでプロセスグループの外へ逃げた子が
    // 握り続けると、結果を返せないまま edge が時間切れにする（汚染は edge が取った時点で付けるので洗い流しにはならない）。
    // exit で返す・プロセスグループの外の子孫も止める、の直しは別に行う
    child.on("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      const body = clipTail(out, o.maxChars);
      if (timedOut) resolve({ ok: false, output: `${body}\n（${timeoutSec}秒で打ち切りました）`, exitCode: code });
      else resolve({ ok: code === 0, output: `${body}${body.endsWith("\n") || body === "" ? "" : "\n"}（終了コード ${code ?? "なし"}）`, exitCode: code });
    });
  });
}

/** コマンドを1つ実行する（ファイルの道具は作業場の中だけ） */
export async function executeCommand(root: string, cmd: SandboxCommand, o: Omit<ExecutorOptions, "transport" | "root"> = {}): Promise<CommandResult> {
  const L = { ...SANDBOX_LIMITS, ...o.limits };
  const a = cmd.args;
  try {
    switch (cmd.tool) {
      case "list_files": {
        const dir = await resolveInRoot(root, a.path, { allowRoot: true });
        const list: WalkEntry[] = [];
        await walk(root, dir, list, L.listMaxEntries);
        if (list.length === 0) return { ok: true, output: "（ファイルはありません）", exitCode: null };
        const lines = list.map((e) => (e.isDir ? e.rel : `${e.rel}  (${e.size} バイト)`));
        if (list.length >= L.listMaxEntries) lines.push(`…（${L.listMaxEntries}件で打ち切りました）`);
        return { ok: true, output: lines.join("\n"), exitCode: null };
      }
      case "read_file": {
        const full = await resolveInRoot(root, a.path);
        const st = await lstat(full);
        if (!st.isFile()) return { ok: false, output: "ファイルではありません", exitCode: null };
        const text = (await readFile(full)).toString("utf8");
        const clipped = text.length > L.readMaxChars ? `${text.slice(0, L.readMaxChars)}\n…（${L.readMaxChars}文字で打ち切りました）` : text;
        return { ok: true, output: clipped, exitCode: null };
      }
      case "search": {
        const pattern = typeof a.pattern === "string" ? a.pattern : "";
        if (pattern === "") return { ok: false, output: "pattern を指定してください", exitCode: null };
        let re: RegExp;
        try {
          re = new RegExp(pattern);
        } catch {
          return { ok: false, output: "pattern を正規表現として読めません", exitCode: null };
        }
        const dir = await resolveInRoot(root, a.path, { allowRoot: true });
        const list: WalkEntry[] = [];
        await walk(root, dir, list, 5_000);
        const hits: string[] = [];
        for (const e of list) {
          if (e.isDir || e.size > 1024 * 1024) continue;
          const text = (await readFile(path.join(root, e.rel)).catch(() => Buffer.alloc(0))).toString("utf8");
          if (text.includes("\u0000")) continue;
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && hits.length < L.searchMaxMatches; i += 1) {
            if (re.test(lines[i]!)) hits.push(`${e.rel}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
          }
          if (hits.length >= L.searchMaxMatches) break;
        }
        return { ok: true, output: hits.length === 0 ? "（見つかりませんでした）" : hits.join("\n"), exitCode: null };
      }
      case "write_file": {
        const content = typeof a.content === "string" ? a.content : null;
        if (content === null) return { ok: false, output: "content（文字列）を指定してください", exitCode: null };
        if (content.length > L.writeMaxChars) return { ok: false, output: `content は ${L.writeMaxChars} 文字までです`, exitCode: null };
        const full = await resolveInRoot(root, a.path);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, enc(content), { mode: a.executable === true ? 0o755 : 0o644 });
        if (o.runAs !== undefined) await chownTree(full, o.runAs);
        return { ok: true, output: `書きました：${path.relative(root, full).split(path.sep).join("/")}（${Buffer.byteLength(content)} バイト）`, exitCode: null };
      }
      case "delete_file": {
        const full = await resolveInRoot(root, a.path);
        await rm(full, { recursive: true, force: true });
        return { ok: true, output: `消しました：${path.relative(root, full).split(path.sep).join("/")}`, exitCode: null };
      }
      case "run_command": {
        const command = typeof a.command === "string" ? a.command.trim() : "";
        if (command === "") return { ok: false, output: "command を指定してください", exitCode: null };
        const t = typeof a.timeout_sec === "number" && Number.isFinite(a.timeout_sec) ? Math.floor(a.timeout_sec) : L.commandTimeoutSec;
        const timeoutSec = Math.max(1, Math.min(t, L.commandTimeoutMaxSec));
        return await runShell(root, command, timeoutSec, {
          ...(o.runAs === undefined ? {} : { runAs: o.runAs }),
          pathEnv: o.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          maxChars: L.outputMaxChars,
          ...(o.signal === undefined ? {} : { signal: o.signal }),
        });
      }
    }
  } catch (e) {
    if (e instanceof SandboxPathError) return { ok: false, output: e.message, exitCode: null };
    const code = (e as { code?: unknown }).code;
    if (code === "ENOENT") return { ok: false, output: "ファイルがありません", exitCode: null };
    if (code === "EISDIR") return { ok: false, output: "ディレクトリです", exitCode: null };
    return { ok: false, output: `実行できませんでした：${e instanceof Error ? e.message : String(e)}`, exitCode: null };
  }
  return { ok: false, output: "知らない道具です", exitCode: null };
}

async function chownTree(full: string, runAs: { uid: number; gid: number }): Promise<void> {
  const { chown } = await import("node:fs/promises");
  await chown(full, runAs.uid, runAs.gid).catch(() => undefined);
}

/**
 * 作業場の実行役の本体。claim → （next → 実行 → result → 必要なら archive）の繰り返し → done で最後の控えを送って終える。
 * 戻り値は実行したコマンドの数
 */
export async function runExecutor(o: ExecutorOptions): Promise<{ commands: number; reason: "done" | "idle" | "aborted" }> {
  const L = { ...SANDBOX_LIMITS, ...o.limits };
  const log = o.log ?? (() => {});
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const root = await realpath(o.root);

  const claimed = await o.transport.claim();
  if (claimed.archiveBase64 !== null) {
    const n = await extractArchive(root, Buffer.from(claimed.archiveBase64, "base64"));
    log("sandbox.extracted", { files: n });
  }
  if (o.runAs !== undefined) await chownAll(root, o.runAs);

  let lastHash = "";
  const sendArchive = async (): Promise<void> => {
    const { files, skipped } = await collectFiles(root);
    const archive = createTarGz(files);
    const hash = createHash("sha256").update(archive).digest("hex");
    if (hash === lastHash) return;
    if (archive.length > L.archiveMaxBytes) {
      log("sandbox.archive_too_large", { bytes: archive.length });
      return;
    }
    await o.transport.archive(archive, { files: files.length, bytes: files.reduce((n, f) => n + f.content.length, 0) });
    lastHash = hash;
    if (skipped.length > 0) log("sandbox.archive_skipped", { skipped: skipped.slice(0, 20) });
  };
  // 最初の中身を控えの基準にする（何も変えなければ送らない）
  lastHash = createHash("sha256").update(createTarGz((await collectFiles(root)).files)).digest("hex");

  let commands = 0;
  let idleSince = Date.now();
  let failures = 0;
  for (;;) {
    if (o.signal?.aborted) {
      await sendArchive().catch(() => undefined);
      return { commands, reason: "aborted" };
    }
    let next;
    try {
      next = await o.transport.next(L.nextWaitSec);
      failures = 0;
    } catch (e) {
      failures += 1;
      log("sandbox.next_failed", { error: e instanceof Error ? e.message : String(e), failures });
      if (failures >= 5) throw e;
      await sleep(Math.min(16_000, 1000 * 2 ** failures));
      continue;
    }
    if (next.kind === "done") {
      await sendArchive().catch((e) => log("sandbox.archive_failed", { error: e instanceof Error ? e.message : String(e) }));
      return { commands, reason: "done" };
    }
    if (next.kind === "idle") {
      if (Date.now() - idleSince > L.idleExitSec * 1000) {
        await sendArchive().catch(() => undefined);
        return { commands, reason: "idle" };
      }
      continue;
    }
    const cmd = next.command;
    log("sandbox.command", { id: cmd.id, tool: cmd.tool });
    const result = await executeCommand(root, cmd, o);
    commands += 1;
    // 書き換える道具のあとは、結果より先に控えを送る（報告が出たときに成果がそろっている）
    if (MUTATING_TOOLS.has(cmd.tool)) await sendArchive().catch((e) => log("sandbox.archive_failed", { error: e instanceof Error ? e.message : String(e) }));
    await o.transport.result(cmd.id, result);
    idleSince = Date.now();
  }
}

async function chownAll(root: string, runAs: { uid: number; gid: number }): Promise<void> {
  const { chown } = await import("node:fs/promises");
  const list: WalkEntry[] = [];
  await walk(root, root, list, 50_000, { includeExcluded: true });
  await chown(root, runAs.uid, runAs.gid).catch(() => undefined);
  for (const e of list) await chown(path.join(root, e.rel), runAs.uid, runAs.gid).catch(() => undefined);
}
