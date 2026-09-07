/**
 * File-backed settings provider. A primary YAML or JSON document under the
 * user's harness home carries every namespace section that no split document
 * owns, and optional split documents — configured by path and owned
 * namespaces — carry the rest; a routed namespace therefore has exactly one
 * file home. External edits hot-publish through the seam, and every write
 * re-reads every document under a cross-process writer lock before patching
 * the owning document as a comment-preserving leaf-level diff.
 * @module @deepseek-ai/dsh-settings-file
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { watch as chokidarWatch } from 'chokidar'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { Document, parseDocument } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { canonicalizeWatchPath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'

/** One split document and the namespaces it owns outright. */
export interface SettingsSplitDocument {
  /** Split document path; a relative path resolves against the primary document's directory. */
  path: string
  /** Namespaces this document owns; a section for one of them anywhere else is a ghost the provider migrates or ignores. */
  namespaces: string[]
}

/** Plugin config: file locations, namespace routing, and hot-reload behavior. */
export interface Config {
  /** Primary settings document path; defaults to `settings.yaml` under the harness home. */
  path?: string
  /** Harness home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /**
   * Split documents owning the listed namespaces, such as a
   * `model-settings.yaml` carrying the model-related sections. The primary
   * document owns every namespace no split lists.
   */
  documents?: SettingsSplitDocument[]
  /** Watch the documents and hot-publish external edits; defaults to true. */
  watch?: boolean
  /** Watcher write-settle window in milliseconds; defaults to 100. */
  debounceMs?: number
}

/** Document format derived from the configured file extension. */
type SettingsFormat = 'yaml' | 'json'

const FORMATS: Record<string, SettingsFormat> = {
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
}

/** One validated split document. */
export interface ResolvedSplit {
  filename: string
  format: SettingsFormat
  namespaces: ReadonlySet<string>
}

/** Fully resolved provider parameters; defaulting happens here, never inline. */
interface ResolvedSpec {
  filename: string
  format: SettingsFormat
  /** Split documents in configuration order; the primary owns everything else. */
  splits: readonly ResolvedSplit[]
  /** The document that owns each routed namespace. */
  owner: ReadonlyMap<string, ResolvedSplit>
  watch: boolean
  debounceMs: number
}

/**
 * Resolve the runtime spec from plugin config: an explicit `path` wins,
 * otherwise the primary document lives at `<harness home>/settings.yaml`;
 * every split path resolves against the primary's directory and is checked
 * for the collisions that would leave a written section without an owner.
 * @param config - raw plugin config.
 * @returns the resolved file locations, routing, format, and watch behavior.
 * @throws Error when two splits route one namespace, share a path, name the
 * primary document, or carry an empty path or namespace.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  const filename = resolve(config.path ?? join(resolveDshHome(config.dshHome), 'settings.yaml'))
  const format = FORMATS[extname(filename)]
  if (format === undefined) {
    throw new Error(`settings-file: extension "${extname(filename)}" is not supported (use .yaml, .yml, or .json)`)
  }
  const splits: ResolvedSplit[] = []
  const owner = new Map<string, ResolvedSplit>()
  for (const entry of config.documents ?? []) {
    if (entry.path.trim().length === 0) {
      throw new Error('settings-file: a documents entry must name a path')
    }
    const splitName = resolve(dirname(filename), entry.path)
    const splitFormat = FORMATS[extname(splitName)]
    if (splitFormat === undefined) {
      throw new Error(`settings-file: extension "${extname(splitName)}" is not supported (use .yaml, .yml, or .json)`)
    }
    if (splitName === filename) {
      throw new Error(`settings-file: split document "${entry.path}" is the primary document itself`)
    }
    if (splits.some(split => split.filename === splitName)) {
      throw new Error(`settings-file: documents entry "${entry.path}" repeats a split document path`)
    }
    if (entry.namespaces.length === 0) {
      throw new Error(`settings-file: split document "${entry.path}" must own at least one namespace`)
    }
    const names = new Set<string>()
    const split: ResolvedSplit = { filename: splitName, format: splitFormat, namespaces: names }
    for (const ns of entry.namespaces) {
      if (ns.trim().length === 0) {
        throw new Error(`settings-file: split document "${entry.path}" owns an empty namespace name`)
      }
      const previous = owner.get(ns)
      if (previous !== undefined) {
        throw new Error(
          `settings-file: namespace "${ns}" is owned by both "${previous.filename}" and "${splitName}";`
          + ' a section with two homes resolves by accident',
        )
      }
      names.add(ns)
      owner.set(ns, split)
    }
    splits.push(split)
  }
  return {
    filename,
    format,
    splits,
    owner,
    watch: config.watch ?? true,
    debounceMs: config.debounceMs ?? 100,
  }
}

/** Whether a parsed YAML value is a map for diffing purposes. */
function isMapLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Apply the difference between one node's stored and next value as minimal
 * `setIn`/`deleteIn` edits, recursing through maps, so every untouched node —
 * and the key node of every changed pair — keeps its comments, anchors, and
 * formatting. Non-map values (arrays and scalars) replace wholesale when
 * unequal, taking any comments inside them along.
 */
function patchNode(document: Document, path: readonly string[], current: unknown, next: unknown): void {
  if (isMapLike(current) && isMapLike(next)) {
    for (const key of Object.keys(current)) {
      if (!(key in next)) document.deleteIn([...path, key])
    }
    for (const [key, value] of Object.entries(next)) {
      patchNode(document, [...path, key], current[key], value)
    }
    return
  }
  if (!deepEqualJson(current, next)) document.setIn([...path], next)
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Whether an exclusive file create found an existing document. */
function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

/** File-backed settings provider (`settings.yaml`/`.json` plus split documents). */
export class FileSettingsProvider extends SettingsProvider {
  static Config: z<Config> = z.object({
    path: z.string(),
    dshHome: z.string(),
    documents: z.array(z.object({
      path: z.string().required(),
      namespaces: z.array(z.string().required()).required(),
    })),
    watch: z.boolean().default(true),
    debounceMs: z.number().min(0).default(100),
  })

  private readonly spec: ResolvedSpec
  /**
   * Raw text of the last successfully parsed or persisted content per
   * document, `undefined` while that file is absent. Watcher events whose
   * content equals these caches are no-ops, which is also the self-write
   * suppression.
   */
  private texts = new Map<string, string | undefined>()
  /** Parsed sections per document; absent files hold the empty document. */
  private docs = new Map<string, Record<string, unknown>>()
  /**
   * Single exclusive operation chain: watcher reloads and document writes run
   * one at a time in queue order (settled tail), so a write can never render
   * from text a concurrent reload is busy replacing, and a reload can never
   * read a half-committed write.
   */
  private operations: Promise<void> = Promise.resolve()
  /** Set at dispose: refuse new watcher events and let in-flight work no-op. */
  private closed = false

  /** Opaque read of {@link closed}: control flow cannot narrow it across awaits. */
  private isClosed(): boolean {
    return this.closed
  }

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Programmatic construction may bypass Schemastery normalization; resolve
    // the same defaults in one explicit step either way.
    this.spec = resolveSpec(config)
  }

  /** The local document is always writable through {@link SettingsProvider.update}. */
  get writable(): boolean {
    return true
  }

  /** The resolved primary document path exposed to local configuration surfaces. */
  override get documentPath(): string {
    return this.spec.filename
  }

  /** Materialize an absent owner-only primary document, then return its resolved path. */
  override prepareDocument(): Promise<string> {
    return this.enqueue(async () => {
      await this.patchFile(this.spec, async () => {
        try {
          await writeFile(this.spec.filename, '', { flag: 'wx', mode: 0o600 })
        } catch (error) {
          if (isEEXIST(error)) return
          throw error
        }
        this.texts.set(this.spec.filename, '')
        this.docs.set(this.spec.filename, {})
      })
      if (!this.isClosed()) this.publish(this.compose())
      return this.spec.filename
    })
  }

  /**
   * Read every document, migrate ghost sections written outside their owning
   * document, and return the merged raw document. An existing-but-invalid
   * document fails boot rather than being silently ignored or overwritten.
   */
  protected async load(): Promise<Record<string, unknown>> {
    await this.readDocuments()
    await this.migrateGhosts()
    return this.compose()
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    // Every namespace's write routes to its owning document, so writes from
    // different namespace queues serialize with each other and with watcher
    // reloads on the one operation chain: each render must see the text the
    // previous operation committed, or a sibling section silently vanishes.
    return this.enqueue(async () => {
      const target = this.spec.owner.get(ns) ?? this.spec
      await this.patchFile(target, async () => {
        // Fold under the writer lock: an external edit or sibling write that
        // committed while this operation waited must reach the render below,
        // and its sections publish exactly as a reload would publish them.
        const changed = await this.reconcileFromDisk()
        if (changed && !this.isClosed()) this.publish(this.compose())
        const output = this.renderPatch(target.filename, ns, this.docs.get(target.filename)?.[ns], section)
        await writeFileAtomic(target.filename, output, { mode: 0o600, dirMode: 0o700 })
        this.texts.set(target.filename, output)
        /* v8 ignore next -- the fold's read commits a parsed tree for every document, including this one */
        const doc = this.docs.get(target.filename) ?? {}
        doc[ns] = section
        this.docs.set(target.filename, doc)
      })
    })
  }

  /** Queue one exclusive document operation behind every earlier one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  /** Queue a reload; only an invariant violation escaping a commit can reject it. */
  private queueRefresh(): void {
    void this.enqueue(() => this.refresh()).catch((error: unknown) => {
      // Only an invariant violation escaping the commit path can reject a
      // refresh; keep the operation queue alive and surface it as an error so
      // one poisoned commit cannot silently end hot reloading forever.
      this.ctx.logger.error('settings-file: reload commit failed; keeping the last good documents')
      this.ctx.logger.error(error)
    })
  }

  /** Run one operation with the document's parent directory created owner-only. */
  private async patchFile(target: { filename: string }, operation: () => Promise<void>): Promise<void> {
    // The writer lock's exclusive create needs the parent to exist before
    // writeFileAtomic (or the bare create) gets its own chance to make it.
    // 0700: the harness home holds user-private documents.
    await mkdir(dirname(target.filename), { recursive: true, mode: 0o700 })
    await withFileLock(target.filename, operation)
  }

  override async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield* super[Service.init]()
    const paths = [this.spec.filename, ...this.spec.splits.map(split => split.filename)]
    const watcher = this.spec.watch
      ? chokidarWatch(await Promise.all(paths.map(path => canonicalizeWatchPath(path))), {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: this.spec.debounceMs,
          pollInterval: Math.max(1, Math.min(this.spec.debounceMs, 10)),
        },
      })
      : undefined
    if (watcher !== undefined) {
      watcher.on('all', () => {
        if (this.closed) return
        this.queueRefresh()
      })
      watcher.on('ready', () => {
        // The base init's load raced the watcher's own setup: a change written
        // between that read and the watcher becoming active never fires an
        // event. One reconcile at ready closes the gap.
        if (this.closed) return
        this.queueRefresh()
      })
      watcher.on('error', (error) => {
        this.ctx.logger.warn('settings-file: watcher error; hot reload continues')
        this.ctx.logger.warn(error)
      })
    }
    yield async () => {
      // Quiesce every operation chain, even when no watcher is configured.
      this.closed = true
      await watcher?.close()
      await this.operations
    }
  }

  /** Parse one document text into raw sections, failing on a non-map root. */
  private parse(filename: string, text: string): Record<string, unknown> {
    let root: unknown
    if (FORMATS[extname(filename)] === 'yaml') {
      // `prettyErrors` is on only for `linePos`; `error.message` is never
      // used, because the parser quotes the offending source line and a
      // settings document can hold a `role('secret')` value.
      const document = parseDocument(text, { prettyErrors: true })
      if (document.errors.length > 0) {
        throw new Error(`settings-file: invalid document at ${filename}: ${
          document.errors.map((error) => {
            const at = error.linePos?.[0]
            /* v8 ignore next -- `prettyErrors` populates linePos on every error; the guard answers its optional type */
            return `${error.code}${at === undefined ? '' : ` at line ${String(at.line)}, column ${String(at.col)}`}`
          }).join('; ')}`)
      }
      root = document.toJS() ?? {}
    } else {
      root = text.trim().length === 0 ? {} : JSON.parse(text)
    }
    if (typeof root !== 'object' || root === null || Array.isArray(root)) {
      throw new TypeError(`settings-file: ${filename} must be a map of namespace sections`)
    }
    return root as Record<string, unknown>
  }

  /**
   * Read and parse every document whose text changed since the cache; an
   * absent file parses as the empty document. A read or parse failure throws
   * before any cache it could corrupt is touched, so each caller picks its
   * policy: a reload warns and keeps the last good document, boot and writes
   * fail loud.
   */
  private async readDocuments(): Promise<void> {
    const files = [this.spec.filename, ...this.spec.splits.map(split => split.filename)]
    const observed = new Map<string, string | undefined>()
    for (const filename of files) {
      let text: string | undefined
      try {
        text = await readFile(filename, 'utf8')
      } catch (error) {
        if (!isENOENT(error)) throw error
        text = undefined
      }
      observed.set(filename, text)
    }
    for (const [filename, text] of observed) {
      if (text === undefined) {
        this.texts.set(filename, undefined)
        this.docs.set(filename, {})
        continue
      }
      if (text === this.texts.get(filename)) continue
      // Parse before admitting the new text: a document that fails to parse
      // must leave its previous text and tree both in place, so a later
      // watcher event still sees the change and retries it.
      const doc = this.parse(filename, text)
      this.texts.set(filename, text)
      this.docs.set(filename, doc)
    }
  }

  /**
   * Move a routed section written outside its owning document into the owner
   * and drop stale copies, so routing leaves every namespace exactly one home
   * before the first publish. Boot-only: a hot-reload ghost is composed out
   * and warned about rather than written back.
   */
  private async migrateGhosts(): Promise<void> {
    for (const [ns, split] of this.spec.owner) {
      /* v8 ignore next -- load's read commits a parsed tree for every document before migration */
      const ownerDoc = this.docs.get(split.filename) ?? {}
      let ownerHas = ns in ownerDoc
      for (const [filename, doc] of this.docs) {
        if (filename === split.filename || !(ns in doc)) continue
        const ghost = doc[ns]
        if (!ownerHas) {
          await this.patchFile({ filename: split.filename }, async () => {
            const output = this.renderPatch(split.filename, ns, undefined, ghost)
            await writeFileAtomic(split.filename, output, { mode: 0o600, dirMode: 0o700 })
            this.texts.set(split.filename, output)
          })
          ownerDoc[ns] = ghost
          this.docs.set(split.filename, ownerDoc)
          ownerHas = true
          this.ctx.logger.info('settings-file: moved settings section "%s" into %s', ns, split.filename)
        } else {
          this.ctx.logger.warn('settings-file: dropping section "%s" from %s; %s owns it', ns, filename, split.filename)
        }
        await this.patchFile({ filename }, async () => {
          const output = this.renderPatch(filename, ns, ghost, undefined)
          await writeFileAtomic(filename, output, { mode: 0o600, dirMode: 0o700 })
          this.texts.set(filename, output)
        })
        this.docs.set(filename, Object.fromEntries(Object.entries(doc).filter(([key]) => key !== ns)))
      }
    }
  }

  /**
   * Merge the parsed documents into one raw seam document: the primary keeps
   * every section no split owns, each routed section comes only from its
   * owner, and a ghost — a routed section stored outside its owning document,
   * left by an external edit — is composed out with a warning naming the file
   * that owns the namespace. A key no split routes stays in place, with the
   * primary document's copy winning over a stray copy in a split.
   */
  private compose(): Record<string, unknown> {
    let merged: Record<string, unknown> = { ...this.docs.get(this.spec.filename) }
    for (const [ns, split] of this.spec.owner) {
      if (ns in merged) {
        merged = Object.fromEntries(Object.entries(merged).filter(([key]) => key !== ns))
        this.ctx.logger.warn('settings-file: section "%s" is owned by %s, not the primary document', ns, split.filename)
      }
      const doc = this.docs.get(split.filename)
      if (doc !== undefined && ns in doc) merged[ns] = doc[ns]
    }
    for (const split of this.spec.splits) {
      /* v8 ignore next -- every compose runs after a read that commits a parsed tree for every document */
      const doc = this.docs.get(split.filename) ?? {}
      for (const [key, value] of Object.entries(doc)) {
        if (split.namespaces.has(key)) continue
        const owner = this.spec.owner.get(key)
        if (owner === undefined && !(key in merged)) {
          merged[key] = value
          continue
        }
        this.ctx.logger.warn('settings-file: ignoring section "%s" in %s; %s owns it',
          key, split.filename, owner?.filename ?? this.spec.filename)
      }
    }
    return merged
  }

  /**
   * Re-read every document after a watcher event. Unchanged content (including
   * this provider's own writes) is a no-op; an unreadable or unparsable
   * document keeps the last good sections and warns — a live hot-reload must
   * never take the process down. An invariant violation escaping a commit is
   * not a reload failure and propagates to the queue's error surface.
   */
  private async refresh(): Promise<void> {
    if (this.closed) return
    try {
      const changed = await this.reconcileFromDisk()
      if (changed) this.publish(this.compose())
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'INVARIANT') throw error
      this.ctx.logger.warn('settings-file: reload failed; keeping the last good documents')
      this.ctx.logger.warn(error)
    }
  }

  /** Snapshot of every document's cached text; identical snapshots publish nothing new. */
  private publishedTexts(): string {
    const files = [this.spec.filename, ...this.spec.splits.map(split => split.filename)]
    return JSON.stringify(files.map(filename => this.texts.get(filename) ?? null))
  }

  /**
   * Read every document and report whether any text changed; failures
   * propagate so each caller picks its policy.
   */
  private async reconcileFromDisk(): Promise<boolean> {
    const before = this.publishedTexts()
    await this.readDocuments()
    return this.publishedTexts() !== before
  }

  /**
   * Render the next text for one document by patching one namespace in its
   * comment-preserving tree. The next section lands as a leaf-level diff
   * against the stored one — only changed values set, only removed keys
   * delete — so comments inside the section survive edits to their siblings,
   * not just comments outside it. A document whose file is absent renders as a
   * new single-section document.
   */
  private renderPatch(filename: string, ns: string, current: unknown, next: unknown): string {
    const text = this.texts.get(filename)
    if (FORMATS[extname(filename)] === 'json') {
      const root = text === undefined ? {} : this.parse(filename, text)
      const updated = next === undefined
        ? Object.fromEntries(Object.entries(root).filter(([key]) => key !== ns))
        : { ...root, [ns]: next }
      return `${JSON.stringify(updated, null, 2)}\n`
    }
    if (text === undefined) {
      /* v8 ignore next -- a delete only ever patches a document whose text the provider just parsed */
      return next === undefined ? '' : new Document({ [ns]: next }).toString()
    }
    // The cached text only ever holds content that parsed successfully, so
    // this re-parse (for the mutable comment-preserving tree) cannot fail.
    const document = parseDocument(text)
    if (next === undefined) document.deleteIn([ns])
    else patchNode(document, [ns], current, next)
    return document.toString()
  }
}

export default FileSettingsProvider
