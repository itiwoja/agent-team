// 接続先の境界（mcp-taint.md §3.12.2、security-ops-deploy.md §3.2、BR-64・66）。登録（tools/list）・読み取り・書き込みのたびに見る。
// workspaceKind はリクエストの値を使わず、タスクのトークン（読み取り）か Intent の行（書き込み）から DB で引いた値（15:486・520）

import type { ConnectorAuth, WorkspaceKind } from "@open-team/db";

export const BOUNDARY_REASONS = ["guest_workspace"] as const;
export type BoundaryReason = (typeof BOUNDARY_REASONS)[number];

export interface BoundaryInput {
  workspaceKind: WorkspaceKind;
  /** 自分のアダプターの Google・GitHub のコネクタか（isOwnConnector。ゲストでも通す：16 §3.5・ADR-040・18 §3.5） */
  ownOAuthConnector: boolean;
}

export type BoundaryCheck = { ok: true } | { ok: false; reasonCode: BoundaryReason };

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** URL の origin（読めなければ null） */
export function originOf(url: string): string | null {
  return parse(url)?.origin ?? null;
}

/**
 * 自分の Google カレンダーのアダプターのコネクタか（16 §3.5）：auth が oauth（google）で、URL の origin が GCAL_URL と同じ。
 * GCAL_URL がなければ false。ゲストはこれだけ通す（BR-64 の例外。ADR-040）
 */
export function isOwnOAuthConnector(connector: { url: string; auth: ConnectorAuth }, gcalOrigin: string | null): boolean {
  if (gcalOrigin === null) return false;
  if (connector.auth.type !== "oauth" || connector.auth.provider !== "google") return false;
  return originOf(connector.url) === gcalOrigin;
}

/**
 * 自分の GitHub のアダプターのコネクタか（18 §3.5）：auth が oauth（github）で、URL の origin が GITHUB_URL と同じ。
 * GITHUB_URL がなければ false。ゲストもこれを通す（自分の GitHub をつないで試す：ADR-040 と同じ考え）
 */
export function isOwnGithubConnector(connector: { url: string; auth: ConnectorAuth }, githubOrigin: string | null): boolean {
  if (githubOrigin === null) return false;
  if (connector.auth.type !== "oauth" || connector.auth.provider !== "github") return false;
  return originOf(connector.url) === githubOrigin;
}

/** 本人がつないだコネクタ（Google カレンダー・GitHub）か。境界の ownOAuthConnector に渡す */
export function isOwnConnector(
  g: { gcalOrigin: string | null; githubOrigin: string | null },
  connector: { url: string; auth: ConnectorAuth },
): boolean {
  return isOwnOAuthConnector(connector, g.gcalOrigin) || isOwnGithubConnector(connector, g.githubOrigin);
}

/**
 * 境界の確認（MT §3.12.2 connectorBoundary）
 * ゲストは本人がつないだコネクタ（ownOAuthConnector の Google カレンダー・GitHub）以外は不可 → guest_workspace（BR-64）
 */
export function connectorBoundary(i: BoundaryInput): BoundaryCheck {
  if (i.workspaceKind === "guest" && !i.ownOAuthConnector) return { ok: false, reasonCode: "guest_workspace" };
  return { ok: true };
}
