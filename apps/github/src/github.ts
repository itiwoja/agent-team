// GitHub REST の小さなクライアント（18 §2・§3.2）。fetch・基底 URL・トークンは呼び出し側から受ける（試験は偽の fetch）。
// HTTP の結果は3つに分ける（gcal の calendar.ts と同じ）：
// - 401 → GithubAuthError（HTTP 401 になる。gateway が auth_required にする）
// - 429・5xx・レート制限の 403・届かない → GithubUpstreamError（同じ状態コード。unknown_outcome の判定に乗る）
// - それ以外の4xx → GithubApiError（ツールの結果 isError。404・409・422 は tools.ts が見る）

const REQUEST_TIMEOUT_MS = 15_000;
const API_VERSION = "2022-11-28";
/** 一覧の上限（ページ） */
const LIST_MAX_PAGES = 3;
/** 失敗の文に入れる GitHub の message の長さ */
const MESSAGE_MAX_CHARS = 200;

export class GithubAuthError extends Error {
  readonly status = 401 as const;
  constructor() {
    super("GitHub の認証に失敗（401）");
    this.name = "GithubAuthError";
  }
}

export class GithubUpstreamError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GithubUpstreamError";
    this.status = status;
  }
}

export class GithubApiError extends Error {
  readonly status: number;
  /** GitHub の応答の message（短く切ったもの。トークンは入らない） */
  readonly apiMessage: string;
  constructor(status: number, apiMessage: string) {
    super(`GitHub が ${status} を返した`);
    this.name = "GithubApiError";
    this.status = status;
    this.apiMessage = apiMessage;
  }
}

export interface RepoInfo {
  full_name: string;
  default_branch: string;
  private: boolean;
  description: string | null;
  html_url?: string;
}

export interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
  sha: string;
}

export interface ContentFile {
  type: string;
  encoding?: string;
  content?: string;
  size: number;
  sha: string;
  path: string;
}

export interface GitCommit {
  sha: string;
  message: string;
  tree: { sha: string };
  html_url?: string;
}

export interface Issue {
  number: number;
  title: string;
  state: string;
  body?: string | null;
  html_url: string;
  labels?: Array<{ name?: string } | string>;
  user?: { login?: string } | null;
  created_at?: string;
  pull_request?: unknown;
}

export interface PullRequest {
  number: number;
  html_url: string;
  draft?: boolean;
  state: string;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
}

export interface CombinedStatus {
  state: string;
  statuses: Array<{ context: string; state: string; target_url?: string | null }>;
}

export type TreeWrite = { path: string; mode: "100644"; type: "blob"; content: string } | { path: string; mode: "100644"; type: "blob"; sha: null };

export interface GithubClient {
  listInstallationRepos(): Promise<{ repos: RepoInfo[]; truncated: boolean }>;
  getRepo(repo: string): Promise<RepoInfo>;
  getTree(repo: string, ref: string): Promise<{ tree: TreeEntry[]; truncated: boolean }>;
  /** ファイルなら ContentFile、フォルダなら配列 */
  getContent(repo: string, path: string, ref: string | null): Promise<ContentFile | unknown[]>;
  listIssues(repo: string, state: string, label: string | null): Promise<Issue[]>;
  /** ブランチの先頭のコミット（なければ null） */
  getBranchSha(repo: string, branch: string): Promise<string | null>;
  getCommit(repo: string, sha: string): Promise<GitCommit>;
  createTree(repo: string, baseTree: string, entries: readonly TreeWrite[]): Promise<string>;
  createCommit(repo: string, message: string, tree: string, parents: readonly string[]): Promise<GitCommit>;
  createBranch(repo: string, branch: string, sha: string): Promise<void>;
  /** 早送りだけ（force: false） */
  updateBranch(repo: string, branch: string, sha: string): Promise<void>;
  findOpenPull(repo: string, head: string, base: string): Promise<PullRequest | null>;
  createPull(repo: string, p: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<PullRequest>;
  checkRuns(repo: string, ref: string): Promise<{ runs: CheckRun[]; total: number }>;
  combinedStatus(repo: string, ref: string): Promise<CombinedStatus>;
}

/** URL のパスの部分（"/" で区切った各部分を符号化する。"owner/name"・ファイルのパス・ブランチ名に使う） */
export function pathOf(value: string): string {
  return value
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

export function createGithubClient(fetchFn: typeof fetch, apiBase: string, token: string): GithubClient {
  const base = apiBase.replace(/\/+$/, "");

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": API_VERSION,
          "user-agent": "open-team-github",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // 届かない・タイムアウト：送ったかどうか分からない（書き込みなら unknown_outcome）
      throw new GithubUpstreamError(503, "GitHub に届かなかった");
    }
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      throw new GithubAuthError();
    }
    const rateLimited = res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"));
    if (res.status === 429 || rateLimited || res.status >= 500) {
      await res.body?.cancel().catch(() => {});
      throw new GithubUpstreamError(res.status >= 500 ? res.status : 429, `GitHub が ${res.status} を返した`);
    }
    if (!res.ok) {
      let message = "";
      try {
        const json = (await res.json()) as { message?: unknown };
        if (typeof json.message === "string") message = json.message.slice(0, MESSAGE_MAX_CHARS);
      } catch {
        // 本文が読めなくても状態コードだけで返す
      }
      throw new GithubApiError(res.status, message);
    }
    if (res.status === 204) return undefined;
    try {
      return await res.json();
    } catch {
      throw new GithubUpstreamError(503, "GitHub の応答を読めなかった");
    }
  }

  const repoPath = (repo: string) => `/repos/${pathOf(repo)}`;

  return {
    async listInstallationRepos() {
      const repos: RepoInfo[] = [];
      for (let page = 1; page <= LIST_MAX_PAGES; page += 1) {
        const json = (await call("GET", `/installation/repositories?per_page=100&page=${page}`)) as { total_count?: number; repositories?: RepoInfo[] };
        const got = json.repositories ?? [];
        repos.push(...got);
        if (got.length < 100) return { repos, truncated: false };
      }
      return { repos, truncated: true };
    },

    async getRepo(repo) {
      return (await call("GET", repoPath(repo))) as RepoInfo;
    },

    async getTree(repo, ref) {
      const json = (await call("GET", `${repoPath(repo)}/git/trees/${pathOf(ref)}?recursive=1`)) as { tree?: TreeEntry[]; truncated?: boolean };
      return { tree: json.tree ?? [], truncated: json.truncated === true };
    },

    async getContent(repo, path, ref) {
      const qs = ref !== null ? `?ref=${encodeURIComponent(ref)}` : "";
      return (await call("GET", `${repoPath(repo)}/contents/${pathOf(path)}${qs}`)) as ContentFile | unknown[];
    },

    async listIssues(repo, state, label) {
      const qs = new URLSearchParams({ state, per_page: "30" });
      if (label !== null) qs.set("labels", label);
      return (await call("GET", `${repoPath(repo)}/issues?${qs.toString()}`)) as Issue[];
    },

    async getBranchSha(repo, branch) {
      try {
        const json = (await call("GET", `${repoPath(repo)}/git/ref/heads/${pathOf(branch)}`)) as { object?: { sha?: string } };
        return json.object?.sha ?? null;
      } catch (e) {
        if (e instanceof GithubApiError && e.status === 404) return null;
        throw e;
      }
    },

    async getCommit(repo, sha) {
      return (await call("GET", `${repoPath(repo)}/git/commits/${encodeURIComponent(sha)}`)) as GitCommit;
    },

    async createTree(repo, baseTree, entries) {
      const json = (await call("POST", `${repoPath(repo)}/git/trees`, { base_tree: baseTree, tree: entries })) as { sha: string };
      return json.sha;
    },

    async createCommit(repo, message, tree, parents) {
      return (await call("POST", `${repoPath(repo)}/git/commits`, { message, tree, parents })) as GitCommit;
    },

    async createBranch(repo, branch, sha) {
      await call("POST", `${repoPath(repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    },

    async updateBranch(repo, branch, sha) {
      await call("PATCH", `${repoPath(repo)}/git/refs/heads/${pathOf(branch)}`, { sha, force: false });
    },

    async findOpenPull(repo, head, base) {
      const owner = repo.split("/")[0] ?? "";
      const qs = new URLSearchParams({ state: "open", head: `${owner}:${head}`, base, per_page: "1" });
      const json = (await call("GET", `${repoPath(repo)}/pulls?${qs.toString()}`)) as PullRequest[];
      return json[0] ?? null;
    },

    async createPull(repo, p) {
      return (await call("POST", `${repoPath(repo)}/pulls`, p)) as PullRequest;
    },

    async checkRuns(repo, ref) {
      const json = (await call("GET", `${repoPath(repo)}/commits/${pathOf(ref)}/check-runs?per_page=50`)) as { total_count?: number; check_runs?: CheckRun[] };
      return { runs: json.check_runs ?? [], total: json.total_count ?? 0 };
    },

    async combinedStatus(repo, ref) {
      const json = (await call("GET", `${repoPath(repo)}/commits/${pathOf(ref)}/status`)) as Partial<CombinedStatus>;
      return { state: json.state ?? "pending", statuses: json.statuses ?? [] };
    },
  };
}
