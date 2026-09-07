# Agent Note: Profile-scoped provider env lets any pi-ai route select its cloud credentials

Status: implemented

English | [中文](2026-09-07-profile-scoped-provider-env.zh.md)

## Problem

Every pi-ai route read provider-side discovery facts — AWS region and profile, Vertex project and location, proxy variables — from the one process environment, so a deployment running Bedrock in one region beside a gateway or a Vertex route could not state those per-route facts anywhere: exporting `AWS_REGION` pinned every route on the same value at once. The harness's stance is that configuration the deployment owns lives in profiles, and the ported provider-settings vocabulary carries region/profile/project selection as configuration, not ambient process state.

## Decision

A profile's `env` block (configuration vocabulary: `PiAiProviderProfile.env`) is a provider-scoped environment overlay forwarded on every request of its route. The vocabulary is pi-ai's own: `ProviderRequestOptions.env` is a `Record<string, string>` that pi-ai's provider discovery reads in place of `process.env` — Bedrock region and profile, Vertex project and location, and proxy variables all resolve through it on the `streamSimple` path. The harness adds no per-cloud fields:

- Resolution detaches the map like `headers` does, and forwarding skips absent or empty blocks, so an overlay nobody wrote contributes nothing to the request.
- The overlay is per route, so two Bedrock regions or a Vertex project beside a gateway coexist in one profile set without process-environment surgery.
- A named `apiKeyEnv` still decides the key: the overlay feeds pi-ai's own discovery (its `AWS_PROFILE`, `GOOGLE_CLOUD_PROJECT`, and proxy lookups), not the harness credential seam.

## Alternatives considered

- **Per-cloud structured fields (`aws.region`, `gcp.project`, ...).** Rejected: the provider-agnostic goal says a route's cloud selection is one map, not one schema addition per cloud; pi-ai's option plumbing is already env-keyed, so a structured layer would re-spell its names in harness vocabulary and drift.
- **A process-wide env extension in the composition.** Rejected: it cannot express per-route selection, which is the fact being stated.
- **Switching the stream path to pi-ai's full `stream()` with per-API options.** Rejected for this delta: the simple path is the harness's uniform reasoning vocabulary, and `env` reaches the same discovery through it; per-API option fields stay available should a route need one.

## Consequences

- The profile `env` map may hold secret-bearing values (an API key spelling pi-ai discovers); like `headers`, it is plain strings, and the credential-reference stance for `apiKeyEnv` is unchanged.
- Sign-in flows and credential-store lookups still read the ambient environment; the overlay covers request-time discovery.
- Hand-declared routes are unaffected in practice: their protocols do not consult cloud discovery, and pi-ai ignores overlay keys they never read.
