import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSettingsProvider, resolveSpec } from '../src/index.ts'

type ProviderConfig = ConstructorParameters<typeof FileSettingsProvider>[1]

const ThemeSchema: z<{ theme: 'dark' | 'light'; fontSize: number }> = z.object({
  theme: z.union(['dark', 'light']).default('dark'),
  fontSize: z.number().default(14),
})

const KeepSchema: z<{ keep: string }> = z.object({ keep: z.string().default('') })

const ValueSchema: z<{ x: number }> = z.object({ x: z.number().default(0) })

const ROUTING = [{ path: 'model-settings.yaml', namespaces: ['accel'] }]

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-settings-split-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(dir: string, options: Partial<ProviderConfig> = {}): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(FileSettingsProvider, {
    path: join(dir, 'settings.yaml'),
    documents: ROUTING,
    watch: false,
    ...options,
  })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('resolveSpec split documents', () => {
  const primary = { path: '/home/u/settings.yaml' }

  it('resolves split paths against the primary document directory', () => {
    const spec = resolveSpec({ ...primary, documents: ROUTING })
    expect(spec.splits.map(split => split.filename)).toEqual(['/home/u/model-settings.yaml'])
    expect(spec.owner.get('accel')?.filename).toBe('/home/u/model-settings.yaml')
    expect(spec.owner.get('accel')?.namespaces.has('accel')).toBe(true)
  })

  it('rejects a split entry that names no path', () => {
    expect(() => resolveSpec({ ...primary, documents: [{ path: ' ', namespaces: ['accel'] }] }))
      .toThrow(/must name a path/)
  })

  it('rejects a split document with an unsupported extension', () => {
    expect(() => resolveSpec({ ...primary, documents: [{ path: 'models.toml', namespaces: ['accel'] }] }))
      .toThrow(/not supported/)
  })

  it('rejects a split document that is the primary document itself', () => {
    expect(() => resolveSpec({ ...primary, documents: [{ path: 'settings.yaml', namespaces: ['accel'] }] }))
      .toThrow(/primary document itself/)
  })

  it('rejects a repeated split document path', () => {
    expect(() => resolveSpec({
      ...primary,
      documents: [
        { path: 'model-settings.yaml', namespaces: ['accel'] },
        { path: './model-settings.yaml', namespaces: ['other'] },
      ],
    })).toThrow(/repeats a split document path/)
  })

  it('rejects a split document that owns no namespaces', () => {
    expect(() => resolveSpec({ ...primary, documents: [{ path: 'model-settings.yaml', namespaces: [] }] }))
      .toThrow(/must own at least one namespace/)
  })

  it('rejects an empty namespace name in a split document', () => {
    expect(() => resolveSpec({ ...primary, documents: [{ path: 'model-settings.yaml', namespaces: [' '] }] }))
      .toThrow(/empty namespace name/)
  })

  it('rejects a namespace owned by two split documents', () => {
    expect(() => resolveSpec({
      ...primary,
      documents: [
        { path: 'a-settings.yaml', namespaces: ['accel'] },
        { path: 'b-settings.yaml', namespaces: ['accel'] },
      ],
    })).toThrow(/owned by both .*a-settings\.yaml.*b-settings\.yaml/)
  })
})

describe('split document routing', () => {
  it('reads routed sections from the split document at boot', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'settings.yaml'), 'ui-theme:\n  theme: light\n')
    await writeFile(join(dir, 'model-settings.yaml'), 'accel:\n  fontSize: 20\n')
    const ctx = await boot(dir)
    expect(ctx.settings.register('ui-theme', ThemeSchema).get()).toEqual({ theme: 'light', fontSize: 14 })
    expect(ctx.settings.register('accel', ThemeSchema).get()).toEqual({ theme: 'dark', fontSize: 20 })
  })

  it('writes each section to its owning document', async () => {
    const dir = await tempDir()
    const ctx = await boot(dir)
    await ctx.settings.register('ui-theme', ThemeSchema).update({ theme: 'light' })
    await ctx.settings.register('accel', ThemeSchema).update({ fontSize: 20 })

    const primary = await readFile(join(dir, 'settings.yaml'), 'utf8')
    expect(primary).toContain('theme: light')
    expect(primary).not.toContain('accel')

    const split = await readFile(join(dir, 'model-settings.yaml'), 'utf8')
    expect(split).toContain('fontSize: 20')
    expect(split).not.toContain('ui-theme')
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'model-settings.yaml'))).mode & 0o777).toBe(0o600)
    }
  })

  it('moves a routed section found in the primary document into its owner at boot', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'settings.yaml'), 'ui-theme:\n  theme: light\naccel:\n  fontSize: 20\n')
    const ctx = await boot(dir)
    expect(ctx.settings.register('accel', ThemeSchema).get()).toEqual({ theme: 'dark', fontSize: 20 })

    const primary = await readFile(join(dir, 'settings.yaml'), 'utf8')
    expect(primary).toContain('theme: light')
    expect(primary).not.toContain('accel')
    const split = await readFile(join(dir, 'model-settings.yaml'), 'utf8')
    expect(split).toContain('fontSize: 20')
  })

  it('drops a routed ghost when the owning document already has the section', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'settings.yaml'), 'accel:\n  fontSize: 12\n')
    await writeFile(join(dir, 'model-settings.yaml'), 'accel:\n  fontSize: 20\n')
    const ctx = await boot(dir)
    expect(ctx.settings.register('accel', ThemeSchema).get()).toEqual({ theme: 'dark', fontSize: 20 })
    expect(await readFile(join(dir, 'settings.yaml'), 'utf8')).not.toContain('accel')
  })

  it('moves a routed ghost out of a json document', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ accel: { fontSize: 12 }, other: { keep: true } }, null, 2))
    const ctx = await boot(dir, { path: join(dir, 'settings.json') })
    expect(ctx.settings.register('accel', ThemeSchema).get()).toEqual({ theme: 'dark', fontSize: 12 })
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))).toEqual({ other: { keep: true } })
    expect(await readFile(join(dir, 'model-settings.yaml'), 'utf8')).toContain('fontSize: 12')
  })

  it('folds a section a split document holds that no split routes', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'model-settings.yaml'), 'accel:\n  fontSize: 20\norphan:\n  keep: pinned\n')
    const ctx = await boot(dir)
    expect(ctx.settings.register('orphan', KeepSchema).get()).toEqual({ keep: 'pinned' })
  })

  it('keeps the primary copy when a split document repeats an unrouted section', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'settings.yaml'), 'dupe:\n  x: 1\n')
    await writeFile(join(dir, 'model-settings.yaml'), 'dupe:\n  x: 2\n')
    const ctx = await boot(dir)
    const scope = ctx.settings.register('dupe', ValueSchema)
    expect(scope.get()).toEqual({ x: 1 })
    await scope.update({ x: 3 })
    expect(await readFile(join(dir, 'settings.yaml'), 'utf8')).toContain('x: 3')
  })

  it('ignores a routed section held by a split document that does not own it', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'model-settings.yaml'), 'extra:\n  x: 7\n')
    await writeFile(join(dir, 'other.yaml'), 'extra:\n  x: 9\n')
    const ctx = await boot(dir, {
      documents: [
        { path: 'model-settings.yaml', namespaces: ['extra'] },
        { path: 'other.yaml', namespaces: ['unrelated'] },
      ],
    })
    expect(ctx.settings.register('extra', ValueSchema).get()).toEqual({ x: 7 })
  })
})

describe('split documents with the watcher', () => {
  it('publishes an external edit to a split document', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'model-settings.yaml'), 'accel:\n  fontSize: 20\n')
    const ctx = await boot(dir, { watch: true, debounceMs: 10 })
    const scope = ctx.settings.register('accel', ThemeSchema)
    await writeFile(join(dir, 'model-settings.yaml'), 'accel:\n  fontSize: 22\n')
    await vi.waitFor(() => {
      expect(scope.get()).toEqual({ theme: 'dark', fontSize: 22 })
    }, { timeout: 5000 })
  })

  it('composes a routed ghost out of a post-boot primary edit', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'settings.yaml'), 'ui-theme:\n  theme: light\n')
    await writeFile(join(dir, 'model-settings.yaml'), 'accel:\n  fontSize: 20\n')
    const ctx = await boot(dir, { watch: true, debounceMs: 10 })
    const scope = ctx.settings.register('accel', ThemeSchema)
    const theme = ctx.settings.register('ui-theme', ThemeSchema)

    await writeFile(join(dir, 'settings.yaml'), 'ui-theme:\n  theme: dark\naccel:\n  fontSize: 12\n')
    // The reload must publish the legitimate edit while composing the ghost out.
    await vi.waitFor(() => {
      expect(theme.get().theme).toBe('dark')
      expect(scope.get().fontSize).toBe(20)
    }, { timeout: 5000 })

    await scope.update({ fontSize: 22 })
    expect(await readFile(join(dir, 'model-settings.yaml'), 'utf8')).toContain('fontSize: 22')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(scope.get().fontSize).toBe(22)
  })
})
