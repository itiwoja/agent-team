// 構造化ログ（security-ops-deploy.md §2.10）。packages/platform の Logger（sim-world と同じ形）。
// トークン・ツールの引数・予定の中身は出さない（ID・ツール名・結果の種類だけ）。

import { createLogger, type Logger } from "@open-team/platform";

/** gcal の Logger（既定は標準出力） */
export function gcalLogger(commit?: string, write?: (line: string) => void): Logger {
  return createLogger({ service: "gcal", ...(commit ? { commit } : {}), ...(write ? { write } : {}) });
}
