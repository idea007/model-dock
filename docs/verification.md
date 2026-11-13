# Verification record · 2026-11-13

Initial v0.1 validation used macOS arm64, Node.js 24.18.1 and npm 11.16.0. This record describes observed checks; it is not a guarantee for every provider, model or operating system.

| Check | Result |
| --- | --- |
| `npm run verify` | 27 modules passed syntax checks; 16 automated tests passed |
| Official OpenAI JavaScript SDK against local fixtures | Model listing, JSON, fragmented Unicode SSE, measured usage, function calls and results passed |
| Failure and isolation contracts | Scope enforcement, revocation, concurrency, cancellation, incomplete streams, invalid formats, missing identity files and persistence passed |
| Console DOM integration | Login, connection creation, model discovery/enablement, aliases, scoped keys, JSON and streaming playground passed |
| `npm run pack:check` | Tarball installed in an isolated directory; installed CLI, gateway and console assets worked without the source tree |
| Real Ollama inference | Installed `qwen3.5:4b` returned `OK` through Chat Completions; native token usage was preserved |
| Real Codex inference | `codex-cli 0.164.0`, locally signed-in CLI, `gpt-6-luna`: OpenAI SDK SSE returned `OK`; required function handoff passed; native tool-result history returned `3` for `1 + 2` |

Real-model checks were separate from the automated suite. Ollama performed local inference; Codex used the existing local CLI account/provider and consumed its model usage. Model enablement was restored after testing. No private account data, provider secrets or model outputs beyond the trivial test values are included in this repository.

The initial Codex call spent time reconnecting its WebSocket transport before falling back to HTTPS. Explicitly inheriting this Mac's already configured loopback proxy reduced the text smoke test to about 5–6 seconds. The adapter now detects enabled macOS loopback HTTP/HTTPS proxies when no proxy environment variable is explicitly set. This does not change system proxy settings.

## Remaining verification boundaries

- The browser-control service was unavailable, so visual browser inspection was not completed. DOM tests do not substitute for visual review or a full accessibility audit.
- CI is configured for Linux, macOS and Windows with Node 22/24; those remote matrix jobs have not been run for this initial local delivery.
- The generic API adapter was tested against controlled HTTP fixtures, not a user's paid third-party API account.
- Codex compatibility is experimental and version-dependent. A new CLI release needs its own real protocol smoke test.

Reproduce the offline and packaging checks with `npm ci`, `npm run verify`, and `npm run pack:check`. Real inference is opt-in through the console and uses the selected connection's resources.
