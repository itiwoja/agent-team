// @open-team/platform：app・gateway が共有する土台（cross-check §3.1。SO §3.1・3.9・3.17・2.11）
// 環境変数の読み方・エラーの形・構造化ログとマスク・サービス間の認証（共有トークン）・本当の時刻と費用の日の区切り
// runner はこのパッケージを import しない（鍵・環境変数に届かない：15:487、.dependency-cruiser.cjs の runner-no-secrets）
//
// 使い方（gateway の例）：
//   const r = new EnvReader(process.env);
//   const authConfig = readServiceAuthEnv(r);
//   const { missing } = r.done({});                       // 名前だけ（D-47）。gateway は足りなければ起動しない
//   const log = createLogger({ service: "gateway", commit: r.string("COMMIT_SHA") });
//   const auth = createServiceAuth(authConfig, { log });
//   const app = new Hono<PlatformEnv>();
//   app.use("*", requestContext({ logger: log, acceptIncoming: true }));
//   app.onError(errorHandler());
//   app.notFound(notFoundHandler());
//   app.use("/gw/v1/*", auth.verifyServiceCaller(["sa-app"]));     // c.var.serviceCaller
//   // 呼ぶ側：createGatewayClient({ baseUrl, authHeaders: (aud) => auth.serviceAuthHeaders("sa-app", aud) })
//   // 処理の中：throw new AppError("TASK_HALTED", undefined, { details: { haltReason } })

export {
  EnvReader,
  MIN_SECRET_LENGTH,
  describeMissing,
  normalizeServiceUrl,
  type EnvCheck,
  type EnvSource,
  type ReadOptions,
} from "./env.ts";
export {
  API_ERROR_CODES,
  AppError,
  DEFAULT_ERROR_MESSAGES,
  ERROR_STATUS,
  errorBody,
  errorHandler,
  errorResponse,
  isApiErrorCode,
  isAppError,
  notFoundHandler,
  parseInput,
  readJsonBody,
  setupRequired,
  validationError,
  zodIssuesToDetails,
  type ApiErrorBody,
  type ApiErrorCode,
  type AppErrorOptions,
  type ErrorHandlerOptions,
  type ErrorStatus,
  type ValidationIssue,
} from "./errors.ts";
export {
  MAX_DEPTH,
  MAX_STRING_LENGTH,
  MIN_KNOWN_SECRET_LENGTH,
  REDACTED,
  SECRET_ENV_NAMES,
  SESSION_COOKIE,
  isSensitiveKey,
  knownSecretsFromEnv,
  maskSecrets,
  redact,
} from "./mask.ts";
export {
  REQUEST_ID_HEADER,
  REQUEST_ID_PATTERN,
  createLogger,
  loggerOf,
  memoryLogger,
  newRequestId,
  requestContext,
  requestIdOf,
  requestSecretsOf,
  silentLogger,
  type LogContext,
  type LogFields,
  type LogInput,
  type LogRecord,
  type LogSeverity,
  type Logger,
  type LoggerOptions,
  type RequestContextOptions,
  type ServiceName,
} from "./log.ts";
export {
  CALLER_HEADER,
  SERVICE_CALLERS,
  bearerTokenOf,
  createServiceAuth,
  readServiceAuthEnv,
  safeEqual,
  type ServiceAuth,
  type ServiceAuthConfig,
  type ServiceAuthDeps,
  type ServiceAuthRejectReason,
  type ServiceCaller,
  type ServiceCallerCheck,
} from "./service-auth.ts";
export {
  BUDGET_TIME_ZONE,
  DAY_MS,
  TOKYO_OFFSET_MS,
  budgetDay,
  manualClock,
  secondsUntilTokyoDayEnd,
  systemClock,
  tokyoDay,
  tokyoDayEnd,
  tokyoDayStart,
  type Clock,
  type ManualClock,
  type TokyoDay,
} from "./time.ts";
export type { PlatformEnv, PlatformVariables, RequestVariables, ServiceCallerVariables } from "./context.ts";
export { openSecret, sealSecret } from "./secret-box.ts";
