import { expect, it } from "vitest";
import { knownSecretsFromEnv, maskSecrets } from "./mask.ts";
it("masks every provider key, including non-sk keys and x-api-key headers", () => {
  const env = { ANTHROPIC_API_KEY: "fake-anthropic-secret", DEEPSEEK_API_KEY: "fake-deepseek-secret", OPENROUTER_API_KEY: "custom-provider-secret" };
  const known = knownSecretsFromEnv(env);
  for (const secret of Object.values(env)) expect(maskSecrets(`key=${secret}`, known)).not.toContain(secret);
  expect(maskSecrets('x-api-key: unknown-provider-secret')).toBe('x-api-key: [REDACTED]');
});
