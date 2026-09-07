# Agent Note: Per-model effort defaults and a declared reasoning summary mode

Status: implemented

English | [中文](2026-09-07-per-model-effort-default-and-reasoning-summary.zh.md)

## Problem

The ported provider-settings vocabulary carries two per-model facts the pi-ai route profiles could not state. `defaultEffort` varied per model in the source vocabulary (one provider's models defaulted to `high`, another's to `xhigh`), while the profile shape had only the route-level `reasoning` default — a heterogeneous route had to pick one default for all its models. `reasoningSummary` (the OpenAI Responses `reasoning.summary` mode) had no home at all: pi-ai's `streamSimple` forwards no summary, and its `buildBaseOptions` whitelist drops unknown request keys, so the value could not reach the wire through the option vocabulary the adapter uses.

## Decision

`models` entries and `modelOverrides` values gained two fields, resolving through the same path as `pricing` and `maxTokens`: `defaultReasoningEffort` records a per-model effort that must name a level the model offers (`getSupportedThinkingLevels` minus `off`, which means "send nothing", not a level) and takes precedence over the route's `reasoning` at both the request fallback and the resolved metadata's `defaultEffort`; `reasoningSummary` accepts `auto`, `concise`, or `detailed` and is refused when the model's resolved protocol never reads a `reasoning` parameter — the takers are `openai-responses`, `azure-openai-responses`, and `openai-codex-responses`.

The adapter applies the mode through pi-ai's `onPayload` hook, which each Responses implementation calls with the finished request body: the hook merges the configured mode into whatever `reasoning` the protocol's builder produced, or states `{ summary }` alone, which the protocol reads as the provider's own default effort. Omitting the summary is the default: an unset field and the config-only `off` value both strip the `auto` default pi-ai's builders inject, so no summarization pass runs, and the word `off` never reaches the wire — the provider rejects it. Measured against a Responses backend, an injected summary roughly doubles billed reasoning tokens (a second reasoning item's own output tokens) and it is the route's only visible thinking, so the ported vocabulary's silence became omission rather than pi-ai's paid `auto`. The user-selected effort (`selectedEffort` in the source vocabulary) needed no new field: `agent-default-model` already persists the complete selection, `reasoningEffort` included, and the ported fallback to `defaultEffort` is exactly the resolved metadata's `defaultEffort` the picker reads when a selection names none.

## Alternatives considered

- **Per-cloud summary fields or a full-`stream()` rewrite.** Rejected: pi-ai's simple-vocabulary path drops unknown keys, and switching the adapter to full `stream()` per protocol would fork every route's option plumbing for one field; `onPayload` is the one hook every implementation calls with the body.
- **Carrying the mode in `samplingParams`.** Rejected: `Object.assign` replaces the whole `reasoning` parameter, discarding pi-ai's effort mapping and clamping — the summary would silently rewrite effort dispatch.
- **A per-model `selectedEffort` settings field.** Rejected: the harness persists the user's explicit choice through `agentDefaultModel.saveSelection`, so a second store would hold the same fact in two places with different clearing rules.
- **Exposing pi-ai's codex `"off"`/`"on"` summary spellings as config values.** Rejected: the backend's own rejection names only `auto`, `concise`, and `detailed`, so `off` is realized as omission of the parameter, and `on` adds nothing over `auto`.

## Consequences

- A summary mode declared on a hand-declared route is applied by the harness, not pi-ai, so a gateway that ignores the parameter shows the same bytes as one that honors a default — the claim is about the request, and the provider answers for the behavior.
- A route whose models carry different provider defaults now states it per model; the route `reasoning` field remains for routes that share one, and the per-model map is empty for every existing profile.
- The refusal names the taker protocols, so a completions-route author learns the field exists for Responses routes rather than watching it apply to nothing.
- Responses routes whose profiles declare no summary mode now send no `reasoning.summary` at all — previously pi-ai's builder put `auto` on every reasoning request — so thinking is invisible until a mode is declared, and every undeclared route stops paying for the summarization pass.
