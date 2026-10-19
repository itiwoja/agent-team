import { validateArgRoleKeys } from "@open-team/kernel";
import { describe, expect, it } from "vitest";
import {
  GITHUB_CONNECTOR,
  GITHUB_TOOL_DESCRIPTIONS,
  GITHUB_TOOL_INPUT_SCHEMAS,
  GITHUB_TOOL_NAMES,
  REPO_PATTERN,
  intentTrailerOf,
  isProtectedBranch,
  isValidBranchName,
} from "./index.ts";

describe("github-core", () => {
  it("manifest・スキーマ・説明のツールがそろっている", () => {
    expect(GITHUB_CONNECTOR.tools.map((t) => t.name)).toEqual([...GITHUB_TOOL_NAMES]);
    for (const name of GITHUB_TOOL_NAMES) {
      expect(GITHUB_TOOL_INPUT_SCHEMAS[name]).toBeDefined();
      expect(GITHUB_TOOL_DESCRIPTIONS[name]).not.toBe("");
    }
  });

  it("引数の役割が入力スキーマのキーと合う", () => {
    for (const t of GITHUB_CONNECTOR.tools) {
      expect(validateArgRoleKeys(GITHUB_TOOL_INPUT_SCHEMAS[t.name as keyof typeof GITHUB_TOOL_INPUT_SCHEMAS], t.argRoles)).toEqual({ ok: true });
    }
  });

  it("書き込みは push_commit と create_pull_request だけで、どちらもリポジトリが宛先", () => {
    const writes = GITHUB_CONNECTOR.tools.filter((t) => t.classification === "write");
    expect(writes.map((t) => t.name)).toEqual(["push_commit", "create_pull_request"]);
    for (const t of writes) expect(t.argRoles.repo).toBe("destination");
    expect(writes[0]!.argRoles.branch).toBe("destination");
    expect(writes[1]!.argRoles.base).toBe("destination");
  });

  it("保護したブランチ：既定のブランチ・main・master", () => {
    expect(isProtectedBranch("main", "develop")).toBe(true);
    expect(isProtectedBranch("master", null)).toBe(true);
    expect(isProtectedBranch("develop", "develop")).toBe(true);
    expect(isProtectedBranch("makase/fix-1", "main")).toBe(false);
  });

  it("ブランチの名前の規則", () => {
    expect(isValidBranchName("makase/fix-readme")).toBe(true);
    for (const bad of ["", "refs/heads/main", "a..b", "a//b", "a/", "a.lock", "HEAD", "-x", "a b", "a/.b"]) expect(isValidBranchName(bad)).toBe(false);
  });

  it("リポジトリの形", () => {
    const re = new RegExp(REPO_PATTERN);
    expect(re.test("itiwoja/open-team")).toBe(true);
    expect(re.test("a/b.c_d-e")).toBe(true);
    expect(re.test("open-team")).toBe(false);
    expect(re.test("../x")).toBe(false);
  });

  it("コミットの印は UUID だけ", () => {
    expect(intentTrailerOf("01234567-89AB-cdef-0123-456789abcdef")).toBe("Makase-Intent: 01234567-89ab-cdef-0123-456789abcdef");
    expect(() => intentTrailerOf("x")).toThrow();
  });
});
