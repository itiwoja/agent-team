// 作業場（サンドボックス）と sandbox-edge のやりとりの形（D-116）。
// 作業場は edge が判定済みのコマンドだけを受け取り、実行して結果を返す（LLM は呼べない。トークンはその作業場だけのもの）。
// 流れ：claim（最初の中身を受け取る）→ next（コマンドを待つ）→ result（結果を返す）→ archive（ファイルの控えを送る）→ next … → done

/** 作業場で動かせる道具（Kernel のカタログの名前のまま） */
export const SANDBOX_TOOL_NAMES = ["list_files", "read_file", "search", "write_file", "delete_file", "run_command"] as const;
export type SandboxToolName = (typeof SANDBOX_TOOL_NAMES)[number];

/** ファイルを書き換える道具（実行のあとに控えを送り直す） */
export const MUTATING_TOOLS: ReadonlySet<SandboxToolName> = new Set(["write_file", "delete_file", "run_command"]);

/** 上限（作業場と edge で同じ値を使う） */
export type SandboxLimits = Record<
  | "commandTimeoutSec"
  | "commandTimeoutMaxSec"
  | "outputMaxChars"
  | "readMaxChars"
  | "writeMaxChars"
  | "listMaxEntries"
  | "searchMaxMatches"
  | "archiveMaxBytes"
  | "nextWaitSec"
  | "idleExitSec",
  number
>;

export const SANDBOX_LIMITS: Readonly<SandboxLimits> = {
  /** 1つのコマンドの既定の時間（秒）と上限 */
  commandTimeoutSec: 120,
  commandTimeoutMaxSec: 300,
  /** 結果の文字数（超えたら末尾を残して切る） */
  outputMaxChars: 20_000,
  /** read_file で返す文字数 */
  readMaxChars: 100_000,
  /** write_file で書ける文字数 */
  writeMaxChars: 1_000_000,
  /** list_files・search で返す件数 */
  listMaxEntries: 500,
  searchMaxMatches: 200,
  /** ファイルの控え（tar.gz）の大きさ */
  archiveMaxBytes: 10 * 1024 * 1024,
  /** next の長い待ち（秒） */
  nextWaitSec: 20,
  /** コマンドが来ないまま作業場を閉じるまで（秒） */
  idleExitSec: 600,
};

/** 控えに入れないディレクトリ（入れたパッケージ・キャッシュは次の作業場で入れ直す） */
export const ARCHIVE_EXCLUDE_DIRS: readonly string[] = ["node_modules", ".git", ".cache", "__pycache__", ".venv", ".npm", ".pnpm-store", ".local"];

export interface SandboxCommand {
  id: string;
  tool: SandboxToolName;
  args: Record<string, unknown>;
}

export interface ClaimResponse {
  taskId: string;
  /** 最初の中身（担当の前回の控え・パックのファイル）。なければ null */
  archiveBase64: string | null;
}

export type NextResponse = { kind: "command"; command: SandboxCommand } | { kind: "idle" } | { kind: "done" };

export interface CommandResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
}

/** 作業場から sandbox-edge への口（本番は HTTP、試験・手元は関数を直に呼ぶ） */
export interface SandboxTransport {
  claim(): Promise<ClaimResponse>;
  next(waitSec: number): Promise<NextResponse>;
  result(commandId: string, r: CommandResult): Promise<void>;
  archive(archive: Buffer, meta: { files: number; bytes: number }): Promise<void>;
}
