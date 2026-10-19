// 構造化ログ（security-ops-deploy.md §2.10・§3.17）。packages/platform の Logger に寄せた（gateway・app と同じ形：
// 1行1JSON、必須のキーは null で出す、環境変数の秘密・リクエストのトークンはマスク）。
// トークン・本文・ツールの引数は出さない（ID・ツール名・結果の種類だけ）

import { createLogger, type Logger } from "@open-team/platform";

export { memoryLogger, silentLogger, type Logger, type LogInput, type LogRecord, type LogSeverity } from "@open-team/platform";

/** sim-world の Logger（service: "sim-world"、commit つき。既定は標準出力） */
export function simWorldLogger(commit?: string, write?: (line: string) => void): Logger {
  return createLogger({ service: "sim-world", ...(commit ? { commit } : {}), ...(write ? { write } : {}) });
}
