# Model Dock

**English** | [简体中文](README.zh-CN.md)

**Your models. Connected.** A local-first model gateway with a separate client demo.

Connect your own model APIs, Ollama, and a signed-in Codex CLI through a single endpoint. The server owns model supply, credentials, publication, project access and request controls. Consuming apps own their features, groups and model preferences. The gateway, console and demo have no third-party runtime dependencies; the core, protocols, and provider adapters are maintained in this repository.

## Quick start

Requires **Node.js 22.12+**. Node.js 24 LTS is recommended.

```sh
git clone https://github.com/idea007/model-dock.git
cd model-dock
npm ci
npm start
```

The console runs at **http://127.0.0.1:4317** by default. The API base URL is **http://127.0.0.1:4317/v1**.

Starting the server automatically opens and signs in to the console in your default browser. Use `npm start -- --no-open` to run the service without opening a browser. The existing `--open` option remains supported. The gateway listens only on loopback.

While the gateway is running, use `npm run console` to reopen and sign in to the console. To open it in a specific browser, run `npm run --silent console -- --print` and paste the one-time URL into its address bar. Tabs at the same address share the sign-in within that browser for up to seven days. Restarting the gateway automatically opens the console and signs in again, unless `--no-open` is used.

The console currently uses Chinese labels:

1. Add a provider under **Connections & credentials** (`连接与凭证`), then click **Discover models** (`发现模型`).
2. Enable models under **Models & services** (`模型与服务`). For models that declare reasoning levels, select the open levels and pin the default. Use **Save changes** to publish the settings. Newly discovered models are unpublished by default.
3. Create a scoped key under **Project access** (`项目访问`) and select the models the app may use.
4. Verify a real request in the **Playground** (`调用测试`), then give your app the gateway URL, project key and connection-qualified model ID.

## Try the independent client demo

```sh
# Connect using a project key created by your Model Dock server
npm run demo -- --open
```

The client runs at **http://127.0.0.1:4318** and opens directly without a manual local-session login. Open **Connection settings** (`接入设置`) in the left navigation and enter the server API address and a `md_key_…` key created under **Project access** to load its authorized models. Before connection, the model catalog is empty; no simulated data is supplied. It has a separate process and data directory, with standalone conversation/extraction, content and development groups, single-model and multiple-candidate choices, independent defaults, reasoning inheritance, and a streaming runner.

**Functions & models** (`功能与模型`) has moved here. Its credential/function views, search, expandable groups, resizable columns, save/revert controls and recoverable drafts affect only this application. The app backend reads authorized models and forwards real requests using a project key; it never uses administrator APIs. The dedicated **Connection settings** (`接入设置`) page in the left navigation manages the address and key. **Refresh models** (`刷新模型`) synchronizes server publication flags, capabilities and reasoning levels; reopening the page also refreshes the catalog. See the [client setup](docs/client-demo.md) and [model preference guide](docs/model-settings.md).

| Server console · 4317 | Client demo · 4318 |
| --- | --- |
| Provider connections and upstream secrets | Project connection and authorized catalog |
| Model publication and project scopes | App model choices, feature groups and defaults |
| Capacity, timeout, revocation and request metadata | Prompt templates, per-feature reasoning and user interactions |

Existing server aliases remain compatible with existing keys and calls. New application functions belong in clients; the gateway no longer creates global business aliases.

## Connect your app

```sh
export MODEL_DOCK_API_KEY='your-project-key-from-the-console'
export MODEL_DOCK_MODEL='connection-id/model-id'
node examples/chat.mjs
```

No particular SDK is required. Any client that uses the supported subset of the Chat Completions protocol can connect.

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:4317/v1',
  apiKey: process.env.MODEL_DOCK_API_KEY,
});
const result = await client.chat.completions.create({
  model: 'connection-id/model-id',
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(result.choices[0].message.content);
```

See the [plain JavaScript example](examples/chat.mjs), [Python SDK example](examples/chat.py), and [application tool-calling example](examples/tools.mjs). Keep project keys in your application's server-side environment variables, not in public browser scripts.

## Three model sources

| Source | Connection | Capabilities |
| --- | --- | --- |
| Your own API | OpenAI-compatible base URL + API key | Multiple connections, model discovery or manual registration, publication controls and project access scopes |
| Ollama | Native local HTTP API | Installed-model discovery, capability and context metadata, text inference, streaming, JSON, and model-supported tool calls |
| Codex (experimental) | Locally installed and signed-in CLI / App Server | Model catalog, text and tool calls, image generation and reference-based editing |

Install and start Ollama separately, then download a model with a command such as `ollama pull <model>`. Model Dock does not download weights at startup or during status checks. Context metadata is displayed for reference; inference does not automatically raise `num_ctx` to the model's maximum.

Codex uses native JSON-RPC and creates a temporary thread for each request. Shell, browser, plugin, and host MCP capabilities are isolated. Application tool calls are returned to the caller for execution; the gateway does not execute them on the app's behalf. This is a real model bridge using the account or upstream configured in Codex and its associated quota. `model/list` is only a catalog and does not establish that the current account can run a particular model.

Discover models on the Codex connection and publish `codex-imagegen` under **模型与服务 → 图片生成**. In **调用测试**, add up to five reference images, choose an aspect ratio, request a transparent background, or reuse a result with **继续编辑**. Projects can grant their key access to this model and call `POST /v1/images/generations`. Requests use the signed-in Codex account's quota. [Images endpoint](docs/api.md#inference)

Codex inherits `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` from the environment that starts the gateway. When no proxy is explicitly configured, macOS detects enabled system HTTP/HTTPS proxies on loopback and passes them only to the Codex child process, without changing system settings. PAC and non-loopback proxies are not imported automatically; set the environment variables explicitly on other platforms or for custom networks. If model listing works but inference keeps reconnecting, check the CLI's proxy connection first.

Built-in Codex authentication has a different scope from hosted services. For commercial or hosted use, evaluate the official API or Sign in with ChatGPT separately. This release does not implement Sign in with ChatGPT or provide shared-account resale or public proxy deployment. [Official App Server documentation](https://learn.chatgpt.com/docs/app-server#auth-endpoints) · [Sign in with ChatGPT](https://developers.openai.com/siwc)

## Compatibility

- `GET /v1/models`
- `POST /v1/chat/completions`: text messages, non-streaming JSON, SSE, tool calls, and tool-result round trips.
- `POST /v1/images/generations` returns one Base64-encoded image from Codex.
- Token usage as reported by the upstream. Missing usage stays unknown rather than being fabricated as zero.
- Client disconnects and cancellation, request timeouts, concurrency limits, and project-key revocation.
- Management APIs for connections, catalogs, model publication, project keys, and cancellation of in-flight requests.

**Compatibility is limited to an explicit subset.** Unsupported parameters return errors. Codex cannot guarantee the semantics of options such as `temperature` or `max_tokens`, so it does not silently accept and ignore them. See the [compatibility matrix](docs/compatibility.md) and [management API documentation](docs/api.md).

Later work includes audio and video capabilities, remote device pairing, and Ollama model management. [Roadmap](docs/roadmap.md)

## Data and configuration

Data is stored in the current user's `~/.model-dock` by default. Set `MODEL_DOCK_HOME` to use a dedicated directory. Only one gateway process may write to a directory at a time.

- `state.json`: connections, models, compatible legacy aliases, hashed project keys, and upstream keys encrypted with AES-256-GCM.
- `master.key`: the decryption key. `admin.token`: the local administrator token.
- POSIX file permissions are `0600`, and directory permissions are `0700`. On Windows, use a directory private to the current user and configure the corresponding ACLs.
- Atomic writes and revision checks prevent concurrent overwrites. Reading a corrupted configuration does not reset it.
- By default, only the latest 100 request metadata records are kept in memory. Prompts and responses are not stored, and the history clears on restart.

Back up the entire data directory together. The encryption key and data reside on the same machine, so this does not protect against someone who already has access to the current OS account. Do not commit this directory to Git, sync it to untrusted accounts, or share it publicly.

```sh
# macOS / Linux
MODEL_DOCK_PORT=4320 MODEL_DOCK_HOME=/path/to/private/data npm start
```

In PowerShell, set variables with syntax such as `$env:MODEL_DOCK_PORT='4320'`. `.env.example` documents the available settings; the application does not load `.env` implicitly.

## Development and packaging

```sh
npm ci
npm run verify       # Syntax, protocol boundaries, HTTP integration, official SDK, and DOM tests
npm run pack:check   # Package, install in isolation, and verify the installed CLI and static assets
npm pack
```

Install a locally built package:

```sh
npm install --global ./lab-model-dock-0.1.0.tgz
model-dock serve
model-dock-demo --open
```

Source repository: [idea007/model-dock](https://github.com/idea007/model-dock). The npm package name is `lab-model-dock`; it has not been published to npm. The installation command above uses a locally generated tarball. Building does not require the original blog repository, its database, or its environment files.

Automated tests use local HTTP/JSON-RPC fixtures. They do not read a real Codex account or call paid models. CI covers Node.js 22/24 on macOS, Linux, and Windows; refer to the CI runs for actual results.

See the [verification record](docs/verification.md) for the initial test results, real Ollama/Codex calls, and remaining verification boundaries.

```text
apps/gateway/       CLI, HTTP, and static asset entry points
apps/console/       Server management console with no build step
apps/demo/          Independent consuming app, private settings and gateway UI
packages/core/      Persistence, authorization, catalogs, routing, and request controls
packages/protocol/  Validation, errors, and streaming protocol
packages/providers/ OpenAI-compatible, Ollama, and Codex adapters
examples/           Standalone client examples
tests/              Offline protocol and integration tests
```

See the [architecture and extraction boundaries](docs/architecture.md), [contributing guide](CONTRIBUTING.md), and [security notes](SECURITY.md).

## License

MIT. See [NOTICE](NOTICE) for provenance and extraction scope. This project does not distribute Codex, Ollama, or any model weights; their respective licenses and service terms apply independently.
