// @open-team/github：本物の GitHub のアダプター（18 §3.2、D-119）
// DB・秘密は持たない。gateway からの呼び出し（sa-gateway）に付いたインストールのトークンで、その1回だけ GitHub REST API を呼ぶ
export { createApp, BODY_LIMIT_BYTES, type GithubDeps } from "./app.ts";
export { readGithubEnv, serviceAuthConfigOf, DEFAULT_GITHUB_API_BASE, type GithubEnv } from "./env.ts";
export { GITHUB_CALLERS, CALLER_HEADER } from "./auth.ts";
export { handleMcpPost, mcpMethodNotAllowed, readCallHeaders, MCP_SERVER_INFO, type McpDeps, type GithubCallHeaders } from "./mcp.ts";
export { callGithubTool, overallOf, GITHUB_TOOL_NAMES, PROTECTED_BRANCH_TEXT, type GithubToolName, type ToolContext } from "./tools.ts";
export { createGithubClient, pathOf, GithubAuthError, GithubApiError, GithubUpstreamError, type GithubClient } from "./github.ts";
export { githubLogger } from "./log.ts";
