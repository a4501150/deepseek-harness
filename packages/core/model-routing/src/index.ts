/**
 * Purpose-keyed model routing for background model work.
 *
 * @module @deepseek-ai/dsh-model-routing
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Purpose-keyed routing selection for background model work. */
    modelRouting: ModelRoutingConfig
  }
}

/** Settings namespace carrying the deployment's purpose routing. */
export const MODEL_ROUTING_SETTINGS_NAMESPACE = 'model-routing'

/** Routed background purposes with a harness consumer. */
export type ModelRoutingPurpose = 'compaction' | 'session-title'

/** Background tier resolved when a purpose names no routing of its own. */
export type ModelRoutingTier = 'smallFast'

/** Stored provider route, model id, and optional reasoning effort. */
export interface ModelRoutingSelection {
  /** Registered provider route. */
  provider?: string
  /** Provider-owned model id. */
  model?: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string
}

/** Deployment routing for background model work, layered over the composition entry. */
export interface ModelRoutingSettings {
  /** Selection for small, fast background work; the tier every purpose falls back to. */
  smallFast?: ModelRoutingSelection
  /** Exact-purpose selections, winning over the tier. */
  purposes?: {
    /** Conversation-summarization selection, consulted by `purpose: 'compaction'`. */
    compaction?: ModelRoutingSelection
    /** Session-title selection, consulted by `purpose: 'session-title'`. */
    sessionTitle?: ModelRoutingSelection
  }
}

/** The fields one routed selection block may declare. */
const selectionSchema: z<ModelRoutingSelection> = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

/** Composition entry for the routing service; every block is optional. */
export type Config = ModelRoutingSettings

/** Reject a routed block that names half of a selection. */
function assertPair(site: string, block: ModelRoutingSelection | undefined): void {
  if (block === undefined) return
  const hasProvider = block.provider !== undefined && block.provider.length > 0
  const hasModel = block.model !== undefined && block.model.length > 0
  if (hasProvider !== hasModel) {
    throw new Error(`model-routing: ${site} must name provider and model together`)
  }
}

/**
 * Reject a routing section this harness could not act on. Registered as the
 * namespace's validator, so a half-declared selection is refused where it is
 * written rather than silently read as no routing.
 * @param settings - the resolved section, schema-valid by construction.
 * @throws Error naming the block that names only one half of a selection.
 */
export function assertServiceable(settings: ModelRoutingSettings): void {
  assertPair('smallFast', settings.smallFast)
  assertPair('purposes.compaction', settings.purposes?.compaction)
  assertPair('purposes.sessionTitle', settings.purposes?.sessionTitle)
}

/** Turn one validated block into the Agent-facing selection, or none. */
function selectionOf(block: ModelRoutingSelection | undefined): ModelSelection | undefined {
  if (block === undefined || block.provider === undefined || block.model === undefined) return undefined
  return {
    provider: block.provider,
    model: block.model,
    ...block.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(block.reasoningEffort) },
  }
}

/**
 * Owns the deployment's background-model routing independently of any Host or
 * transport. Consumers resolve a purpose first and the small-fast tier second,
 * then keep their own fallbacks; the service never claims a routing the
 * deployment did not declare.
 */
export class ModelRoutingConfig extends Service {
  static Config: z<Config> = z.object({
    smallFast: selectionSchema,
    purposes: z.object({
      compaction: selectionSchema,
      sessionTitle: selectionSchema,
    }),
  })

  private source: () => ModelRoutingSettings

  constructor(ctx: Context, config: Config) {
    super(ctx, 'modelRouting')
    assertServiceable(config)
    this.source = () => config
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(
        ctx,
        MODEL_ROUTING_SETTINGS_NAMESPACE,
        ModelRoutingConfig.Config,
        config,
        {
          validate: assertServiceable,
          setSource: (current) => {
            this.source = current
          },
          // Every consumer reads through selection(), so no registration-level
          // fact needs rebuilding when the settings document changes.
          onChange: () => {},
        },
      )
    })
  }

  /**
   * Read the routing selection a purpose or tier declares.
   * @param request - the purpose whose block wins, and the tier it falls back to.
   * @returns a detached selection, or undefined when the deployment routed nothing.
   */
  selection(request: { purpose?: ModelRoutingPurpose; tier?: ModelRoutingTier }): ModelSelection | undefined {
    const settings = this.source()
    if (request.purpose !== undefined) {
      // Config keys are camelCase mirrors of the wire purposes.
      const routed = selectionOf(request.purpose === 'compaction'
        ? settings.purposes?.compaction
        : settings.purposes?.sessionTitle)
      if (routed !== undefined) return routed
    }
    return request.tier === undefined ? undefined : selectionOf(settings.smallFast)
  }
}

export default ModelRoutingConfig

/** Schema of the routing settings section; identical to the plugin's composition schema. */
export const MODEL_ROUTING_SETTINGS_SCHEMA: z<ModelRoutingSettings> = ModelRoutingConfig.Config
