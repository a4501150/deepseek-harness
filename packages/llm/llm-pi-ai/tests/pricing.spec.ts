/**
 * Configured per-model pricing: the profile block reaches
 * `resolveModelInfo().pricing` and nothing else states rates.
 */
import { describe, expect, it, vi } from 'vitest'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

const ROUTE = {
  api: 'openai-completions',
  baseURL: 'https://acme.test',
} as const

describe('configured model pricing', () => {
  it('carries declared rates to the route profile keyed by model id', () => {
    const resolved = resolveProfiles({
      'acme-gateway': {
        ...ROUTE,
        models: [
          { id: 'rate-card', pricing: { input: 0.25, output: 2, cacheRead: 0.03, cacheWrite: 0.3 } },
          { id: 'unpriced' },
        ],
      },
    })
    const profile = resolved.get('acme-gateway')
    expect(profile?.configuredPricing.get('rate-card'))
      .toEqual({ input: 0.25, output: 2, cacheRead: 0.03, cacheWrite: 0.3 })
    expect(profile?.configuredPricing.has('unpriced')).toBe(false)
  })

  it('reads an empty pricing block as no rates declared', () => {
    const resolved = resolveProfiles({
      'acme-gateway': { ...ROUTE, models: [{ id: 'bare', pricing: {} }] },
    })
    expect(resolved.get('acme-gateway')?.configuredPricing.has('bare')).toBe(false)
  })

  it('keeps a catalog route pricing-free until a modelOverrides entry declares rates', () => {
    const resolved = resolveProfiles({
      anthropic: { modelOverrides: { 'claude-sonnet-4-5': { pricing: { input: 3, output: 15 } } } },
    })
    expect(resolved.get('anthropic')?.configuredPricing.get('claude-sonnet-4-5'))
      .toEqual({ input: 3, output: 15 })
  })

  it('refuses a negative rate, naming the model and field', () => {
    expect(() => resolveProfiles({
      'acme-gateway': { ...ROUTE, models: [{ id: 'bad', pricing: { input: -1 } }] },
    })).toThrow(/model "bad" pricing\.input/)
  })

  it('refuses a non-finite rate, naming the model and field', () => {
    expect(() => resolveProfiles({
      'acme-gateway': { ...ROUTE, models: [{ id: 'bad', pricing: { output: Number.POSITIVE_INFINITY } }] },
    })).toThrow(/model "bad" pricing\.output/)
  })

  it('surfaces configured pricing through resolved model metadata', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const profiles: Record<string, PiAiProviderProfile> = {
      'acme-gateway': { ...ROUTE, apiKeyEnv: 'PI_TEST_KEY', models: [{ id: 'rate-card', pricing: { input: 1 } }] },
    }
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles(profiles),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
    })
    await expect(adapter.resolveModel('acme-gateway', 'rate-card'))
      .resolves.toMatchObject({ pricing: { input: 1 } })
  })
})
