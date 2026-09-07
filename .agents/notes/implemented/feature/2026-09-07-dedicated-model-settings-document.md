# Agent Note: A dedicated model-settings document via provider-owned split documents

Status: implemented

English | [中文](2026-09-07-dedicated-model-settings-document.zh.md)

## Problem

The ported provider-settings vocabulary kept model configuration in its own file, separate from general settings. In this harness every namespace section shared one `settings.yaml`, so the sections the web Models page and the model pickers write — route profiles, the saved default selection, purpose routing — sat in the same human-edited document as unrelated namespaces. A user curating model settings edited (and could corrupt) the whole document, and a deployment had no way to give the model-related sections their own file home while the seam still saw one document.

## Decision

`dsh-settings-file` gained a `documents` config: split documents declared by path and owned namespaces. A routed namespace has exactly one file home. `persist` routes each section to the owning document; `load` reads every document and `compose` merges the trees into the one raw seam document, so the `SettingsProvider` contract is unchanged for every consumer. Boot-only `migrateGhosts` moves a routed section found outside its owner into the owner and drops stale copies, converging an installation written under the single-document layout; a ghost left by a later external edit is composed out with a warning rather than written back. `resolveSpec` rejects the configurations that would leave a section ambiguous: two owners for one namespace, a split naming the primary document, a repeated split path, or empty path and namespace entries. The base bundle routes `agent-default-model`, `model-routing`, `llm-deepseek`, and `llm-pi-ai` to `model-settings.yaml` beside `settings.yaml`.

## Alternatives considered

- **One document per namespace, or a layout chosen by convention.** Rejected: file count multiplies without the source vocabulary asking for it, and the split is a deployment statement — the provider declares candidates, the mount names the sections.
- **Compose-out ghosts without boot migration.** Rejected: a section written by the previous single-document layout would be read from the wrong file forever and any write would move it mid-session; migrating at boot converges existing installations once, before the first publish, with a log line naming the destination.
- **Merging multiple documents inside the settings service.** Rejected: file layout is the file provider's concern; a service that understood document splits would leak this provider's storage model into every provider.

## Consequences

- An existing installation's first boot after this move relocates its model sections into `model-settings.yaml` (info log per section); reads and writes before and after see identical values because the seam document is merged either way.
- The watcher observes every configured document, and writes serialize on the one operation chain plus each file's own writer lock, so a write to one document still folds an external edit to any other before rendering.
- A configuration that names a split owning a namespace another split owns fails at load with both filenames named, rather than resolving by accident.
