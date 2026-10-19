// 環境変数の読み方の共通（security-ops-deploy.md §2.2・§3.1）。足りない・不正な変数の「名前」だけを返し、値は出さない（D-47）
// 各サービスの必須の組み合わせ（app の readAppEnv・gateway・sim-world）は apps が EnvReader で組む。
// 不正な値は undefined にして返す（使ってしまわないように、閉じた側に倒す）

/**
 * local＝ローカル（docker compose・計測。サービス間は共有トークン：G-11）、
 * cloud＝Cloud Run（フェーズ0-H の公開デプロイ。サービス間は Google の ID トークン：SO §3.9）。
 * SO・MT の値 public は cloud と同じに読む
 */
export type DeploymentMode = "local" | "cloud";
export const DEPLOYMENT_MODES: readonly DeploymentMode[] = ["local", "cloud"];

/** 秘密の値の最小の長さ（SO §2.1 の secretMinLen。apps/app/src/env.ts の MIN_SECRET_LENGTH と同じ） */
export const MIN_SECRET_LENGTH = 32;

/** 読んだ結果と、足りない・不正な変数の名前（D-47。値は入れない） */
export interface EnvCheck<E> {
  env: E;
  missing: string[];
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

const nonEmpty = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/**
 * DEPLOYMENT_MODE を読む。既定は local（SO §3.1.1）。知らない値は厳しい側（cloud）で読み、valid=false。
 * Cloud Run（K_SERVICE がある）で local のまま動くと BR-66 の起動時の確認などが外れるので、cloud で読んで valid=false にする【決定：platform】
 */
export function readDeploymentMode(source: EnvSource): { mode: DeploymentMode; valid: boolean } {
  const raw = nonEmpty(source.DEPLOYMENT_MODE);
  const onCloudRun = nonEmpty(source.K_SERVICE) !== undefined;
  if (raw === "cloud" || raw === "public") return { mode: "cloud", valid: true };
  if (raw === undefined || raw === "local") return onCloudRun ? { mode: "cloud", valid: false } : { mode: "local", valid: true };
  return { mode: "cloud", valid: false };
}

export interface ReadOptions {
  /** 無ければ足りないに入れる */
  required?: boolean;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * 環境変数を1つずつ読み、足りない・不正な名前を順に積む（同じ名前は1回だけ）。
 * 値はどこにも書かない。missing は読んだ順（SO-ENV-01 の順番どおり）
 */
export class EnvReader {
  readonly #source: EnvSource;
  readonly #missing: string[] = [];
  #mode: DeploymentMode | undefined;

  constructor(source: EnvSource = process.env) {
    this.#source = source;
  }

  /** ここまでに積んだ名前（写し） */
  get missing(): string[] {
    return [...this.#missing];
  }

  /** 名前を足りない・不正に入れる（apps が自分の規則で外したとき） */
  flag(name: string): void {
    if (!this.#missing.includes(name)) this.#missing.push(name);
  }

  /** 空白だけでない値があるか */
  has(name: string): boolean {
    return nonEmpty(this.#source[name]) !== undefined;
  }

  /** DEPLOYMENT_MODE（readDeploymentMode。外れていれば名前を積む）。2回目からは同じ値 */
  deploymentMode(): DeploymentMode {
    if (this.#mode === undefined) {
      const r = readDeploymentMode(this.#source);
      if (!r.valid) this.flag("DEPLOYMENT_MODE");
      this.#mode = r.mode;
    }
    return this.#mode;
  }

  /** 前後の空白を除いた文字列。空なら undefined */
  string(name: string, opts: ReadOptions & { pattern?: RegExp } = {}): string | undefined {
    const v = nonEmpty(this.#source[name]);
    if (v === undefined) {
      if (opts.required) this.flag(name);
      return undefined;
    }
    if (opts.pattern && !opts.pattern.test(v)) {
      this.flag(name);
      return undefined;
    }
    return v;
  }

  /**
   * 秘密の値（そのまま。空白を除かない）。minLength（既定 32）より短い・前後に空白や改行がある値は不正。
   * Secret Manager に改行つきで入れた値を「準備中」の名前で気づけるようにする
   */
  secret(name: string, opts: ReadOptions & { minLength?: number } = {}): string | undefined {
    const v = this.#source[name];
    if (v === undefined || v === "") {
      if (opts.required) this.flag(name);
      return undefined;
    }
    if (v.length < (opts.minLength ?? MIN_SECRET_LENGTH) || v !== v.trim()) {
      this.flag(name);
      return undefined;
    }
    return v;
  }

  /**
   * http(s) の URL。認証情報・クエリ・# を持つものは不正。
   * 返す形は `${protocol}//${host}${path}`（末尾の / を除く。ホストは小文字）。ID トークンの aud・呼び先に使う
   */
  url(name: string, opts: ReadOptions & { httpsOnly?: boolean } = {}): string | undefined {
    const v = this.string(name, opts);
    if (v === undefined) return undefined;
    const normalized = normalizeServiceUrl(v, opts.httpsOnly ?? false);
    if (normalized === null) this.flag(name);
    return normalized ?? undefined;
  }

  /** メールアドレスの形（サービスアカウント）。小文字にそろえる */
  email(name: string, opts: ReadOptions = {}): string | undefined {
    const v = this.string(name, opts);
    if (v === undefined) return undefined;
    if (!EMAIL.test(v)) {
      this.flag(name);
      return undefined;
    }
    return v.toLowerCase();
  }

  /** 整数（既定値つき）。範囲の外・整数でない → 名前を積んで既定値 */
  int(name: string, opts: { fallback: number; min?: number; max?: number }): number {
    const v = nonEmpty(this.#source[name]);
    if (v === undefined) return opts.fallback;
    const n = /^-?\d+$/.test(v) ? Number(v) : Number.NaN;
    if (!Number.isSafeInteger(n) || (opts.min !== undefined && n < opts.min) || (opts.max !== undefined && n > opts.max)) {
      this.flag(name);
      return opts.fallback;
    }
    return n;
  }

  /** 待ち受けのポート（Cloud Run が PORT を渡す。既定 8080） */
  port(name = "PORT", fallback = 8080): number {
    return this.int(name, { fallback, min: 0, max: 65535 });
  }

  /** カンマ区切りの一覧（前後の空白を除き、空を捨てる） */
  list(name: string, opts: ReadOptions = {}): string[] {
    const items = (this.#source[name] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (items.length === 0 && opts.required) this.flag(name);
    return items;
  }

  /** 置いてはいけない変数（例：public の GEMINI_API_KEY。SO §3.1.1 の 5）。値があれば名前を積む */
  forbid(name: string): void {
    if (this.has(name)) this.flag(name);
  }

  /** 読み終わり。env はそのまま、missing は写し */
  done<E>(env: E): EnvCheck<E> {
    return { env, missing: this.missing };
  }
}

/**
 * サービスの URL を正規化する（不正なら null）。http(s) だけ、認証情報・クエリ・# なし。
 * `https://Gateway-1.run.app/` → `https://gateway-1.run.app`
 */
export function normalizeServiceUrl(raw: string, httpsOnly = false): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && (httpsOnly || u.protocol !== "http:")) return null;
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** 起動・準備中のログの文（名前だけ。D-47） */
export function describeMissing(missing: readonly string[]): string {
  return `足りない・不正な環境変数：${missing.join(", ")}`;
}
