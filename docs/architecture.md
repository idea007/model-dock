# Architecture and extraction boundaries

One repository contains independently replaceable protocol, core, provider, gateway and console modules. Runtime imports are relative and the npm package includes all required modules; the source blog is not required at install or runtime.

## Request ownership

1. HTTP validates loopback Host/Origin and authenticates a scoped project token or the administrator.
2. Core validates the text request, resolves a model/alias to its connection, checks enabled/available state and key scope, and reserves bounded capacity.
3. The provider emits delta, usage and terminal events. It owns upstream protocol translation and cancellation.
4. HTTP formats either Chat Completions JSON or SSE. The API caller owns function execution.

A model's identity is `connectionId/nativeModelId`. Two connections to the same model name remain separate. Aliases are operator-managed mappings. Removing a connection leaves its aliases visibly broken until explicitly repaired; it never points them at another provider. New discovery does not enable models or grant key permissions.

Connection URL changes disable existing model entries until discovery or manual registration. Calls already dispatched retain their captured provider/configuration; key revocation and connection removal also cancel in-flight requests. Ordinary model disabling applies to new requests.

The local process is a single trusted operator service. Project keys scope inference only; they cannot access management APIs. Multi-user ownership is deliberately not approximated using frontend state. A future hosted coordinator must introduce tenant ownership and credential scopes explicitly.

## Persistence

`Store` owns the JSON schema, revision checks, encrypted upstream credentials, private-file permissions, a single-writer lock and atomic replacement. This is appropriate for a local tool, not a horizontally scaled database. Requests keep bounded metadata in memory; prompts and completions are never written by the gateway.

Adapters receive only their connection's decrypted secret. The console sees `hasKey`, not the secret or encrypted envelope. Scoped project keys are stored as SHA-256 hashes and disclosed only once. The master key is separate from state, but resides in the same private OS account directory; this is disk-file protection rather than hardware-backed key storage.

## What was extracted

- Codex process lifecycle, temporary workdir, reduced environment, RPC dispatch, final-message filtering and usage semantics from `runtimes/local-connector/providers/codex/`.
- Native role history, dynamic-function aliasing and handoff design from `runtimes/platform-ai-sidecars/codex-bridge/`.
- Model capability discovery and loopback-provider separation from the Ollama connector.
- Connection-aware model identity, default-off discovery, revision-checked saves and fail-closed preferences from the blog's model policies.
- The console preserves “connections/credentials” and “functions/models” as concepts, with a new framework-independent implementation.

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
