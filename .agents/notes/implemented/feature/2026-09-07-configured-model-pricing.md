# Agent Note: Configured per-model pricing surfaces through resolved model metadata

Status: implemented

English | [中文](2026-09-07-configured-model-pricing.zh.md)

## Problem

The harness had no dollar pricing anywhere: `llm-pi-ai` zeroed pi-ai's catalog cost metadata, no adapter declared rates, and no consumer could report spend. A deployment running several providers — hosted, gateway, or self-hosted — could count tokens but never tell what a session cost, and ported provider-model settings (from the free-code harness's `modelSettings.json`) require pricing as per-model configuration, not a catalog lookup the harness explicitly refuses to trust.

## Decision

Pricing is a deployment-declared fact per exact model route, travelling the same path as every other configured model fact:

- The vocabulary is `LlmModelPricing` (`packages/llm/llm/src/types.ts`): per-million-token USD rates `input`, `output`, `cacheRead`, `cacheWrite`, each optional. `LlmResolvedModelInfo.pricing` carries it, and `LlmRuntime.normalizeModelInfo` validates (finite, non-negative) and detaches it, refusing `INVALID_MODEL_PRICING` — the same earliest-point rule as every other adapter-returned metadata.
- `llm-pi-ai` model entries and `modelOverrides` values accept `pricing`; `llm-deepseek` catalog entries accept it. Resolution follows the `configuredMaxTokens` precedent: only a block the profile wrote lands in `configuredPricing`; an empty block declares nothing (the schema materializes `{}` for an absent key, so absent and empty are one state), and the installed pi-ai catalog's cost metadata stays unread — a rate nobody chose is not a deployment fact.
- `estimateUsageCost` (`packages/llm/llm/src/pricing.ts`, also exported as the `./pricing` subpath) prices one `TokenUsage` sample: disjoint buckets at their own rates, omitted buckets at zero (a true zero for a self-hosted route), reasoning never priced separately from output, and `undefined` for an all-empty table — reporting `0` would claim a fact the deployment never stated.
- `session-controller`'s `buildModelCatalog` passes pricing onto `ModelCatalogModel`, so the browser model catalog carries rates to any consumer (pickers, usage panels, the Models page's profile editor) without a second lookup.

## Alternatives considered

- **Reuse pi-ai's `Model.cost`.** Rejected: pi-ai requires all four fields, conflating "free" with "unknown", and the harness's shipped stance (`replay.ts` zeroing cost) already treats catalog cost as untrusted; a profile-declared map keeps the explicit-configuration rule visible in `RouteCatalog` beside `configuredMaxTokens`.
- **Inherit catalog cost when no profile pricing exists.** Rejected: the catalog's rates describe the vendor's public pricing, not what a deployment's endpoint actually charges through a proxy or enterprise agreement, and silent inheritance would make spend look authoritative when nobody stated it.
- **Compute per-turn cost in the token meter.** Deferred: durable usage events carry no rates, the meter fold is pure and synchronous, and turn usage is currently folded client-side (`ui-chat` `deriveTurnTokenUsage`); a chat cost row can now price `usage.routes` against catalog pricing at render time without changing the fold.

## Consequences

- Spend display in the chat Turn-usage panel is a pure consumer of catalog pricing plus logged usage; the fold stays pricing-free.
- A route serving unpriced models reports no cost rather than a guessed one; adding rates to `DEFAULT_MODELS` is the way to state DeepSeek's public pricing as a fact.
- Pricing changes retroactively re-estimate history: rates come from current configuration at display time, not from a durable per-call rate stamp.
