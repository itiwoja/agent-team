// 呼び出し元の確認（16 §3.2、security-ops-deploy.md §3.11）。MCP を呼べるのは sa-gateway だけ（sim-world の mcp と同じ）。
// 確かめ方は packages/platform の createServiceAuth（gateway・sim-world と同じ）。拒否は 403 FORBIDDEN（理由はログにだけ）

import { CALLER_HEADER, type ServiceCaller } from "@open-team/platform";

export { CALLER_HEADER };

/** gcal を呼べるもの（16 §3.2：sa-gateway だけ） */
export const GCAL_CALLERS = ["sa-gateway"] as const satisfies readonly ServiceCaller[];
