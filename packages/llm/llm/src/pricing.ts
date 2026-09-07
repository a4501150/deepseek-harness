/**
 * Deterministic cost estimation over {@link TokenUsage} buckets.
 *
 * @module @deepseek-ai/dsh-llm/pricing
 */

import type { LlmModelPricing, TokenUsage } from './types.ts'

/**
 * Estimate the billed cost of one usage sample under one pricing table.
 *
 * Buckets are disjoint, so each is priced at its own rate; a bucket the
 * pricing omits is priced at zero, which is the correct answer for a
 * self-hosted route and an understatement the caller reports as an estimate.
 * Reasoning tokens are a subset of output and never priced separately.
 * @param usage - provider-reported usage for one call.
 * @param pricing - per-Mtok rates declared for the call's route.
 * @returns the estimated cost in USD, or undefined when the pricing table
 * declares no rate at all — an empty table answers nothing, and reporting
 * `0` would claim a settled fact the deployment never stated.
 */
export function estimateUsageCost(usage: TokenUsage, pricing: LlmModelPricing): number | undefined {
  const rates = [pricing.input, pricing.output, pricing.cacheRead, pricing.cacheWrite]
  if (rates.every(rate => rate === undefined)) return undefined
  return (
    (pricing.input ?? 0) * usage.inputTokens
    + (pricing.output ?? 0) * usage.outputTokens
    + (pricing.cacheRead ?? 0) * (usage.cacheReadTokens ?? 0)
    + (pricing.cacheWrite ?? 0) * (usage.cacheWriteTokens ?? 0)
  ) / 1_000_000
}
