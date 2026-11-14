# Client app

**English** | [简体中文](client-demo.zh-CN.md)

The demo is an independent consuming application: its backend holds a **project key**, and its browser manages application features. It never uses gateway administrator APIs. It is a runnable example, not a mandatory gateway component or a production multi-user app.

## Open the client and connect your gateway

```sh
# Terminal 1: model supply, publication and project access
npm start
# Terminal 2: consuming application
npm run demo -- --open
# Installed tarball:
model-dock-demo --open
```

Open `http://127.0.0.1:4318` directly or refresh it without a manual local-session login. `--open` uses the ordinary page URL with no credentials in it. The model catalog starts empty; the client has no simulated data or `--mock` startup mode.

1. Publish models in the gateway's **Models & services** and create a scoped **Project access** key.
2. Open **Connection settings** (`接入设置`) in the left navigation, then enter the API base URL (usually `http://127.0.0.1:4317/v1`) and that `md_key_…` key in the client connection form, then select **Connect and load models** (`连接并读取模型`). Administrator tokens are rejected.
3. Enable authorized models for this application, configure functions, and save.
4. Open **Application experience** (`应用体验`) to run a feature with its default or an explicitly selected candidate. Real requests consume the selected upstream's resources.

**Connection settings** (`接入设置`) is a separate page alongside **Application experience** and **Functions & models** in the left navigation, including on mobile. Open it directly at `/?view=settings`. Failed validation shows an error without saving invalid credentials. Saved connections survive client restarts.

Open **API documentation** (`接口文档`, `/?view=api`) to read the gateway's endpoint details, copy cURL examples and download its [OpenAPI 3.1 specification](openapi.json). After connecting, the examples use the saved gateway address and authorized model IDs, including available Codex image models. Application functions use the text-model catalog.

After saving server publication, capability or reasoning changes, use **Refresh models** (`刷新模型`) in Connection settings or Functions & models without reentering the key. Settings shows the available authorized model count and last successful sync time. Reopening the page also refreshes the catalog. Unsaved application drafts survive metadata refreshes; concurrent edits to saved application preferences still produce a revision conflict.

Built-in features include standalone conversation and structured extraction; a content group with summary, rewriting and translation; and a development group with code explanation and review. These are templates for real requests and start without model bindings.

Gateway model IDs, not client feature IDs, are sent to `/v1/chat/completions`. A revoked key, missing model, disallowed effort, or invalid default fails explicitly. No fallback or retry is performed. Cancelling a streamed run aborts the gateway request. Details are in [function and model settings](model-settings.md).

Use `--port 4328` to change the client port. The model gateway and app can be restarted independently.

## Data boundary

| Owner | Default directory | Contents |
| --- | --- | --- |
| Gateway | `~/.model-dock` | Provider credentials, publication flags, project scopes and compatible legacy aliases |
| Client app | `~/.model-dock-demo` | `client.json` with gateway URL, project key, cached catalog and app choices; `access.token` and single-writer lock |

`MODEL_DOCK_DEMO_HOME` changes the client's root directory. The app has its own revision checks and atomic writes. Its project key is stored in a private backend file with mode `0600` under a `0700` directory; it is **not encrypted** and is never returned by the client state API or saved in browser storage. The browser automatically obtains a separate local session held only in page memory and invalidated on client-server restart. Opening the page establishes a new session. `npm run demo -- token` remains available for local scripts that call the client API manually. Use an OS-private directory and suitable ACLs on Windows. Do not commit these directories.

Changing the URL or project key disables existing application model switches so a different project's resources are never silently activated. Selections remain available for review. If explicitly started with a retired mock data directory, the app clears the simulated connection, cached models and bindings before accepting a real server key. Simulated providers exist only in `tests/fixtures` and are excluded from the package.

## Demo-local API

These routes belong to the **client process**, not the gateway. Static assets, `/healthz` and session bootstrap do not require a token. Other routes require a local bearer session, same-origin access, and JSON bodies for POST requests.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/session` | Automatically establish a browser session with `X-Model-Dock-Client: 1`; returns `{session}` and rejects foreign page origins |
| GET | `/api/state` | Safe app snapshot with text-model preferences and authorized `imageModelIds` for API examples |
| POST | `/api/connection` | `{revision, baseUrl, apiKey}`: read authorized models and save a project connection |
| POST | `/api/refresh` | `{revision}`: refresh the project catalog; preserve missing bindings as unavailable |
| POST | `/api/settings` | `{revision, models, routes}`: save the entire app draft atomically |
| POST | `/api/run` | `{featureId, prompt, modelId?, reasoningEffort?, stream?}`: resolve a feature, validate preferences, forward JSON/SSE |

The run response includes the gateway's `x-request-id` when available. On `429` it also preserves a valid `Retry-After` from the gateway.

Here `routes` is the demo's application feature array. Models contain `{id, enabled, reasoningPolicy, groupPolicies}`. A feature contains `{id, name, kind, group, selection, modelId, allowedModelIds, reasoningOverrides}`. `selection` is `single` or `multiple`, `modelId` is the explicit default, and reasoning overrides are keyed by authorized model ID. See `apps/demo/policy.mjs` and `apps/demo/features.mjs`.
