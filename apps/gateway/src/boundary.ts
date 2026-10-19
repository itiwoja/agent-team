// 接続先の境界（mcp-taint.md §3.12.2、security-ops-deploy.md §3.2、BR-63・64・66・67②）。登録（tools/list）・読み取り・書き込みのたびに見る。
// 上から順に、最初に当たったものを返す：public → guest → shadow → rehearsal（cross-check §1.7。E2E が public_deployment を求めるので BR-66 が先）。
// workspaceKind・rehearsalRunId・shadow はリクエストの値を使わず、タスクのトークン（読み取り）か Intent の行（書き込み）から DB で引いた値（15:486・520）

import type { DeploymentMode } from "@open-team/platform";
import type { ConnectorAuth, WorkspaceKind } from "@open-team/db";

export const BOUNDARY_REASONS = ["public_deployment", "guest_workspace", "shadow_real_connector", "rehearsal_real_connector"] as const;
export type BoundaryReason = (typeof BOUNDARY_REASONS)[number];

export interface BoundaryInput {
  deploymentMode: DeploymentMode;
  /** ALLOWED_CONNECTOR_URLS の origin（cloud で使う） */
  allowedOrigins: readonly string[];
  /** SIM_WORLD_URL の origin（なければどの URL も sim-world ではない） */
  simWorldOrigin: string | null;
  workspaceKind: WorkspaceKind;
  rehearsalRunId: string | null;
  shadow: boolean;
  connectorUrl: string;
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
 * sim-world のコネクタの URL か（MT §3.12.2 の isSimWorldUrl）：origin が SIM_WORLD_URL と同じで、パスが /mcp/ で始まる。
 * 認証情報（user:pass@）つきは sim-world として扱わない
 */
export function isSimWorldUrl(url: string, simWorldOrigin: string | null): boolean {
  if (simWorldOrigin === null) return false;
  const u = parse(url);
  if (!u || u.username !== "" || u.password !== "") return false;
  return u.origin === simWorldOrigin && u.pathname.startsWith("/mcp/");
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
 * GITHUB_URL がなければ false。ゲストもこれを通す（自分の GitHub をつないで試す：ADR-040 と同じ考え）。
 * 模擬の GitHub はないので、リハーサル・影では向け直さず、規則3・4 で拒否される
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
 * 模擬の Google カレンダーの経路（16 §6.1・§6.4）。sim-core の SIM_GCAL_PATH と同じ値にすること。
 * gateway の本番の依存は sim-core を使えない（.dependency-cruiser.cjs の not-to-dev-dep）ので写している。試験（boundary.test.ts）で一致を確かめる
 */
export const SIM_GCAL_PATH = "/mcp/shop/gcal";

/**
 * リハーサル・影の走行で、本人の Google カレンダーのコネクタを模擬（SIM_WORLD_URL + SIM_GCAL_PATH）へ向け直す先（16 §6.1）。
 * 対象は rehearsalRunId か shadow のタスク、かつ isOwnOAuthConnector のコネクタ、かつ SIM_WORLD_URL があるとき。
 * それ以外は connector.url のまま（SIM_WORLD_URL がなければ差し替えず、規則3・4 で拒否される）。
 * 差し替えた URL は境界の確認と targetFor にだけ渡す。コネクタの行（URL・認証）は変えない
 */
export function effectiveConnectorUrl(
  g: { simWorldUrl: string | null; gcalOrigin: string | null },
  connector: { url: string; auth: ConnectorAuth },
  run: { rehearsalRunId: string | null; shadow: boolean },
): string {
  if (!(run.rehearsalRunId !== null || run.shadow)) return connector.url;
  if (g.simWorldUrl === null || !isOwnOAuthConnector(connector, g.gcalOrigin)) return connector.url;
  return `${g.simWorldUrl.replace(/\/+$/, "")}${SIM_GCAL_PATH}`;
}

/**
 * 境界の確認（MT §3.12.2 connectorBoundary）
 * 1 cloud（公開デプロイ）で origin が ALLOWED_CONNECTOR_URLS にない → public_deployment（BR-66。ワークスペースの種類によらない）
 * 2 ゲストで sim-world 以外（ownOAuthConnector の Google カレンダー・GitHub は通す）→ guest_workspace（BR-64）
 * 3 影で sim-world 以外 → shadow_real_connector（BR-67②）
 * 4 リハーサルの走行で sim-world 以外 → rehearsal_real_connector（BR-63）
 * 読めない URL は sim-world でも許可の一覧でもないものとして扱う（閉じた側）
 */
export function connectorBoundary(i: BoundaryInput): BoundaryCheck {
  const origin = originOf(i.connectorUrl);
  if (i.deploymentMode === "cloud" && (origin === null || !i.allowedOrigins.includes(origin))) {
    return { ok: false, reasonCode: "public_deployment" };
  }
  const sim = isSimWorldUrl(i.connectorUrl, i.simWorldOrigin);
  if (i.workspaceKind === "guest" && !sim && !i.ownOAuthConnector) return { ok: false, reasonCode: "guest_workspace" };
  if (i.shadow && !sim) return { ok: false, reasonCode: "shadow_real_connector" };
  if (i.rehearsalRunId !== null && !sim) return { ok: false, reasonCode: "rehearsal_real_connector" };
  return { ok: true };
}
