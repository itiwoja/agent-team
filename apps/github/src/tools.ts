// 7つのツールの中身（18 §3.1）。入力は zod で確かめ（GITHUB_TOOL_INPUT_SCHEMAS と同じ形）、GitHub へは github.ts のクライアントだけを使う。
// 結果の形：成功は structuredContent、入力の誤り・GitHub の4xx は isError の結果（ツールの結果として返す）。
// 401・429・5xx は投げる（mcp.ts が HTTP の状態コードにする）。
// 決めたこと：
// - 保護したブランチ（既定のブランチ・main・master）への push_commit は、利用者が許したとき（allowProtectedWrite）だけ（18 §2-5）
// - 強制の push はしない（ref の更新は早送りだけ）。ブランチの削除・マージ・リリースはツールに無い（01 §Won't）
// - push_commit は Intent の ID をコミットの本文の印（Makase-Intent）に入れ、再送で同じ印のコミットが先頭にあれば成功として返す
// - create_pull_request は同じ head と base の開いた PR があれば、それを返す（再送で二重にしない）

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  GITHUB_TOOL_NAMES,
  PUSH_MAX_FILE_CHARS,
  PUSH_MAX_FILES,
  REPO_PATTERN,
  intentTrailerOf,
  isProtectedBranch,
  isValidBranchName,
  type GithubToolName,
} from "@open-team/github-core";
import { GithubApiError, type ContentFile, type GithubClient, type Issue, type TreeWrite } from "./github.ts";

export { GITHUB_TOOL_NAMES, type GithubToolName };

/** read_file で返す中身の上限（字） */
export const READ_MAX_CHARS = 100_000;
/** list_files で返すファイルの数の上限 */
export const LIST_FILES_MAX = 1000;
/** イシューの本文の上限（字） */
export const ISSUE_BODY_MAX_CHARS = 2000;

const Repo = z.string().max(140).regex(new RegExp(REPO_PATTERN), "owner/name の形");
const Ref = z.string().min(1).max(200);
const Branch = z.string().refine(isValidBranchName, "ブランチの名前として使えない");

/** リポジトリの中の相対パス（/ で始めない・.. や .git を含まない） */
function isRepoPath(p: string): boolean {
  if (p.length < 1 || p.length > 500 || p.startsWith("/") || p.endsWith("/")) return false;
  const parts = p.split("/");
  return parts.every((s) => s !== "" && s !== "." && s !== ".." && s !== ".git") && !/[\u0000-\u001f]/.test(p);
}
const RepoPath = z.string().refine(isRepoPath, "リポジトリの中の相対パス");

const ListFilesInput = z.strictObject({ repo: Repo, ref: Ref.optional(), path: z.string().max(500).optional() });
const ReadFileInput = z.strictObject({ repo: Repo, path: RepoPath, ref: Ref.optional() });
const ListIssuesInput = z.strictObject({ repo: Repo, state: z.enum(["open", "closed", "all"]).default("open"), label: z.string().min(1).max(100).optional() });
const CiStatusInput = z.strictObject({ repo: Repo, ref: Ref });
const PushCommitInput = z
  .strictObject({
    repo: Repo,
    branch: Branch,
    base: Branch.optional(),
    message: z.string().min(1).max(2000),
    files: z.array(z.strictObject({ path: RepoPath, content: z.string().max(PUSH_MAX_FILE_CHARS) })).max(PUSH_MAX_FILES).default([]),
    delete_paths: z.array(RepoPath).max(PUSH_MAX_FILES).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.files.length === 0 && v.delete_paths.length === 0) ctx.addIssue({ code: "custom", path: ["files"], message: "書くか消すファイルが1つは要る" });
    const paths = [...v.files.map((f) => f.path), ...v.delete_paths];
    if (new Set(paths).size !== paths.length) ctx.addIssue({ code: "custom", path: ["files"], message: "同じパスが2回ある" });
  });
const CreatePullInput = z.strictObject({
  repo: Repo,
  head: Branch,
  base: Branch.optional(),
  title: z.string().min(1).max(256),
  body: z.string().max(20_000).default(""),
  draft: z.boolean().default(false),
});

/** ツールの呼び出しの文脈（mcp.ts がヘッダーから作る） */
export interface ToolContext {
  github: GithubClient;
  /** 保護したブランチへの書き込みを利用者が許したか（x-ot-github-allow-protected-write） */
  allowProtectedWrite: boolean;
  /** 書き込みの Intent の ID（x-ot-idempotency-key。push_commit だけ要る、UUID） */
  idempotencyKey: string | null;
}

const okResult = (value: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});

const toolError = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** zod の誤りを1行の日本語にする（どの欄か・何がだめかだけ。値は返さない） */
function inputError(error: z.ZodError): CallToolResult {
  const first = error.issues[0];
  const field = first && first.path.length > 0 ? first.path.join(".") : "入力";
  return toolError(`入力が正しくありません（${field}：${first?.message ?? "形が違う"}）`);
}

/** 4xx は結果の文に（GitHub の message を添える）、それ以外は投げ直す */
function githubFailure(e: unknown, text: string): CallToolResult {
  if (e instanceof GithubApiError) {
    if (e.status === 404) return toolError(`${text}（見つかりません。リポジトリが GitHub App の対象に入っているか、名前・ブランチ・パスを確かめてください）`);
    return toolError(`${text}（${e.status}${e.apiMessage ? `：${e.apiMessage}` : ""}）`);
  }
  throw e;
}

/** 文字列の先頭から max 字（コードポイント単位） */
function clip(s: string, max: number): { text: string; truncated: boolean } {
  const chars = [...s];
  return chars.length <= max ? { text: s, truncated: false } : { text: chars.slice(0, max).join(""), truncated: true };
}

export const PROTECTED_BRANCH_TEXT =
  "は保護したブランチなので、直接は書けません（利用者が「main への書き込みを許可」をオンにしたときだけ書けます）。" +
  "別のブランチ（例：makase/<内容>）に push_commit で積み、create_pull_request で PR を出してください。";

export async function callGithubTool(name: GithubToolName, args: unknown, ctx: ToolContext): Promise<CallToolResult> {
  switch (name) {
    case "list_repos": {
      const parsed = z.strictObject({}).safeParse(args ?? {});
      if (!parsed.success) return inputError(parsed.error);
      try {
        const r = await ctx.github.listInstallationRepos();
        return okResult({
          repos: r.repos.map((x) => ({ repo: x.full_name, default_branch: x.default_branch, private: x.private, description: x.description ?? null })),
          truncated: r.truncated,
        });
      } catch (e) {
        return githubFailure(e, "リポジトリの一覧を読めませんでした");
      }
    }

    case "list_files": {
      const parsed = ListFilesInput.safeParse(args ?? {});
      if (!parsed.success) return inputError(parsed.error);
      const input = parsed.data;
      try {
        const ref = input.ref ?? (await ctx.github.getRepo(input.repo)).default_branch;
        const prefix = (input.path ?? "").replace(/^\/+|\/+$/g, "");
        const tree = await ctx.github.getTree(input.repo, ref);
        const files = tree.tree.filter((t) => t.type === "blob" && (prefix === "" || t.path === prefix || t.path.startsWith(`${prefix}/`)));
        return okResult({
          repo: input.repo,
          ref,
          files: files.slice(0, LIST_FILES_MAX).map((f) => ({ path: f.path, size: f.size ?? null })),
          truncated: tree.truncated || files.length > LIST_FILES_MAX,
        });
      } catch (e) {
        return githubFailure(e, "ファイルの一覧を読めませんでした");
      }
    }

    case "read_file": {
      const parsed = ReadFileInput.safeParse(args ?? {});
      if (!parsed.success) return inputError(parsed.error);
      const input = parsed.data;
      try {
        const got = await ctx.github.getContent(input.repo, input.path, input.ref ?? null);
        if (Array.isArray(got)) return toolError("フォルダです。中身の一覧は list_files で見てください");
        const file = got as ContentFile;
        if (file.type !== "file") return toolError("ファイルではありません（シンボリックリンク・サブモジュールは読めません）");
        if (file.encoding !== "base64" || typeof file.content !== "string") return toolError("大きすぎて読めません（1MB まで）");
        const text = Buffer.from(file.content, "base64").toString("utf8");
        if (text.includes("\u0000")) return toolError("テキストのファイルではありません（バイナリは読めません）");
        const c = clip(text, READ_MAX_CHARS);
        return okResult({ repo: input.repo, path: file.path, ref: input.ref ?? null, sha: file.sha, content: c.text, ...(c.truncated ? { truncated: true } : {}) });
      } catch (e) {
        return githubFailure(e, "ファイルを読めませんでした");
      }
    }

    case "list_issues": {
      const parsed = ListIssuesInput.safeParse(args ?? {});
      if (!parsed.success) return inputError(parsed.error);
      const input = parsed.data;
      try {
        const issues = (await ctx.github.listIssues(input.repo, input.state, input.label ?? null)).filter((i) => i.pull_request === undefined);
        return okResult({ repo: input.repo, issues: issues.map(issueView) });
      } catch (e) {
        return githubFailure(e, "イシューを読めませんでした");
      }
    }

    case "get_ci_status": {
      const parsed = CiStatusInput.safeParse(args ?? {});
      if (!parsed.success) return inputError(parsed.error);
      const input = parsed.data;
      try {
        const [runs, status] = await Promise.all([ctx.github.checkRuns(input.repo, input.ref), ctx.github.combinedStatus(input.repo, input.ref)]);
        return okResult({
          repo: input.repo,
          ref: input.ref,
          overall: overallOf(runs.runs, status),
          check_runs: runs.runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, html_url: r.html_url ?? null })),
          statuses: status.statuses.map((s) => ({ context: s.context, state: s.state, target_url: s.target_url ?? null })),
        });
      } catch (e) {
        return githubFailure(e, "CI の結果を読めませんでした");
      }
    }

    case "push_commit": {
      const parsed = PushCommitInput.safeParse(args ?? {});
      if (!parsed.success) return inputError(parsed.error);
      const input = parsed.data;
      if (ctx.idempotencyKey === null) return toolError("コミットに必要な識別子がありません");
      const trailer = intentTrailerOf(ctx.idempotencyKey);
      try {
        const repo = await ctx.github.getRepo(input.repo);
        if (isProtectedBranch(input.branch, repo.default_branch) && !ctx.allowProtectedWrite) return toolError(`「${input.branch}」${PROTECTED_BRANCH_TEXT}`);

        let parentSha = await ctx.github.getBranchSha(input.repo, input.branch);
        const createBranch = parentSha === null;
        if (parentSha === null) {
          const baseName = input.base ?? repo.default_branch;
          parentSha = await ctx.github.getBranchSha(input.repo, baseName);
          if (parentSha === null) return toolError(`元にするブランチ「${baseName}」がありません`);
        }
        const parent = await ctx.github.getCommit(input.repo, parentSha);
        // 再送：同じ Intent のコミットがもう先頭にある（ブランチを作ったあと・進めたあとの再送）
        if (!createBranch && parent.message.split("\n").some((l) => l.trim() === trailer)) {
          return okResult(commitView(input.repo, input.branch, parent, false, input.files.length, input.delete_paths.length, true));
        }
        const entries: TreeWrite[] = [
          ...input.files.map((f): TreeWrite => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
          ...input.delete_paths.map((p): TreeWrite => ({ path: p, mode: "100644", type: "blob", sha: null })),
        ];
        const tree = await ctx.github.createTree(input.repo, parent.tree.sha, entries);
        const commit = await ctx.github.createCommit(input.repo, `${input.message.trimEnd()}\n\n${trailer}`, tree, [parentSha]);
        try {
          if (createBranch) await ctx.github.createBranch(input.repo, input.branch, commit.sha);
          else await ctx.github.updateBranch(input.repo, input.branch, commit.sha);
        } catch (e) {
          if (e instanceof GithubApiError && e.status === 422) {
            return toolError(`ブランチ「${input.branch}」を進められませんでした（ほかの変更が先に入りました。もう一度 push_commit してください）`);
          }
          throw e;
        }
        return okResult(commitView(input.repo, input.branch, commit, createBranch, input.files.length, input.delete_paths.length, false));
      } catch (e) {
        return githubFailure(e, "コミットを積めませんでした");
      }
    }

    case "create_pull_request": {
      const parsed = CreatePullInput.safeParse(args ?? {});
      if (!parsed.success) return inputError(parsed.error);
      const input = parsed.data;
      try {
        const base = input.base ?? (await ctx.github.getRepo(input.repo)).default_branch;
        if (base === input.head) return toolError("head と base が同じです（変更を積んだブランチを head にしてください）");
        const existing = await ctx.github.findOpenPull(input.repo, input.head, base);
        if (existing) return okResult({ repo: input.repo, number: existing.number, html_url: existing.html_url, draft: existing.draft === true, base, head: input.head, already_existed: true });
        const pr = await ctx.github.createPull(input.repo, { head: input.head, base, title: input.title, body: input.body, draft: input.draft });
        return okResult({ repo: input.repo, number: pr.number, html_url: pr.html_url, draft: pr.draft === true, base, head: input.head });
      } catch (e) {
        return githubFailure(e, "プルリクエストを出せませんでした");
      }
    }
  }
}

function commitView(repo: string, branch: string, c: { sha: string; html_url?: string }, created: boolean, written: number, deleted: number, alreadyExisted: boolean) {
  return {
    repo,
    branch,
    commit_sha: c.sha,
    html_url: c.html_url ?? null,
    created_branch: created,
    files_written: written,
    files_deleted: deleted,
    ...(alreadyExisted ? { already_existed: true } : {}),
  };
}

function issueView(i: Issue) {
  const body = clip(i.body ?? "", ISSUE_BODY_MAX_CHARS);
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter((l) => l !== ""),
    author: i.user?.login ?? null,
    created_at: i.created_at ?? null,
    html_url: i.html_url,
    body: body.text,
    ...(body.truncated ? { body_truncated: true } : {}),
  };
}

const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);

/** チェックとステータスをまとめた結果（success・failure・pending・none） */
export function overallOf(runs: ReadonlyArray<{ status: string; conclusion: string | null }>, status: { state: string; statuses: readonly unknown[] }): "success" | "failure" | "pending" | "none" {
  const hasStatuses = status.statuses.length > 0;
  if (runs.length === 0 && !hasStatuses) return "none";
  if (runs.some((r) => r.conclusion !== null && FAILED_CONCLUSIONS.has(r.conclusion)) || (hasStatuses && (status.state === "failure" || status.state === "error"))) {
    return "failure";
  }
  if (runs.some((r) => r.status !== "completed") || (hasStatuses && status.state === "pending")) return "pending";
  return "success";
}
