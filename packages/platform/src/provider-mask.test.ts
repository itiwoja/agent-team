import { expect, it } from "vitest";
import { knownSecretsFromEnv, maskSecrets } from "./mask.ts";
it("masks every provider key, including non-sk compatible keys and x-api-key headers", () => {
  const env = { ANTHROPIC_API_KEY: "fake-anthropic-secret", OPENAI_API_KEY: "fake-openai-secret", OPENAI_COMPATIBLE_API_KEY: "custom-provider-secret" };
  const known = knownSecretsFromEnv(env);
  for (const secret of Object.values(env)) expect(maskSecrets(`key=${secret}`, known)).not.toContain(secret);
  expect(maskSecrets('x-api-key: unknown-provider-secret')).toBe('x-api-key: [REDACTED]');
});
