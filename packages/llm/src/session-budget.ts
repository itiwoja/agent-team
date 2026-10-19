import { inputTokensUpperBound } from "./gemini.ts";
import { estimateMicroUsd, findPrice, GROUNDING_QUERIES_ESTIMATE, GROUNDING_QUERY_MICRO_USD } from "./pricing.ts";
import { LlmError, type LlmClient, type LlmRequest } from "./types.ts";
import { TrialLedger } from "./trial-ledger.ts";

/** Shared by every app entry point. Reserve synchronously before await, including concurrent calls. */
export class SessionBudgetClient implements LlmClient {
  private spent = 0;
  private reserved = 0;
  private readonly client: LlmClient;
  private readonly limit: number;
  private readonly ledger: TrialLedger | undefined;
  constructor(client: LlmClient, limit: number, ledgerPath?: string) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("LLM_SESSION_BUDGET_MICRO_USD は正の整数にしてください");
    this.client = client; this.limit = limit;
    this.ledger = ledgerPath ? new TrialLedger(ledgerPath, limit) : undefined;
  }
  modelIdentity(model: string) { return this.client.modelIdentity?.(model) ?? model; }
  priceFor(model: string) { return this.client.priceFor ? this.client.priceFor(model) : findPrice(model); }
  estimateMicroUsd(req: LlmRequest): number {
    return this.client.estimateMicroUsd?.(req) ?? (estimateMicroUsd(req.model, { inputTokens: inputTokensUpperBound(req), maxOutputTokens: req.maxTokens, thinkingBudget: req.maxTokens }) + (req.googleSearch ? GROUNDING_QUERIES_ESTIMATE * GROUNDING_QUERY_MICRO_USD : 0));
  }
  preflight(req: LlmRequest): void {
    this.client.preflight?.(req);
    if (!this.priceFor(req.model)) throw new LlmError("モデルの料金が未登録です", null, false);
    const estimate = this.estimateMicroUsd(req);
    if (!Number.isSafeInteger(estimate) || estimate < 0 || estimate > (this.ledger?.remaining() ?? this.limit - this.spent - this.reserved)) {
      throw new LlmError("LLM_SESSION_BUDGET_MICRO_USD の試験費用上限に達します。送信を停止しました", null, false);
    }
  }
  async generate(req: LlmRequest, opts?: { signal?: AbortSignal }) {
    this.preflight(req);
    const estimate = this.estimateMicroUsd(req);
    this.ledger?.update(estimate); // durable reservation before any transport; crash keeps the estimate charged
    this.reserved += estimate;
    try {
      const result = await this.client.generate(req, opts);
      const cost = result.usage.costMicroUsd;
      if (!Number.isSafeInteger(cost) || cost < 0) throw new LlmError("LLM の使用料金が不正です", null, false);
      this.spent += cost;
      this.ledger?.update(cost - estimate, false);
      return result;
    } catch (e) {
      // Conservative: an unsuccessful call may still have been billed upstream.
      this.spent += estimate;
      throw e;
    } finally { this.reserved -= estimate; }
  }
}
