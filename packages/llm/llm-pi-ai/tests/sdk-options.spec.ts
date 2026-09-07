import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const streamSimple = vi.hoisted(() => vi.fn())

// A hand-declared route is built by `createProvider` over the protocol table in
// `src/provider.ts`, so the table's lazy api module is the SDK boundary this
// test can observe. A catalog route dispatches through pi-ai's own provider and
// would not see this mock.
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: streamSimple, streamSimple }),
}))

// The Responses protocol module joins the mock table so a route may name it:
// the reasoning summary mode rides that protocol's payload hook.
vi.mock('@earendil-works/pi-ai/api/openai-responses.lazy', () => ({
  openAIResponsesApi: () => ({ stream: streamSimple, streamSimple }),
}))

import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

afterEach(() => { streamSimple.mockReset() })

/** A hand-declared OpenAI-compatible route with one fully described model. */
function gatewayAdapter(extra: {
  env?: Record<string, string>
  api?: 'openai-completions' | 'openai-responses'
  reasoning?: 'low' | 'high'
  model?: Record<string, unknown>
} = {}): PiAiAdapter {
  const { model: modelFields, ...route } = extra
  return new PiAiAdapter({
    profiles: () => resolveProfiles({
      'local-gateway': {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: 'local-model', contextWindow: 8192, maxTokens: 1024, ...modelFields }],
        ...route,
      },
    }),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
}

async function drain(adapter: PiAiAdapter, model = 'local-model'): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'local-gateway',
    model,
    messages: [],
  })) chunks.push(chunk)
  return chunks
}

describe('pi-ai SDK retry boundary', () => {
  it('pins one SDK attempt even when the installed provider currently defaults to zero retries', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    const chunks = await drain(gatewayAdapter())

    expect(streamSimple).toHaveBeenCalledOnce()
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 0, apiKey: 'test-key' })
    // pi-ai reports a setup failure as a terminal in-stream error rather than
    // throwing, which the converter turns into the harness error finish.
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'mock SDK boundary' } },
    })
  })

  it('dispatches a hand-declared route to the endpoint and model its configuration describes', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter())

    expect(streamSimple.mock.calls[0]?.[0]).toMatchObject({
      id: 'local-model',
      provider: 'local-gateway',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      contextWindow: 8192,
      maxTokens: 1024,
    })
  })
})

describe('profile provider env overlay', () => {
  it('forwards the overlay onto the SDK request so provider discovery reads it', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter({ env: { AWS_REGION: 'eu-central-1' } }))

    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ env: { AWS_REGION: 'eu-central-1' } })
  })

  it('sends no overlay for the empty block the schema materializes for an absent key', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter({ env: {} }))

    // pi-ai's request layer always carries an `env` key; no overlay means it resolves to none.
    expect((streamSimple.mock.calls[0]?.[2] as { env?: unknown }).env).toBeUndefined()
  })

  it('sends no overlay when the profile declares none', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter())

    expect((streamSimple.mock.calls[0]?.[2] as { env?: unknown }).env).toBeUndefined()
  })

  it('detaches the overlay from the configuration object', () => {
    const source = { env: { FOO: 'bar' } }
    const resolved = resolveProfiles({
      'local-gateway': {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: 'local-model', contextWindow: 8192, maxTokens: 1024 }],
        ...source,
      },
    }).get('local-gateway')
    source.env.FOO = 'changed'
    expect(resolved?.env).toEqual({ FOO: 'bar' })
  })
})

describe('per-model reasoning defaults and summary mode', () => {
  it('sends the model default effort when the caller names none, over the route default', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter({
      reasoning: 'low',
      model: { reasoningEfforts: { low: 'low', high: 'high' }, defaultReasoningEffort: 'high' },
    }))

    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ reasoning: 'high' })
  })

  it('surfaces the model default effort in resolved metadata', async () => {
    const adapter = gatewayAdapter({
      model: { reasoningEfforts: { low: 'low', high: 'high' }, defaultReasoningEffort: 'high' },
    })

    const info = await adapter.resolveModel('local-gateway', 'local-model')

    expect(info.reasoning?.defaultEffort).toBe('high')
  })

  it('stamps the configured summary mode onto the finished request body', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter({
      api: 'openai-responses',
      model: { reasoningEfforts: { low: 'low' }, reasoningSummary: 'detailed' },
    }))

    const { onPayload } = streamSimple.mock.calls[0]?.[2] as { onPayload?: (payload: unknown) => { reasoning?: Record<string, unknown> } }
    expect(typeof onPayload).toBe('function')
    // The hook merges into whatever reasoning the protocol's own builder put on
    // the body, and states the mode alone when the request carries none.
    expect(onPayload?.({ reasoning: { effort: 'high' } }).reasoning).toEqual({ effort: 'high', summary: 'detailed' })
    expect(onPayload?.({}).reasoning).toEqual({ summary: 'detailed' })
  })

  it('omits the summary pi-ai injects when the model declares no summary mode', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter({
      api: 'openai-responses',
      model: { reasoningEfforts: { low: 'low' } },
    }))

    const { onPayload } = streamSimple.mock.calls[0]?.[2] as { onPayload?: (payload: unknown) => { reasoning?: Record<string, unknown> } }
    // The Responses builder's own `auto` default is stripped from the body...
    expect(onPayload?.({ reasoning: { effort: 'high', summary: 'auto' } }).reasoning).toEqual({ effort: 'high' })
    // ...a body whose reasoning carries none is left untouched, and one carrying
    // no reasoning at all gains nothing, so no summary ever reaches the wire.
    const untouched = { reasoning: { effort: 'high' } }
    expect(onPayload?.(untouched)).toBe(untouched)
    expect(onPayload?.({})).toEqual({})
  })

  it('omits the summary for the config-only off mode and never sends the word', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter({
      api: 'openai-responses',
      model: { reasoningEfforts: { low: 'low' }, reasoningSummary: 'off' },
    }))

    const { onPayload } = streamSimple.mock.calls[0]?.[2] as { onPayload?: (payload: unknown) => { reasoning?: Record<string, unknown> } }
    const stripped = onPayload?.({ reasoning: { effort: 'high', summary: 'auto' } }) ?? {}
    expect(stripped.reasoning).toEqual({ effort: 'high' })
    expect(JSON.stringify(stripped)).not.toContain('off')
    expect(onPayload?.({})).toEqual({})
  })
})
