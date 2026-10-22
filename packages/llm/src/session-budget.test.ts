import { expect, it, vi } from "vitest";
import { SessionBudgetClient } from "./session-budget.ts";
import { providerModelIdentity, type LlmConfig } from "./provider-config.ts";
import { PROFILE } from "./__fixtures__/provider.ts";
import type { LlmRequest, LlmResponse } from "./types.ts";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const req: LlmRequest = { model: "m", system: "", messages: [{ role: "user", content: "test" }], tools: [], mcpTools: [], maxTokens: 10 };
const response: LlmResponse = { model: "m", parts: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, costMicroUsd: 40 } };
const price = { model: "m", inputPerMTokMicroUsd: 1000000, outputPerMTokMicroUsd: 1000000, thinkingPerMTokMicroUsd: 1000000 };
it("observes reservations made by a different Node process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "makase-budget-")), path = join(dir, "ledger.json");
  writeFileSync(path, JSON.stringify({ version: 1, limitMicroUsd: 100, chargedMicroUsd: 0 }));
  try {
    const source = `import { TrialLedger } from ${JSON.stringify(new URL("./trial-ledger.ts", import.meta.url).href)}; new TrialLedger(${JSON.stringify(path)}, 100).update(60);`;
    execFileSync(process.execPath, ["--input-type=module", "-e", source], { stdio: "pipe" });
    const generate = vi.fn();
    const c = new SessionBudgetClient({ priceFor: () => price, estimateMicroUsd: () => 60, generate }, 100, path);
    await expect(c.generate(req)).rejects.toThrow(/試験費用上限/);
    expect(generate).not.toHaveBeenCalled();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("shares durable reservations and settled cost across separate client lifetimes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "makase-budget-")), path = join(dir, "ledger.json");
  writeFileSync(path, JSON.stringify({ version: 1, limitMicroUsd: 100, chargedMicroUsd: 0 }));
  try {
    let complete!: (r: LlmResponse) => void;
    const generate = vi.fn().mockImplementation(() => new Promise<LlmResponse>(resolve => { complete = resolve; }));
    const delegate = { priceFor: () => price, estimateMicroUsd: () => 60, generate };
    const a = new SessionBudgetClient(delegate, 100, path);
    const b = new SessionBudgetClient(delegate, 100, path);
    const first = a.generate(req);
    await expect(b.generate(req)).rejects.toThrow(/試験費用上限/);
    expect(JSON.parse(readFileSync(path, "utf8")).chargedMicroUsd).toBe(60);
    complete(response); await first;
    const restart = new SessionBudgetClient(delegate, 100, path);
    const second = restart.generate(req); complete(response); await second;
    expect(JSON.parse(readFileSync(path, "utf8")).chargedMicroUsd).toBe(80);
    await expect(b.generate(req)).rejects.toThrow(/試験費用上限/);
    expect(() => new SessionBudgetClient(delegate, 200, path)).toThrow(/台帳/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("keeps uncertain failures charged after restart and fails closed on corruption or stale lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "makase-budget-")), path = join(dir, "ledger.json");
  writeFileSync(path, JSON.stringify({ version: 1, limitMicroUsd: 100, chargedMicroUsd: 0 }));
  try {
    const delegate = { priceFor: () => price, estimateMicroUsd: () => 60, generate: vi.fn().mockRejectedValue(new Error("network")) };
    await expect(new SessionBudgetClient(delegate, 100, path).generate(req)).rejects.toThrow("network");
    await expect(new SessionBudgetClient(delegate, 100, path).generate(req)).rejects.toThrow(/試験費用上限/);
    writeFileSync(path, "invalid");
    expect(() => new SessionBudgetClient(delegate, 100, path)).toThrow(/台帳/);
    mkdirSync(`${path}.lock`);
    expect(() => new SessionBudgetClient(delegate, 100, path)).toThrow(/台帳/);
    expect(delegate.generate).toHaveBeenCalledTimes(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("reserves in-flight calls atomically and returns unused estimate after success", async () => {
  let complete!: (r: LlmResponse) => void;
  const generate = vi.fn().mockImplementation(() => new Promise<LlmResponse>(resolve => { complete = resolve; }));
  const c = new SessionBudgetClient({ priceFor: () => price, estimateMicroUsd: () => 60, generate }, 100);
  const first = c.generate(req);
  await expect(c.generate(req)).rejects.toThrow(/試験費用上限/);
  complete(response); await first;
  const second = c.generate(req); complete(response); await second;
  await expect(c.generate(req)).rejects.toThrow(/試験費用上限/);
  expect(generate).toHaveBeenCalledTimes(2);
});
it("failed transport attempts consume their estimate and cannot loop around the cap", async () => {
  const generate = vi.fn().mockRejectedValue(new Error("network"));
  const c = new SessionBudgetClient({ priceFor: () => price, estimateMicroUsd: () => 60, generate }, 100);
  await expect(c.generate(req)).rejects.toThrow("network");
  await expect(c.generate(req)).rejects.toThrow(/試験費用上限/);
  expect(generate).toHaveBeenCalledTimes(1);
});
it("binds certificates to provider, endpoint and capabilities, but never API keys", () => {
  const cfg: LlmConfig = { provider: "openrouter", baseUrl: "https://one.test/v1", apiKey: "fake-key", agentModel: "m", plannerModel: "m", compareModels: [], profiles: { m: PROFILE } };
  const id = providerModelIdentity(cfg, "m");
  expect(providerModelIdentity({ ...cfg, apiKey: "different-secret" }, "m")).toBe(id);
  expect(providerModelIdentity({ ...cfg, baseUrl: "https://two.test/v1" }, "m")).not.toBe(id);
  expect(providerModelIdentity({ ...cfg, provider: "anthropic" }, "m")).not.toBe(id);
  expect(providerModelIdentity({ ...cfg, profiles: { m: { ...PROFILE, tools: false } } }, "m")).not.toBe(id);
  expect(id).not.toContain("fake-key");
  expect(providerModelIdentity(undefined, "gemini-2.5-flash")).toBe("gemini-2.5-flash");
});
