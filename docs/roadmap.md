# Release boundaries

## v0.1 — local text gateway (implemented)

- One installable Node package; separate core/protocol/providers/console modules.
- API, Ollama and Codex adapters; JSON and SSE Chat Completions.
- Credential management, model discovery/manual registration, enablement, stable feature aliases.
- Scoped project keys, cancellation, capacity limits and bounded metadata.
- Offline fixtures, official SDK contract tests, packaging verification, local setup and integration examples.

## Next — optional outbound device connector

Keep it in this repository until its protocol and independent consumers stabilize. It should be separately installable, not required for local-only usage.

Required work before advertising support:

- Extract device pairing, token rotation/revocation, manifests and task leases from the reference connector, removing blog routes and user-table dependencies.
- Version an event protocol for deltas, tool handoffs, usage, cancellation acknowledgement and a unique terminal result.
- Bind every task to its owner, device, connection revision and model. A lease expiry or lost connection must not silently submit a duplicate paid inference.
- Stream through an outbound encrypted connection without requiring public ports on a user device.
- Introduce explicit tenant ownership and deployment trust boundaries in the coordinator.
- Independently review Codex authentication for any hosted/commercial flow; the local CLI route is not a blanket authorization for hosted use.

## Later — runtime lifecycle and additional capabilities

- Ollama pull progress, cancellation, loaded-model status and explicit unload/delete actions.
- Embeddings, then image/audio/video adapters with their own job and artifact contracts.
- Native provider protocols beyond OpenAI-compatible APIs.
- OS credential-store integration, durable usage/export and richer per-function parameter policies.
- Optional embeddable UI/SDK packages after external consumers establish their requirements.

Repository split becomes useful when the connector has multiple independent coordinator consumers, a stable public protocol, and different maintainers/release cadence. Multiple processes or installation packages alone do not require multiple repositories.
