import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { estimateUsageCost } from '@deepseek-ai/dsh-llm'

describe('estimateUsageCost', () => {
  it('prices every reported bucket at its own per-Mtok rate', () => {
    const cost = estimateUsageCost({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 100_000,
    }, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
    expect(cost).toBeCloseTo(3 + 7.5 + 0.6 + 0.375, 10)
  })

  it('prices omitted buckets at zero so a local route states a true zero', () => {
    const cost = estimateUsageCost({ inputTokens: 10, outputTokens: 20 }, { output: 0 })
    expect(cost).toBe(0)
  })

  it('prices cache traffic at zero when the table omits the bucket', () => {
    const cost = estimateUsageCost({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 9_000_000,
    }, { input: 3 })
    expect(cost).toBe(3)
  })

  it('reports nothing when the table declares no rate at all', () => {
    expect(estimateUsageCost({ inputTokens: 10, outputTokens: 10 }, {})).toBeUndefined()
  })
})

class PricedAdapter extends LlmAdapter {
  constructor(private readonly resolved: LlmResolvedModelInfo) {
    super()
  }

  override providerInfo(): LlmProviderInfo {
    return { id: 'priced', name: 'Priced' }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  override resolveModel(): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(this.resolved)
  }

  override async *stream(): AsyncIterable<StreamChunk> {}
}

describe('pricing through the LLM runtime', () => {
  it('validates and detaches adapter-declared pricing', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['priced'], new PricedAdapter({
      provider: 'priced', id: 'rate-card', name: 'Rate Card', pricing: { input: 1 },
    }))
    await expect(ctx.llm.resolveModelInfo('priced', 'rate-card'))
      .resolves.toMatchObject({ pricing: { input: 1 } })
    await ctx.fiber.dispose()
  })

  it('refuses adapter pricing that is not a finite non-negative rate', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['priced'], new PricedAdapter({
      provider: 'priced', id: 'bad', name: 'Bad', pricing: { input: -2 },
    }))
    await expect(ctx.llm.resolveModelInfo('priced', 'bad')).rejects.toThrow(/invalid pricing metadata/)
    await ctx.fiber.dispose()
  })
})
