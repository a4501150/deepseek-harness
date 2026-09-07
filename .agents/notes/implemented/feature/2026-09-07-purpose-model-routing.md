# Agent Note: Purpose-keyed model routing moves background work off the session route

Status: implemented

English | [中文](2026-09-07-purpose-model-routing.zh.md)

## Problem

Compaction and session-title calls ran on whatever route the session used: the summarizer fell through configured fields to the last routed request or the Agent's options, and the title provider fell to the route logged in the session. A deployment whose main model is a large, slow, or expensive route therefore paid that route's price for every checkpoint summary and title — facts the ported provider-settings vocabulary keeps as separate purpose slots (`defaultSmallFastModel`, per-purpose routing), not accidents of session state.

## Decision

`dsh-model-routing` (settings namespace `model-routing`) owns the deployment's background routing as one small service, `ctx.modelRouting.selection({ purpose?, tier? })`, resolved purpose block first, then the `smallFast` tier, then `undefined` — consumers keep their own fallback chains after an undeclared routing, so mounting the plugin changes nothing until a section states a fact. Resolution points: compaction resolves `configured fields → routing → last request route → Agent options` and forwards the routed selection's `reasoningEffort`; the title provider resolves `explicit pair → routing → logged route` and forwards effort the same way. A routed `reasoningEffort` travels on the request; the durable title provenance keeps provider and model only.

The settings shape is `smallFast` plus `purposes.compaction` / `purposes.sessionTitle`, each `{ provider, model, reasoningEffort? }`. Keys are camelCase mirrors of the wire purposes (`'session-title'`) because the configuration-catalog walker compares schema paths against property names literally. A block naming only one half of a pair is refused by the namespace's validator where it is written, so resolution can trust complete pairs.

## Alternatives considered

- **Per-consumer settings in the owning packages.** Rejected: compaction and title would each grow a parallel routing schema and validator while a deployment states one routing fact; the shared vocabulary is the point.
- **The full ported purpose-tier set (`defaultSubagentModel`, `balanced`, `mostPowerful`, `planAgentConfig`) up front.** Deferred: no consumer resolves those slots yet, and an unowned configurable is a guess; `selection()` already takes a `tier` argument so a later tier joins with one schema key.
- **Hosting the section inside `agent-default-model`.** Rejected: that service owns one process-wide default read at agent creation; background routing is a different question with different consumers, and merging them would couple two read paths that change for unrelated reasons.

## Consequences

- A routed background model is a different cache domain from the session route: the summarization prefix stops reusing the session's warm provider cache and warms its own — the trade a deployment opts into by routing.
- New background purposes join by extending `ModelRoutingPurpose`, one schema key, and the consumer's resolution point; the service API does not change.
- Settings documents can route purposes before any consumer exists; a block whose purpose nobody consumes states an unused fact, and no call site loses information because of it.
