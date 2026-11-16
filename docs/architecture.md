# Architecture and extraction boundaries

One repository contains independently replaceable protocol, core, provider, gateway, server console and client demo modules. Runtime imports are relative and the npm package includes all required modules; the source blog is not required at install or runtime.

## Request ownership

1. HTTP validates loopback Host/Origin and authenticates a scoped project token or the administrator.
2. Core validates the request, resolves a model or alias to its connection, checks publication and key scope, and reserves bounded capacity.
3. The provider translates the upstream protocol and propagates cancellation. It emits chat events or returns a complete image.
4. HTTP formats Chat Completions JSON or SSE, or returns an Images JSON response. The API caller owns function execution.

A model's identity is `connectionId/nativeModelId`. Two connections to the same model name remain separate. Existing aliases are retained for compatibility; new application functions live in the consuming app. Removing a connection leaves its aliases visibly unavailable; it never points them at another provider. New discovery does not enable models or grant key permissions.

Connection URL changes disable existing model entries until discovery or manual registration. Calls already dispatched retain their captured provider/configuration; key revocation and connection removal also cancel in-flight requests. Ordinary model disabling applies to new requests.

The local process is a single trusted operator service. Project keys scope inference only; they cannot access management APIs. Multi-user ownership is deliberately not approximated using frontend state. A future hosted coordinator must introduce tenant ownership and credential scopes explicitly.

## Persistence

`Store` owns the JSON schema, revision checks, encrypted upstream credentials, private-file permissions, a single-writer lock and atomic replacement. The gateway writes execution metadata to a separate local usage ledger with 30-day retention. Appending a record does not update the configuration revision. The request log only contains metadata and measured usage.

`ProjectBudgets` uses the gateway's single-writer lock and a serialized local ledger. It persists an estimated cost reservation before provider submission. Settlement charges measured usage or carries the reservation as unconfirmed if the outcome is unknown. Outstanding reservations from a previous process are recovered as unconfirmed on startup.

A deployment pool is a separately published model ID with explicitly configured members. The gateway applies project authorization to that ID, filters members by publication and request compatibility, and uses the lowest fraction of occupied connection slots. It rotates ties and tracks connection cooldowns in memory. Usage follows the actual deployment even when the request names a pool.

Adapters receive only their connection's decrypted secret. The console sees `hasKey`, not the secret or encrypted envelope. Scoped project keys are stored as SHA-256 hashes and disclosed only once. The master key is separate from state, but resides in the same private OS account directory; this is disk-file protection rather than hardware-backed key storage.

## What was extracted

- Codex process lifecycle, temporary workdir, reduced environment, RPC dispatch, final-message filtering and usage semantics from `runtimes/local-connector/providers/codex/`.
- Native role history, dynamic-function aliasing and handoff design from `runtimes/platform-ai-sidecars/codex-bridge/`.
- Model capability discovery and loopback-provider separation from the Ollama connector.
- Connection-aware model identity, default-off discovery, revision-checked saves and fail-closed preferences from the blog's model policies.
- The server console manages connections and publication; the independent client demo adapts the reference “functions/models” UI and owns feature preferences.

The blog's accounts, SQLite schema, analytics, billing, content features, images, storage and platform defaults were not imported. The outbound connector is not yet shipped: its device/lease protocol must be extended for streaming before it becomes a public contract.

## Adding a provider

Register a provider in `packages/providers/index.mjs`. Implement:

```js
{
  async discover(connection, { secret, signal }) { /* model metadata[] */ },
  async *generate(connection, request, { secret, signal, model }) {
    yield { type: 'delta', delta: { content: '...' } };
    // Emit usage only when the upstream actually measured it.
    yield { type: 'done', finishReason: 'stop' };
  },
  async close() { /* owned resources only */ }
}
```

An adapter must reject parameters it cannot enforce, propagate cancellation, bound buffers and distinguish a complete result from a disconnected stream. Add isolated HTTP/stdio contract tests before declaring a capability.

## Independent client boundary

```mermaid
flowchart LR
  UI[Client demo browser] --> App[Client app backend :4318]
  App -->|Project key · /v1/models and /v1/chat/completions| Gateway[Model Dock :4317]
  Admin[Server console] -->|Administrator token · /admin| Gateway
  Gateway --> Providers[API / Ollama / Codex]
  App --- Preferences[App features, groups and defaults]
  Gateway --- Supply[Credentials, publication and project scopes]
```

`apps/demo` is optional and independently runnable. It does not import the gateway core: its backend uses the public project-scoped HTTP API. The UI opens directly and accepts the server URL and a server-created project key. It starts with an empty model catalog; deterministic providers exist only under `tests/fixtures` and are excluded from the distribution.

The app caches authorized metadata, keeps its own function catalog and validates single/multiple selections and reasoning inheritance before building a native model request. The gateway independently enforces its current publication, key scopes, capacity and provider constraints on every call. A cached selection is never an authorization grant. Missing models remain visibly unavailable, and invalid defaults never trigger fallback. Cancellation propagates through the client backend to the gateway.

The demo has a separate private directory, single-writer lock and revision-checked atomic store. A same-origin `POST /api/session` with the custom `X-Model-Dock-Client: 1` header automatically establishes a process-lifetime browser session held only in page memory. Host/Origin and Fetch Metadata checks plus the preflight requirement prevent foreign pages from bootstrapping it. The legacy `access.token` remains available for local scripts. The browser receives safe metadata and preferences; the submitted project key remains in the backend's private `client.json` file (not encrypted) and is never returned. Both UI views share a per-tab draft with conflict preservation. See [client setup](client-demo.md) and [preferences](model-settings.md).

## Compatibility and schema v2

Server `/admin/model-settings` accepts publication flags and optional per-model reasoning policies. Model policies define the levels that clients can select and the default applied when a request omits a level. Clients manage application functions, groups and their reasoning preferences. `POST /admin/routes` returns `410 client_owned_settings`. Existing aliases retain their scopes and policies. Administrators can inspect and delete aliases through the management API.

Schema v2 preserves optional legacy model `reasoningPolicy`/`groupPolicies` and route `group`/`reasoningPolicy`. On the first open of a valid v1 directory, the store verifies its private identity, writes a private `state.v1.<id>.backup.json`, then atomically writes v2 with an incremented revision. Existing connections, encrypted secrets, keys, publication flags and alias targets are retained. Migration introduces no access grants. Unsupported or damaged schemas fail closed; restore a complete matching directory backup before using an older binary.

Legacy reasoning policies continue to constrain old calls and fail closed if discovery invalidates their saved levels. New app preferences are kept entirely in the client store and sent as explicit request parameters. The client does not automatically import administrator configuration or legacy aliases.
