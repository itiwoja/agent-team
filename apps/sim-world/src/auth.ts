// 呼び出し元の確認（security-ops-deploy.md §3.9・§3.11、M-44）。MCP は sa-gateway だけ、管理 API は sa-app だけ（15:484・521）。
// 確かめ方は packages/platform の createServiceAuth（gateway・app と同じ）：
//   共有トークン（INTERNAL_SHARED_TOKEN を Authorization: Bearer）＋呼び出し元の名前のヘッダー x-ot-caller（G-11）
// 呼ぶ側は platform の serviceAuthHeaders(caller, url) をそのまま使う。拒否は 403 FORBIDDEN（理由はログにだけ）

import { CALLER_HEADER, type ServiceAuthConfig, type ServiceCaller } from "@open-team/platform";
import type { SimWorldEnv } from "./env.ts";

export { CALLER_HEADER };

/** sim-world を呼ぶもの（15:490。sa-sim は誰も呼ばない） */
export const SIM_CALLERS = ["sa-gateway", "sa-app"] as const satisfies readonly ServiceCaller[];
export type SimCaller = (typeof SIM_CALLERS)[number];

/** sim-world の操作（M-44：SO の authorizeSimCaller の操作名を管理 API（SW §4.1.3）の操作に合わせた） */
export const SIM_OPERATIONS = [
  "mcp",
  "admin_create",
  "admin_fork",
  "admin_advance",
  "admin_damage",
  "admin_web",
  "admin_view",
  "admin_snapshot",
  "admin_demo_store",
  "admin_cleanup",
] as const;
export type SimOperation = (typeof SIM_OPERATIONS)[number];

/** SO §3.11 の表：その操作を呼べる呼び出し元。mcp（読み取りも書き込みも）は sa-gateway だけ、管理の操作は sa-app だけ */
export function allowedCallersOf(op: SimOperation): readonly SimCaller[] {
  return op === "mcp" ? ["sa-gateway"] : ["sa-app"];
}

export function authorizeSimCaller(op: SimOperation, caller: SimCaller): boolean {
  return allowedCallersOf(op).includes(caller);
}

/** env から platform のサービス間の認証の設定を作る（共有トークン） */
export function serviceAuthConfigOf(env: Pick<SimWorldEnv, "sharedToken">): ServiceAuthConfig {
  return { sharedToken: env.sharedToken };
}
