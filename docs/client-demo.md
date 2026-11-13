# Client demo

**English** | [简体中文](client-demo.zh-CN.md)

The demo is an independent consuming application: its backend holds a **project key**, and its browser manages application features. It never uses gateway administrator APIs. It is a runnable example, not a mandatory gateway component or a production multi-user app.

## Start with simulated models

```sh
npm run demo:mock -- --open
# Installed tarball:
model-dock-demo --mock --open
```

Open `http://127.0.0.1:4318`. `--open` supplies a demo-local session token in a fragment that the browser removes immediately. To retrieve that token manually, use `npm run demo -- token --mock`.

Mock mode starts an isolated gateway on an ephemeral loopback port with two deterministic providers, `demo-chat` and `demo-reasoner`. It creates a project key scoped to those models and seeds example app choices. It never reads your personal gateway data or contacts paid models. Every mock response and the UI explicitly identify simulation; no token usage is fabricated. The temporary mock gateway is removed on shutdown, while app preferences persist separately.

Sample features include standalone conversation and structured extraction; a content group with summary, rewriting and translation; and a development group with code explanation and review. Templates express the requested task; simulated responses demonstrate transport and controls rather than performing real inference.

## Connect your gateway

```sh
# Terminal 1: model supply, publication and project access
npm start -- --open
# Terminal 2: consuming application
npm run demo -- --open
```

1. Publish models in the gateway's **Models & services** and create a scoped **Project access** key.
2. In the demo, open **Gateway connection settings** (`网关接入设置`) and enter the API base URL (usually `http://127.0.0.1:4317/v1`) and that `md_key_…` key. Administrator tokens are rejected.
3. Enable authorized models for this application, configure functions, and save.
4. Open **Application experience** (`应用体验`) to run a feature with its default or an explicitly selected candidate. Real requests consume the selected upstream's resources.

Gateway model IDs, not client feature IDs, are sent to `/v1/chat/completions`. A revoked key, missing model, disallowed effort, or invalid default fails explicitly. No fallback or retry is performed. Cancelling a streamed run aborts the gateway request. Details are in [function and model settings](model-settings.md).

Use `--port 4328` to change the demo port. Stop the current mock demo before starting real mode on the same port, or give one of them a different port. The model gateway and app can be restarted independently.

## Data boundary

| Owner | Default directory | Contents |
| --- | --- | --- |
| Gateway | `~/.model-dock` | Provider credentials, publication flags, project scopes and compatible legacy aliases |
| Client app | `~/.model-dock-demo` | `client.json` with gateway URL, project key, cached catalog and app choices; `access.token` and single-writer lock |
| Mock app | `~/.model-dock-demo/mock` | Separate application settings for simulated mode |

`MODEL_DOCK_DEMO_HOME` changes the client's root directory. The demo has its own revision checks and atomic writes. Its project key is stored in a private backend file with mode `0600` under a `0700` directory; it is **not encrypted** and is never returned by the client state API or saved in browser storage. The browser's session token is a separate local-demo credential. Use an OS-private directory and suitable ACLs on Windows. Do not commit these directories.

Changing the URL or project key disables existing application model switches so a different project's resources are never silently activated. Selections remain available for review. `--mock` always selects a new isolated simulated gateway on startup; use normal mode and its separate data directory for real connections.

## Demo-local API

These routes belong to the **demo process**, not the gateway. Except static assets and `/healthz`, they require its local session token, same-origin access, and JSON bodies for POST requests.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/state` | Safe app snapshot: cached authorized metadata and preferences, no keys |
| POST | `/api/connection` | `{revision, baseUrl, apiKey}`: read authorized models and save a project connection |
| POST | `/api/refresh` | `{revision}`: refresh the project catalog; preserve missing bindings as unavailable |
| POST | `/api/settings` | `{revision, models, routes}`: save the entire app draft atomically |
| POST | `/api/run` | `{featureId, prompt, modelId?, reasoningEffort?, stream?}`: resolve a feature, validate preferences, forward JSON/SSE |

Here `routes` is an internal legacy name for the demo's application feature array; it is never sent to gateway management. Models contain `{id, enabled, reasoningPolicy, groupPolicies}`. A feature contains `{id, name, kind, group, selection, modelId, allowedModelIds, reasoningOverrides}`. `selection` is `single` or `multiple`, `modelId` is the explicit default, and reasoning overrides are keyed by authorized model ID. Source: `apps/demo/policy.mjs` and `apps/demo/features.mjs`.
