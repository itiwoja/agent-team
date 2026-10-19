// @open-team/sim-world：模擬の世界の MCP サーバーと管理 API（sim-world-rehearsal.md §4.1）
// 世界の中身（純粋関数）は @open-team/sim-core。ここは HTTP・MCP・保存（Postgres／メモリ）・呼び出し元の確認
export { createApp, adminOperationOf, BODY_LIMIT_BYTES, type SimWorldDeps } from "./app.ts";
export { readSimWorldEnv, MIN_SHARED_TOKEN_LENGTH, type SimWorldEnv, type SimDeploymentMode } from "./env.ts";
export {
  authorizeSimCaller,
  allowedCallersOf,
  serviceAuthConfigOf,
  CALLER_HEADER,
  SIM_CALLERS,
  SIM_OPERATIONS,
  type SimCaller,
  type SimOperation,
} from "./auth.ts";
export {
  parseSimHeaders,
  executionKeyOf,
  executionMismatch,
  HEADER_WORKSPACE,
  HEADER_REHEARSAL_RUN,
  HEADER_EXECUTION,
  HEADER_TASK,
  HEADER_INTENT,
  HEADER_SHADOW,
  type SimCallHeaders,
} from "./headers.ts";
export { handleMcpPost, MCP_SERVER_INFO, type McpDeps } from "./mcp.ts";
export {
  adminRoutes,
  executionView,
  snapshotView,
  CreateExecutionBody,
  ForkBody,
  AdvanceBody,
  WorkspaceBody,
  SnapshotBody,
  DemoStoreBody,
  type AdminDeps,
  type ExecutionView,
  type SnapshotView,
} from "./admin.ts";
export {
  SimStoreConflictError,
  SimStoreReferenceError,
  SimStoreInUseError,
  type SimStore,
  type SimStoreReference,
  type SimExecutionRecord,
  type SimSnapshotRecord,
  type ExecutionKey,
  type ExecutionChange,
  type ForkResult,
  type DeleteCounts,
} from "./store.ts";
export { MemorySimStore, KeyedQueue } from "./memory-store.ts";
export { PostgresSimStore } from "./postgres-store.ts";
export { openSimStore, SimStoreConfigError, SIM_DB_OPTIONS, type OpenedSimStore, type SimStoreKind } from "./open-store.ts";
export { DEFAULT_WORLDS, implementedWorld, connectorOf, type AnyWorld, type WorldRegistry } from "./worlds.ts";
export { errorBody, SimHttpError, type SimErrorCode, type SimErrorBody } from "./errors.ts";
export { simWorldLogger, silentLogger, memoryLogger, type Logger, type LogInput, type LogRecord, type LogSeverity } from "./log.ts";
export { IdSchema, parseId } from "./ids.ts";
