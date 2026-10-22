// 秘密情報のマスク（NFR-032・NFR-057、security-ops-deploy.md §3.17 の 2、§9 I-29）
// ログに出す前・保存する前に [REDACTED] に置き換える。既知の値（環境変数の秘密・リクエストのトークン）と、決まった形のパターンの2段。
// 11 は secretlint をライブラリとして使うとするが、依存を足さない決まりなので、NFR-057 の形（ghs_・sk-・AKIA・秘密鍵のヘッダー）と
// SO §3.17 の形（Authorization・Cookie・JWT・ya29.・URL のパスワード）を正規表現で持つ【決定：platform】。
// カナリア（'OT-CANARY-…'。U-08）はわざと当てない（ツールの結果に使っても、漏えいの試験を壊さない）

export const REDACTED = "[REDACTED]";

/** セッションの Cookie の名前（SO §2.4、apps/app/src/session.ts と同じ） */
export const SESSION_COOKIE = "ot_session";

/** これより短い既知の値は置き換えない（設定の誤りで短い文字列が全部消えないように。秘密は32文字以上：SO §2.1） */
export const MIN_KNOWN_SECRET_LENGTH = 8;

/** 値をマスクする環境変数（秘密の値・鍵・共有トークン） */
export const SECRET_ENV_NAMES = [
  "PHASE0_ACCESS_TOKEN",
  "SESSION_COOKIE_SECRET",
  "INTERNAL_SHARED_TOKEN",
  "DATABASE_URL",
  "DATABASE_URL_MAINT",
  "VAPID_PRIVATE_KEY",
  "SEARCH_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "OAUTH_TOKEN_KEY",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GCAL_SHARED_TOKEN",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_SHARED_TOKEN",
] as const;

/** 環境変数にある秘密の値（マスクの既知の値に渡す） */
export function knownSecretsFromEnv(source: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const out: string[] = [];
  for (const name of SECRET_ENV_NAMES) {
    const v = source[name];
    if (v !== undefined && v.length >= MIN_KNOWN_SECRET_LENGTH) out.push(v);
  }
  return out;
}

/** 決まった形のパターン（上から順に置き換える） */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // 秘密鍵（BEGIN から END まで。END がなければ文字列の終わりまで）
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----|$)/g, REDACTED],
  // ヘッダーの形（Authorization: … ／ Cookie: … ／ "x-task-token":"…"）。値は行の終わりか引用符まで
  [
    /\b(authorization|proxy-authorization|x-serverless-authorization|set-cookie|cookie|x-task-token|x-csrf-token|x-api-key)(["']?\s*[:=]\s*["']?)[^"'\r\n]+/gi,
    `$1$2${REDACTED}`,
  ],
  // Bearer のトークン（RFC 6750 の token68）
  [/\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi, `$1 ${REDACTED}`],
  // セッションの Cookie の値
  [/\b(ot_session=)[^;\s"',]+/g, `$1${REDACTED}`],
  // URL の中のパスワード（postgres://user:<password>@host など）
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, `$1${REDACTED}@`],
  // JWT（ID トークンなど。署名を外したもの（末尾が .）も）
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Google のアクセストークン
  [/\bya29\.[A-Za-z0-9_\-.]+/g, REDACTED],
  // Google の API キー（0-H は置いてはいけない：ADR-032）
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  // GitHub のトークン（ghs_ ほか。NFR-057）
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  // sk- の API キー（NFR-057）
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  // AWS のアクセスキー ID（NFR-057 の AKIA。一時的な ASIA も）
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
];

/**
 * 文字列の中の秘密情報を [REDACTED] にする（SO §3.17 の maskSecrets）。
 * 1段目：既知の値（長い順・そのままの一致）。2段目：決まった形のパターン
 */
export function maskSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  const known = knownSecrets.filter((s) => s.length >= MIN_KNOWN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
  for (const s of known) {
    if (out.includes(s)) out = out.split(s).join(REDACTED);
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

// キーの名前で値ごと隠す（構造化ログのオブジェクト。大文字小文字・- と _ を無視して末尾で比べる）。
// 例：authorization・cookie・set-cookie・x-task-token・csrfToken・password・apiKey・privateKey・clientSecret。
// inputTokens（数）は末尾が tokens なので当たらない
const SENSITIVE_KEY_SUFFIXES = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "privatekey",
  "authorization",
  "cookie",
  "credential",
  "credentials",
] as const;

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_SUFFIXES.some((s) => k.endsWith(s));
}

/** これより深い入れ子・長い文字列は切る（ログ1件の大きさを抑える） */
export const MAX_DEPTH = 8;
export const MAX_STRING_LENGTH = 8192;

function truncate(s: string): string {
  return s.length > MAX_STRING_LENGTH ? `${s.slice(0, MAX_STRING_LENGTH)}…(${s.length - MAX_STRING_LENGTH} 文字を省略)` : s;
}

function walk(v: unknown, secrets: readonly string[], depth: number, seen: Set<object>): unknown {
  if (typeof v === "string") return truncate(maskSecrets(v, secrets));
  if (v === null || typeof v === "number" || typeof v === "boolean" || v === undefined) return v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "function" || typeof v === "symbol") return undefined;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  if (v instanceof Uint8Array) return v.length <= 64 ? Buffer.from(v).toString("hex") : `[${v.length} バイト]`;
  if (depth >= MAX_DEPTH) return "[深すぎるので省略]";
  if (seen.has(v)) return "[循環]";
  seen.add(v);
  try {
    if (v instanceof Error) {
      const out: Record<string, unknown> = { name: v.name, message: walk(v.message, secrets, depth + 1, seen) };
      if (v.stack) out.stack = walk(v.stack, secrets, depth + 1, seen);
      if (v.cause !== undefined) out.cause = walk(v.cause, secrets, depth + 1, seen);
      return out;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, secrets, depth + 1, seen) ?? null);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      out[k] = isSensitiveKey(k) && x !== null ? REDACTED : walk(x, secrets, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(v);
  }
}

/**
 * 値を丸ごとマスクする（文字列は maskSecrets、秘密の名前のキーは値ごと [REDACTED]）。
 * Error は { name, message, stack, cause }、Date は ISO、bigint は文字列、Uint8Array は16進にする。循環・深すぎる入れ子は印に置き換える
 */
export function redact(value: unknown, knownSecrets: readonly string[] = []): unknown {
  return walk(value, knownSecrets, 0, new Set());
}
