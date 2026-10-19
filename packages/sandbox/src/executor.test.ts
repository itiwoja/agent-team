// 作業場の実行役の試験：ファイルの道具は作業場の中だけ・コマンドの実行と打ち切り・控えの往復・claim → next → result → done の流れ
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandEnv, executeCommand, runExecutor } from "./executor.ts";
import type { CommandResult, NextResponse, SandboxCommand, SandboxTransport } from "./protocol.ts";
import { createTarGz, readTarGz, safeRelativePath } from "./tar.ts";

async function root(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "sbx-"));
}

const cmd = (tool: SandboxCommand["tool"], args: Record<string, unknown>, id = "c1"): SandboxCommand => ({ id, tool, args });

describe("tar（ファイルの控え）", () => {
  it("書いて読むと同じ中身・実行の印が戻る。並びはパスの順で、同じ中身なら同じバイト列", () => {
    const files = [
      { path: "b/score.py", content: Buffer.from("print(1)\n"), executable: true },
      { path: "a.txt", content: Buffer.from("あいう") },
    ];
    const a = createTarGz(files);
    expect(createTarGz([...files].reverse())).toEqual(a);
    expect(readTarGz(a)).toEqual([
      { path: "a.txt", content: Buffer.from("あいう"), executable: false },
      { path: "b/score.py", content: Buffer.from("print(1)\n"), executable: true },
    ]);
  });

  it("長いパス（ustar の prefix）も往復する", () => {
    const p = `${"d".repeat(60)}/${"e".repeat(60)}/file.txt`;
    expect(readTarGz(createTarGz([{ path: p, content: Buffer.from("x") }]))[0]!.path).toBe(p);
  });

  it("作業場の外を指すパスは作れない・読まない", () => {
    expect(safeRelativePath("../etc/passwd")).toBeNull();
    expect(safeRelativePath("/etc/passwd")).toBeNull();
    expect(safeRelativePath("a/./b//c")).toBe("a/b/c");
    expect(() => createTarGz([{ path: "../x", content: Buffer.from("") }])).toThrow();
  });
});

describe("executeCommand（道具）", () => {
  it("write_file → read_file → list_files → search → delete_file", async () => {
    const r = await root();
    expect((await executeCommand(r, cmd("write_file", { path: "src/score.py", content: "def score():\n    return 42\n" }))).ok).toBe(true);
    expect(await executeCommand(r, cmd("read_file", { path: "src/score.py" }))).toEqual({ ok: true, output: "def score():\n    return 42\n", exitCode: null });
    const list = await executeCommand(r, cmd("list_files", {}));
    expect(list.output).toContain("src/");
    expect(list.output).toContain("src/score.py  (");
    expect((await executeCommand(r, cmd("search", { pattern: "return \\d+" }))).output).toBe("src/score.py:2:     return 42");
    expect((await executeCommand(r, cmd("delete_file", { path: "src/score.py" }))).ok).toBe(true);
    expect(await executeCommand(r, cmd("read_file", { path: "src/score.py" }))).toEqual({ ok: false, output: "ファイルがありません", exitCode: null });
  });

  it("作業場の外（.. ・絶対パス・外を指すリンク）は触れない", async () => {
    const r = await root();
    const outside = await root();
    await writeFile(path.join(outside, "secret.txt"), "秘密");
    await symlink(outside, path.join(r, "link"));
    for (const p of ["../x.txt", "/etc/passwd", "link/secret.txt"]) {
      const res = await executeCommand(r, cmd("read_file", { path: p }));
      expect(res.ok).toBe(false);
      expect(res.output).not.toContain("秘密");
    }
    expect((await executeCommand(r, cmd("write_file", { path: "link/new.txt", content: "x" }))).ok).toBe(false);
  });

  it("SG-07：npm の資金の呼びかけ・監査・更新の知らせを止め、ログは error だけ（install の出力の面を減らす）", async () => {
    const env = commandEnv("/w", "/usr/bin");
    expect(env).toMatchObject({
      npm_config_fund: "false",
      npm_config_audit: "false",
      npm_config_loglevel: "error",
      npm_config_update_notifier: "false",
      npm_config_cache: "/w/.npm",
      HOME: "/w",
    });
    const r = await root();
    const res = await executeCommand(r, cmd("run_command", { command: "echo $npm_config_fund $npm_config_audit $npm_config_loglevel $npm_config_update_notifier" }));
    expect(res.output).toContain("false false error false");
  });

  it("run_command：作業場で動き、終了コードと出力を返す。環境変数は最小（親の変数を渡さない）", async () => {
    const r = await root();
    process.env.SANDBOX_TOKEN_TEST = "漏れてはいけない";
    const res = await executeCommand(r, cmd("run_command", { command: "pwd; echo hi > out.txt; echo \"[$SANDBOX_TOKEN_TEST]\"; exit 3" }));
    delete process.env.SANDBOX_TOKEN_TEST;
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
    expect(res.output).toContain("[]");
    expect(res.output).toContain("（終了コード 3）");
    expect(await readFile(path.join(r, "out.txt"), "utf8")).toBe("hi\n");
  });

  it("run_command：時間を過ぎたら打ち切る", async () => {
    const r = await root();
    const res = await executeCommand(r, cmd("run_command", { command: "sleep 5", timeout_sec: 1 }));
    expect(res.ok).toBe(false);
    expect(res.output).toContain("1秒で打ち切りました");
  });

  it("出力は末尾を残して切る", async () => {
    const r = await root();
    const res = await executeCommand(r, cmd("run_command", { command: "seq 1 20000" }), { limits: { outputMaxChars: 100 } });
    expect(res.output).toContain("先頭の");
    expect(res.output).toContain("20000");
  });
});

/** 台本どおりにコマンドを渡し、結果と控えを記録する口 */
function fakeTransport(commands: SandboxCommand[], initial: Buffer | null = null) {
  const results: Array<{ id: string; r: CommandResult }> = [];
  const archives: Buffer[] = [];
  const queue = [...commands];
  const t: SandboxTransport = {
    claim: async () => ({ taskId: "t1", archiveBase64: initial === null ? null : initial.toString("base64") }),
    next: async (): Promise<NextResponse> => {
      const c = queue.shift();
      return c === undefined ? { kind: "done" } : { kind: "command", command: c };
    },
    result: async (id, r) => void results.push({ id, r }),
    archive: async (a) => void archives.push(a),
  };
  return { t, results, archives };
}

describe("runExecutor（流れ）", () => {
  it("最初の中身を展開し、コマンドを順に実行して結果を返す。書き換えたら控えを送り、done で終える", async () => {
    const r = await root();
    const initial = createTarGz([{ path: "answers.csv", content: Buffer.from("name,score\nA,80\nB,95\n") }]);
    const f = fakeTransport(
      [
        cmd("read_file", { path: "answers.csv" }, "c1"),
        cmd("write_file", { path: "avg.sh", content: "awk -F, 'NR>1{s+=$2;n++} END{print s/n}' answers.csv\n" }, "c2"),
        cmd("run_command", { command: "sh avg.sh" }, "c3"),
      ],
      initial,
    );
    const out = await runExecutor({ transport: f.t, root: r });
    expect(out).toEqual({ commands: 3, reason: "done" });
    expect(f.results.map((x) => x.id)).toEqual(["c1", "c2", "c3"]);
    expect(f.results[0]!.r.output).toContain("A,80");
    expect(f.results[2]!.r.output).toContain("87.5");
    // write_file で1回（run_command は中身を変えないので送らない）
    expect(f.archives).toHaveLength(1);
    expect(readTarGz(f.archives[0]!).map((x) => x.path)).toEqual(["answers.csv", "avg.sh"]);
  });

  it("node_modules などは控えに入れない", async () => {
    const r = await root();
    const f = fakeTransport([cmd("run_command", { command: "mkdir -p node_modules/x && echo 1 > node_modules/x/a.js && echo ok > keep.txt" })]);
    await runExecutor({ transport: f.t, root: r });
    expect(readTarGz(f.archives.at(-1)!).map((x) => x.path)).toEqual(["keep.txt"]);
  });
});
