---
description: "Purpose-keyed background model routing for users and maintainers choosing which model runs compaction and session titles."
kind: "package-reference"
---

# @deepseek-ai/dsh-model-routing

English | [中文](README.zh.md)

## Summary

`dsh-model-routing` holds the deployment's routing for background model work: one selection for small, fast work and per-purpose overrides for conversation compaction and session titles. Background consumers resolve a purpose first and the small-fast tier second, then keep their own fallbacks, so a deployment that routes nothing keeps running on the session route as before. The routing lives in the `model-routing` settings section, layered over the composition entry, and a saved change is visible on the next background call. The service answers one question — which selection does this purpose or tier declare — and never claims a routing the deployment did not state.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package where background model work should run on a model the deployment chose, not necessarily on the session's route. Consumers that stamp a `purpose` on their `ctx.llm.stream()` call read `ctx.modelRouting` before falling back.

### Configure the routing

The composition entry may be empty; the settings document is where a deployment states routing.

```yaml
- name: '@deepseek-ai/dsh-model-routing'
```

A user settings section then declares selections:

```yaml
model-routing:
  smallFast: { provider: gateway, model: small-model }
  purposes:
    compaction: { provider: gateway, model: summarizer-model, reasoningEffort: low }
```

| Block | Meaning |
|---|---|
| `smallFast` | Tier every routed purpose falls back to; background work on the smallest declared model |
| `purposes.compaction` | Selection for summarization calls (`purpose: 'compaction'`) |
| `purposes.sessionTitle` | Selection for title generations (`purpose: 'session-title'`) |

Every block must name `provider` and `model` together; a half-declared block is refused where it is written. `reasoningEffort` is optional per block. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-model-routing) is the exhaustive source for every accepted field.

### Read the routing

`selection({ purpose, tier })` returns a detached `{ provider, model, reasoningEffort? }` for the purpose block, else the tier, else `undefined` — the service never invents a default.

```text
const routed = ctx.modelRouting.selection({ purpose: 'compaction', tier: 'smallFast' })
```

Consumers keep their own fallbacks after `undefined`: compaction falls to the configured summarization fields, the session's last route, or the Agent's options; the title provider falls to the route logged in the session.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the service realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The service is a settings-backed read with one validation point. The section schema accepts every block as optional so an absent routing resolves to "no fact"; `assertServiceable` — registered as the namespace's validator — refuses a block naming only one half of a selection where it is written. `selection()` reads the live source each call, so a settings write needs no registration-level rebuild. Config keys are camelCase mirrors (`sessionTitle`) of the wire purposes (`'session-title'`).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `ModelRoutingConfig` service, settings section install, `assertServiceable`, `selection` |
| — | No runtime invariant companion is published; the settings validator owns the only mutable-value relationship. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Core subsystem](../../../docs/subsystems/core.md) — the `Agent` handle and route selection this service supplements.
- [compaction-basic package](../../compaction/compaction-basic/README.md) — the `purpose: 'compaction'` consumer.
- [session-title-llm package](../../session/session-title-llm/README.md) — the `purpose: 'session-title'` consumer.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-model-routing) — every accepted config field and its source declaration.
- [Core group map](../README.md) — how the core packages compose.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the consumer's background requests: the routed selection decides which model writes the compaction checkpoint and the session title, its `reasoningEffort` travels on those requests, and routing changes nothing in the main conversation's model, prompt, or prefix.

#### KV Cache effect

A routed model is a different cache domain from the session route: the summarization prefix that previously reused the session's warm provider cache now warms its own, so routing trades cache reuse for a deliberately cheaper auxiliary model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the service's scope. They are current package constraints, not a task backlog.

- **Two routed purposes** — only `compaction` and `sessionTitle` blocks exist; subagent and plan-agent tiers join when a consumer owns them.
- **No saving surface** — the service is read-only; routing is written through the settings document or `settings.replace`, with no `saveSelection`-style helper.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
