/**
 * Configured per-model pricing: the catalog block reaches
 * `resolveModel().pricing` and rates the entry does not declare stay absent.
 */
import { describe, expect, it, vi } from 'vitest'
import { afterEach } from 'vitest'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { PreparedDeepSeekLlmApiExtensions } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'

const TEST_USER_ID = '00000000-0000-4000-8000-000000000001' as AnonymousUserId

function adapterOf(models: LlmDeepSeek.DeepSeekCatalogModel[]): DeepSeekAdapter {
  return new DeepSeekAdapter({
    options: () => resolveAdapterOptions({ models }),
    resolveApiKey: () => Promise.resolve('k'),
    resolveUserId: () => TEST_USER_ID,
    prepareExtensions: (): Promise<PreparedDeepSeekLlmApiExtensions> =>
      Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('configured model pricing', () => {
  it('carries declared rates onto the resolved model entry', async () => {
    const adapter = adapterOf([
      { id: 'rate-card', pricing: { input: 0.27, output: 1.1, cacheRead: 0.07 } },
      { id: 'unpriced' },
    ])
    await expect(adapter.resolveModel('deepseek-official', 'rate-card'))
      .resolves.toMatchObject({ pricing: { input: 0.27, output: 1.1, cacheRead: 0.07 } })
    const unpriced = await adapter.resolveModel('deepseek-official', 'unpriced')
    expect('pricing' in unpriced).toBe(false)
  })

  it('reads an empty pricing block as no rates declared', async () => {
    const adapter = adapterOf([{ id: 'bare', pricing: {} }])
    const info = await adapter.resolveModel('deepseek-official', 'bare')
    expect('pricing' in info).toBe(false)
  })

  it('refuses a negative rate, naming the model and field', () => {
    expect(() => resolveAdapterOptions({ models: [{ id: 'bad', pricing: { output: -1 } }] }))
      .toThrow(/catalog model "bad" pricing\.output must be a finite non-negative number/)
  })

  it('refuses a non-finite rate, naming the model and field', () => {
    expect(() => resolveAdapterOptions({ models: [{ id: 'bad', pricing: { input: Number.NaN } }] }))
      .toThrow(/catalog model "bad" pricing\.input must be a finite non-negative number/)
  })
})
