/** Purpose routing layered over a real settings provider. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ModelRoutingConfig, { assertServiceable, MODEL_ROUTING_SETTINGS_NAMESPACE } from '../src/index.ts'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function boot(section: Record<string, unknown> = {}): Promise<{
  ctx: Context
  settingsFiber: Context['fiber']
  routing: ModelRoutingConfig
}> {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  await ctx.plugin(ModelRoutingConfig, section)
  return { ctx, settingsFiber, routing: ctx.modelRouting }
}

describe('ModelRoutingConfig', () => {
  it('resolves an exact purpose over the tier', async () => {
    const bench = await boot({
      smallFast: { provider: 'small-route', model: 'small-model' },
      purposes: { compaction: { provider: 'summarizer-route', model: 'summarizer-model' } },
    })
    expect(bench.routing.selection({ purpose: 'compaction', tier: 'smallFast' })).toEqual({
      provider: 'summarizer-route', model: 'summarizer-model',
    })
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the tier when the purpose declares no selection', async () => {
    const bench = await boot({ smallFast: { provider: 'small-route', model: 'small-model' } })
    expect(bench.routing.selection({ purpose: 'session-title', tier: 'smallFast' })).toEqual({
      provider: 'small-route', model: 'small-model',
    })
    await bench.ctx.fiber.dispose()
  })

  it('states no routing when the deployment declared none', async () => {
    const bench = await boot()
    expect(bench.routing.selection({ purpose: 'compaction', tier: 'smallFast' })).toBeUndefined()
    expect(bench.routing.selection({})).toBeUndefined()
    await bench.ctx.fiber.dispose()
  })

  it('reads the composition entry when the deployment has no settings service', async () => {
    const ctx = new Context()
    await ctx.plugin(ModelRoutingConfig, { smallFast: { provider: 'entry-route', model: 'entry-model' } })
    expect(ctx.modelRouting.selection({ purpose: 'compaction', tier: 'smallFast' })).toEqual({
      provider: 'entry-route', model: 'entry-model',
    })
    await ctx.fiber.dispose()
  })

  it('accepts a raw section that routes nothing', () => {
    expect(() => { assertServiceable({}) }).not.toThrow()
  })

  it('carries a declared reasoning effort onto the selection', async () => {
    const bench = await boot({ purposes: { compaction: { provider: 'p', model: 'm', reasoningEffort: 'low' } } })
    expect(bench.routing.selection({ purpose: 'compaction' })).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'low' })
    await bench.ctx.fiber.dispose()
  })

  it('layers a user section over the composition entry and stays live', async () => {
    const bench = await boot({ smallFast: { provider: 'entry-route', model: 'entry-model' } })
    await bench.settingsFiber.ctx.settings.replace(MODEL_ROUTING_SETTINGS_NAMESPACE, {
      purposes: { sessionTitle: { provider: 'title-route', model: 'title-model' } },
    })
    expect(bench.routing.selection({ purpose: 'session-title', tier: 'smallFast' })).toEqual({
      provider: 'title-route', model: 'title-model',
    })
    expect(bench.routing.selection({ purpose: 'compaction', tier: 'smallFast' })).toEqual({
      provider: 'entry-route', model: 'entry-model',
    })
    await bench.ctx.fiber.dispose()
  })

  it('refuses a half-declared selection where it is written', async () => {
    const bench = await boot()
    await expect(bench.settingsFiber.ctx.settings.replace(MODEL_ROUTING_SETTINGS_NAMESPACE, {
      smallFast: { provider: 'route-only' },
    })).rejects.toThrow(/must name provider and model together/)
    await bench.ctx.fiber.dispose()
  })

  it('refuses a half-declared composition entry at load', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(ModelRoutingConfig, { smallFast: { model: 'model-only' } }))
      .rejects.toThrow(/smallFast must name provider and model together/)
    await ctx.fiber.dispose()
  })
})
