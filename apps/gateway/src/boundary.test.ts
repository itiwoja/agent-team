// 接続先の境界（MT §3.12.2・§6.9、SO §3.2・§7.2、BR-64）：ゲストは本人がつないだ OAuth のコネクタ以外は不可
import { describe, expect, it } from "vitest";
import { BOUNDARY_REASONS, connectorBoundary, isOwnConnector, isOwnGithubConnector, isOwnOAuthConnector, originOf } from "./boundary.ts";

const GCAL = "https://gcal.example";
const GH = "https://github-adapter.example";
const GOOGLE = { type: "oauth", provider: "google" } as const;
const GITHUB = { type: "oauth", provider: "github" } as const;

describe("connectorBoundary", () => {
  it("理由は guest_workspace だけ", () => {
    expect(BOUNDARY_REASONS).toEqual(["guest_workspace"]);
  });
  it("SO-BD-05 ゲスト・本人の OAuth でないコネクタ → guest_workspace", () => {
    expect(connectorBoundary({ workspaceKind: "guest", ownOAuthConnector: false })).toEqual({ ok: false, reasonCode: "guest_workspace" });
  });
  it("ゲストでも本人がつないだ Google カレンダー・GitHub は通す（ADR-040）", () => {
    expect(connectorBoundary({ workspaceKind: "guest", ownOAuthConnector: true })).toEqual({ ok: true });
  });
  it("オーナーはどのコネクタも使える", () => {
    expect(connectorBoundary({ workspaceKind: "owner", ownOAuthConnector: false })).toEqual({ ok: true });
    expect(connectorBoundary({ workspaceKind: "owner", ownOAuthConnector: true })).toEqual({ ok: true });
  });
});

describe("originOf", () => {
  it("読めなければ null", () => {
    expect(originOf(`${GCAL}/mcp/x`)).toBe(GCAL);
    expect(originOf("nope")).toBeNull();
  });
});

describe("本人のコネクタの判定（16 §3.5・18 §3.5）", () => {
  it("isOwnOAuthConnector：oauth（google）で origin が GCAL_URL と同じときだけ", () => {
    expect(isOwnOAuthConnector({ url: `${GCAL}/mcp/gcal`, auth: GOOGLE }, GCAL)).toBe(true);
    expect(isOwnOAuthConnector({ url: "https://other.example/mcp/gcal", auth: GOOGLE }, GCAL)).toBe(false);
    expect(isOwnOAuthConnector({ url: `${GCAL}/mcp/gcal`, auth: { type: "none" } }, GCAL)).toBe(false);
    expect(isOwnOAuthConnector({ url: `${GCAL}/mcp/gcal`, auth: GITHUB }, GCAL)).toBe(false);
    expect(isOwnOAuthConnector({ url: `${GCAL}/mcp/gcal`, auth: GOOGLE }, null)).toBe(false);
  });
  it("isOwnGithubConnector：oauth（github）で origin が GITHUB_URL と同じときだけ", () => {
    expect(isOwnGithubConnector({ url: `${GH}/mcp/github`, auth: GITHUB }, GH)).toBe(true);
    expect(isOwnGithubConnector({ url: `${GH}/mcp/github`, auth: GOOGLE }, GH)).toBe(false);
    expect(isOwnGithubConnector({ url: "https://evil.example/mcp/github", auth: GITHUB }, GH)).toBe(false);
    expect(isOwnGithubConnector({ url: `${GH}/mcp/github`, auth: GITHUB }, null)).toBe(false);
  });
  it("isOwnConnector：どちらかなら true。ゲストで origin が違う oauth は guest_workspace", () => {
    const g = { gcalOrigin: GCAL, githubOrigin: GH };
    expect(isOwnConnector(g, { url: `${GCAL}/mcp/gcal`, auth: GOOGLE })).toBe(true);
    expect(isOwnConnector(g, { url: `${GH}/mcp/github`, auth: GITHUB })).toBe(true);
    const other = isOwnConnector(g, { url: "http://other-gcal.example/mcp/gcal", auth: GOOGLE });
    expect(other).toBe(false);
    expect(connectorBoundary({ workspaceKind: "guest", ownOAuthConnector: other })).toEqual({ ok: false, reasonCode: "guest_workspace" });
  });
});
