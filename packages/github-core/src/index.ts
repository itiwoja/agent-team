// @open-team/github-core：本物の GitHub のコネクタの約束（18_github.md §3.1、D-119）
// アダプター（apps/github）・gateway・app が同じ定義を使う。ここは純粋な定数と関数だけ（HTTP・DB・秘密なし）

import type { ArgPath, ArgRoleMap, JsonObject, ToolClassification, ToolScope } from "@open-team/kernel";

export const GITHUB_SLUG = "github";
export const GITHUB_DISPLAY_NAME = "GitHub";
export const GITHUB_MCP_PATH = "/mcp/github";

/** gateway → アダプターのヘッダー（値は gateway が DB の行と GitHub App の鍵から作る） */
export const GITHUB_HEADER = {
  /** インストールのアクセストークン（1時間。gateway が GitHub App の鍵で作る） */
  token: "x-ot-github-token",
  /** 保護したブランチ（既定のブランチ・main・master）への書き込みを利用者が許したか（"true" のときだけ許す） */
  allowProtectedWrite: "x-ot-github-allow-protected-write",
  /** 書き込みの Intent の ID（再送で二重にしない） */
  idempotencyKey: "x-ot-idempotency-key",
} as const;

/** コミットの本文の末尾に付ける印（再送のとき、同じ Intent のコミットがもうあるかを見る） */
export const INTENT_TRAILER = "Makase-Intent";

/** 既定のブランチのほかに、いつも保護として扱う名前 */
export const ALWAYS_PROTECTED_BRANCHES = ["main", "master"] as const;

/**
 * 保護したブランチか（18 §2-5）：リポジトリの既定のブランチ、または main・master。
 * ここへの push_commit は、利用者が許したとき（allowProtectedWrite）だけ通す。PR の base にするのはいつでもよい
 */
export function isProtectedBranch(branch: string, defaultBranch: string | null): boolean {
  return branch === defaultBranch || (ALWAYS_PROTECTED_BRANCHES as readonly string[]).includes(branch);
}

/**
 * ブランチの名前として使えるか（git の check-ref-format の主な規則と、refs/ で始めないこと）。
 * 入力スキーマの pattern より厳しい（スキーマで表しにくい規則はここで見る）
 */
export function isValidBranchName(name: string): boolean {
  if (name.length < 1 || name.length > 200) return false;
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(name)) return false;
  if (name.startsWith("refs/") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("/.")) return false;
  return name !== "HEAD";
}

/** "owner/name" の形（GitHub の利用者名・リポジトリ名の文字だけ） */
export const REPO_PATTERN = "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$";

export interface GithubToolManifest {
  name: string;
  classification: ToolClassification;
  argRoles: ArgRoleMap;
  scope: ToolScope;
  verify: "none";
  /** 操作の名前（確認の行・理由の文） */
  actionNoun: string;
  units: Readonly<Record<ArgPath, string>>;
}

export interface GithubConnectorManifest {
  slug: string;
  displayName: string;
  tools: readonly GithubToolManifest[];
}

export const GITHUB_TOOL_NAMES = [
  "list_repos",
  "list_files",
  "read_file",
  "list_issues",
  "get_ci_status",
  "push_commit",
  "create_pull_request",
] as const;
export type GithubToolName = (typeof GITHUB_TOOL_NAMES)[number];

/** 1回の push_commit で書く・消すファイルの数と、1ファイルの大きさ（字） */
export const PUSH_MAX_FILES = 50;
export const PUSH_MAX_FILE_CHARS = 200_000;

const REPO: JsonObject = { type: "string", pattern: REPO_PATTERN, maxLength: 140 };
const REF: JsonObject = { type: "string", minLength: 1, maxLength: 200 };
const BRANCH: JsonObject = { type: "string", pattern: "^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$" };
const PATH: JsonObject = { type: "string", minLength: 1, maxLength: 500 };

/** ツールの入力スキーマ（tools/list でアダプターが返すもの） */
export const GITHUB_TOOL_INPUT_SCHEMAS: Readonly<Record<GithubToolName, JsonObject>> = {
  list_repos: { type: "object", properties: {}, additionalProperties: false },
  list_files: {
    type: "object",
    properties: { repo: REPO, ref: REF, path: { type: "string", maxLength: 500 } },
    required: ["repo"],
    additionalProperties: false,
  },
  read_file: {
    type: "object",
    properties: { repo: REPO, path: PATH, ref: REF },
    required: ["repo", "path"],
    additionalProperties: false,
  },
  list_issues: {
    type: "object",
    properties: { repo: REPO, state: { type: "string", enum: ["open", "closed", "all"] }, label: { type: "string", minLength: 1, maxLength: 100 } },
    required: ["repo"],
    additionalProperties: false,
  },
  get_ci_status: {
    type: "object",
    properties: { repo: REPO, ref: REF },
    required: ["repo", "ref"],
    additionalProperties: false,
  },
  push_commit: {
    type: "object",
    properties: {
      repo: REPO,
      branch: BRANCH,
      base: BRANCH,
      message: { type: "string", minLength: 1, maxLength: 2000 },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: { path: PATH, content: { type: "string", maxLength: PUSH_MAX_FILE_CHARS } },
          required: ["path", "content"],
          additionalProperties: false,
        },
        maxItems: PUSH_MAX_FILES,
      },
      delete_paths: { type: "array", items: PATH, maxItems: PUSH_MAX_FILES },
    },
    required: ["repo", "branch", "message"],
    additionalProperties: false,
  },
  create_pull_request: {
    type: "object",
    properties: {
      repo: REPO,
      head: BRANCH,
      base: BRANCH,
      title: { type: "string", minLength: 1, maxLength: 256 },
      body: { type: "string", maxLength: 20_000 },
      draft: { type: "boolean" },
    },
    required: ["repo", "head", "title"],
    additionalProperties: false,
  },
};

export const GITHUB_TOOL_DESCRIPTIONS: Readonly<Record<GithubToolName, string>> = {
  list_repos: "つないだ GitHub のリポジトリの一覧を見る（名前・既定のブランチ・公開か）",
  list_files: "リポジトリのファイルの一覧を見る（ref はブランチ・タグ・コミット。省略は既定のブランチ。path で絞れる）",
  read_file: "リポジトリのファイルの中身を読む（テキストだけ。大きいものは先頭だけ）",
  list_issues: "リポジトリのイシューを見る（PR は含まない。本文は先頭だけ）",
  get_ci_status: "ブランチ・コミットの CI（チェック）の結果を見る",
  push_commit:
    "ブランチにコミットを1つ積む（ファイルを書く・消す）。ブランチがなければ base（省略は既定のブランチ）から作る。" +
    "既定のブランチ・main・master へは、利用者が許したときだけ書ける。強制の push はしない",
  create_pull_request: "プルリクエストを出す（base の省略は既定のブランチ）。同じ head と base の開いた PR があれば、それを返す",
};

export const GITHUB_CONNECTOR: GithubConnectorManifest = {
  slug: GITHUB_SLUG,
  displayName: GITHUB_DISPLAY_NAME,
  tools: [
    { name: "list_repos", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "リポジトリの確認", units: {} },
    { name: "list_files", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "ファイルの一覧の確認", units: {} },
    { name: "read_file", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "ファイルの確認", units: {} },
    { name: "list_issues", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "イシューの確認", units: {} },
    { name: "get_ci_status", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "CI の確認", units: {} },
    {
      name: "push_commit",
      classification: "write",
      // 宛先：どのリポジトリのどのブランチか・消すファイル。中身：書くファイル・メッセージ
      argRoles: { repo: "destination", branch: "destination", base: "option", message: "content", files: "content", delete_paths: "destination" },
      scope: null,
      verify: "none",
      actionNoun: "コミットの追加",
      units: {},
    },
    {
      name: "create_pull_request",
      classification: "write",
      argRoles: { repo: "destination", base: "destination", head: "option", title: "content", body: "content", draft: "option" },
      scope: null,
      verify: "none",
      actionNoun: "プルリクエストの作成",
      units: {},
    },
  ],
};

/** コミットの本文の末尾の印（"Makase-Intent: <uuid>"） */
export function intentTrailerOf(intentId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(intentId)) throw new Error("intentId は UUID であること");
  return `${INTENT_TRAILER}: ${intentId.toLowerCase()}`;
}
