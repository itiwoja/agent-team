// @open-team/gcal：本物の Google カレンダーのアダプター（16 §3.2、D-113、ADR-040）
// DB・秘密は持たない。gateway からの呼び出し（sa-gateway）に付いたアクセストークンで、その1回だけ Calendar API を呼ぶ
export { createApp, BODY_LIMIT_BYTES, type GcalDeps } from "./app.ts";
export { readGcalEnv, serviceAuthConfigOf, DEFAULT_GOOGLE_CALENDAR_API_BASE, type GcalEnv } from "./env.ts";
export { GCAL_CALLERS, CALLER_HEADER } from "./auth.ts";
export { handleMcpPost, mcpMethodNotAllowed, readCallHeaders, MCP_SERVER_INFO, type McpDeps, type GcalCallHeaders } from "./mcp.ts";
export { callGcalTool, GCAL_TOOL_NAMES, type GcalToolName, type ToolContext } from "./tools.ts";
export { createCalendarClient, GoogleAuthError, GoogleApiError, GoogleUpstreamError, type CalendarClient } from "./calendar.ts";
export { freeSlots, toRfc3339, wallToEpoch, offsetMsAt, isValidTimeZone, MAX_SLOTS } from "./slots.ts";
export { gcalLogger } from "./log.ts";
