// @open-team/gateway：書き込みの唯一の出口（15:445。mcp-taint.md §3.12、intents-approvals.md §3.12・3.17、api-surface.md §3.17）。
// EP-49 読み取り・EP-50 書き込みの実行・EP-51 ツールの同期。呼べるのは sa-app だけ。DB は ot_gateway のロール。
// 型とクライアントは @open-team/gateway-client（凍結の契約）
export { createApp, createGateway, ToolsCallBody, BODY_LIMIT_BYTES, TASK_TOKEN_HEADER, type GatewayApp } from "./app.ts";
export {
  assertGatewayEnv,
  readGatewayEnv,
  normalizeConnectorUrl,
  assertAllowedConnectorUrls,
  readProjectNumber,
  simWorldUrlNeedsProjectNumber,
  GatewayStartupError,
  type GatewayEnv,
  type GcalConfig,
  type AllowedConnectorInput,
} from "./env.ts";
export {
  connectorBoundary,
  effectiveConnectorUrl,
  SIM_GCAL_PATH,
  isSimWorldUrl,
  isOwnOAuthConnector,
  isOwnGithubConnector,
  isOwnConnector,
  originOf,
  BOUNDARY_REASONS,
  type BoundaryReason,
  type BoundaryInput,
  type BoundaryCheck,
} from "./boundary.ts";
export {
  resolveContext,
  defaultConnectorAuth,
  simHeadersOf,
  targetFor,
  abortableSleep,
  ConnectorAuthUnsupported,
  ConnectorAuthRequired,
  ConnectorTokenUnavailable,
  GOOGLE_TOKEN_URL,
  SIM_HEADER,
  PRESEND_BACKOFF_MS,
  type GatewayDeps,
  type GatewayContext,
  type ConnectorAuthProvider,
  type ConnectorAuthRequest,
  type SimCallContext,
} from "./context.ts";
export {
  openMcpSession,
  describeFailure,
  isPresendNetworkError,
  networkCodeOf,
  MCP_CALL_TIMEOUT_MS,
  MCP_LIST_TIMEOUT_MS,
  MCP_CLIENT_INFO,
  type McpSession,
  type McpTarget,
  type McpToolDef,
  type McpFailure,
  type CallOutcome,
} from "./mcp.ts";
export { toolResultText, truncateUtf8, maskAndLimit, RESULT_MAX_BYTES } from "./result-text.ts";
export { checkToolDrift, sameDefinition, applyToolChange, type DriftResult } from "./tool-change.ts";
export { callReadTool } from "./reads.ts";
export { executeIntent, responseOf, intentIntegrityOk } from "./execute.ts";
export { syncConnectorTools, TOOL_NAME_PATTERN } from "./sync.ts";
export { isUuid } from "./ids.ts";
export {
  checkProvenance,
  judgeProvenance,
  judgeKernelEvidence,
  decisionRowMatches,
  provenanceApplies,
  PROVENANCE_REASON,
  PROVENANCE_FAILURES,
  type ProvenanceFailure,
  type ProvenanceResult,
  type ProvenanceEvidence,
  type ProvenanceInput,
  type ProvenanceIntent,
} from "./provenance.ts";
