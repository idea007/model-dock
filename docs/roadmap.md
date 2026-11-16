# Release boundaries

## v0.1 — local model gateway (implemented)

- One installable Node package; separate core/protocol/providers/console modules.
- API, Ollama and Codex adapters; JSON and SSE Chat Completions.
- Codex single-image generation with model publication and project-key access.
- Credential management, model discovery/manual registration, publication and compatibility for existing aliases.
- Independent client demo for standalone/grouped features, explicit model defaults and reasoning preferences.
- Scoped project keys, request limits, monthly budget reservations, cancellation, capacity limits and a local usage ledger with CSV export.
- Published same-model deployment pools with least-loaded selection and temporary failure cooldown.
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
- Embeddings and additional image, audio and video adapters with job and artifact contracts.
- Native provider protocols beyond OpenAI-compatible APIs.
- OS credential-store integration and richer per-function parameter policies.
- Optional embeddable UI/SDK packages after external consumers establish their requirements.

Repository split becomes useful when the connector has multiple independent coordinator consumers, a stable public protocol, and different maintainers/release cadence. Multiple processes or installation packages alone do not require multiple repositories.
