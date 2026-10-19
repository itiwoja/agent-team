export const PROFILE = {
  inputPerMTokMicroUsd: 2_000_000, outputPerMTokMicroUsd: 10_000_000,
  tools: true, structuredOutput: "tool" as const, temperature: true, reasoningEffort: false,
  maxOutputTokens: 8192, contextWindow: 200_000, tokenLimitParameter: "max_completion_tokens" as const,
};
