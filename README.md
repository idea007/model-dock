# Model Dock

**English** | [简体中文](README.zh-CN.md)

**Your models. Connected.** A local-first AI gateway and model management console.

Connect your own model APIs, Ollama, and a signed-in Codex CLI through a single endpoint. Apps can call a model by its ID or an alias. The gateway and console have no third-party runtime dependencies; the core, protocols, and provider adapters are maintained in this repository.

## Quick start

Requires **Node.js 22.12+**. Node.js 24 LTS is recommended.

```sh
git clone https://github.com/idea007/model-dock.git
cd model-dock
npm ci
npm start -- --open
```

The console runs at **http://127.0.0.1:4317** by default. The API base URL is **http://127.0.0.1:4317/v1**.

`--open` opens an authenticated local console page in your default browser. If you start with `npm start` alone, run `npm run token` in another terminal to retrieve the administrator token and sign in. The gateway listens only on loopback and does not depend on a hosted platform or the original blog project.

The console currently uses Chinese labels:

1. Add a provider under **Connections & credentials** (`连接与凭证`), then click **Discover models** (`发现模型`).
2. Enable the models you need under **Functions & models** (`功能与模型`). Newly discovered models are disabled by default.
3. Optionally, add aliases such as `chat-default` or `summarize` and bind them to specific models.
4. Create a key for your demo under **Project access** (`项目访问`) and select the models or aliases it may use.
5. Verify a request in the **Playground** (`调用测试`), then configure your app with the gateway URL, project key, and model ID or alias.

To try the gateway without a model account, run `node examples/mock-server.mjs` and follow its terminal instructions to add a clearly labeled test upstream. It returns fixed test content without calling a real model.

## Connect your app

```sh
export MODEL_DOCK_API_KEY='your-project-key-from-the-console'
export MODEL_DOCK_MODEL='chat-default'
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
  model: 'chat-default',
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(result.choices[0].message.content);
```

See the [plain JavaScript example](examples/chat.mjs), [Python SDK example](examples/chat.py), and [application tool-calling example](examples/tools.mjs). Keep project keys in your application's server-side environment variables, not in public browser scripts.

## Three model sources

| Source | Connection | Capabilities |
| --- | --- | --- |
| Your own API | OpenAI-compatible base URL + API key | Multiple connections, model discovery or manual registration, enable/disable controls, aliases, and project access scopes |
| Ollama | Native local HTTP API | Installed-model discovery, capability and context metadata, text inference, streaming, JSON, and model-supported tool calls |
| Codex (experimental) | Locally installed and signed-in CLI / App Server | Model catalog, reasoning effort levels, text, streaming, JSON, application tool calls, and cancellation |

Install and start Ollama separately, then download a model with a command such as `ollama pull <model>`. Model Dock does not download weights at startup or during status checks. Context metadata is displayed for reference; inference does not automatically raise `num_ctx` to the model's maximum.

Codex uses native JSON-RPC and creates a temporary thread for each request. Shell, browser, plugin, and host MCP capabilities are isolated. Application tool calls are returned to the caller for execution; the gateway does not execute them on the app's behalf. This is a real model bridge using the account or upstream configured in Codex and its associated quota. `model/list` is only a catalog and does not establish that the current account can run a particular model.

Codex inherits `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` from the environment that starts the gateway. When no proxy is explicitly configured, macOS detects enabled system HTTP/HTTPS proxies on loopback and passes them only to the Codex child process, without changing system settings. PAC and non-loopback proxies are not imported automatically; set the environment variables explicitly on other platforms or for custom networks. If model listing works but inference keeps reconnecting, check the CLI's proxy connection first.

Built-in Codex authentication has a different scope from hosted services. For commercial or hosted use, evaluate the official API or Sign in with ChatGPT separately. This release does not implement Sign in with ChatGPT or provide shared-account resale or public proxy deployment. [Official App Server documentation](https://learn.chatgpt.com/docs/app-server#auth-endpoints) · [Sign in with ChatGPT](https://developers.openai.com/siwc)

## Compatibility

- `GET /v1/models`
- `POST /v1/chat/completions`: text messages, non-streaming JSON, SSE, tool calls, and tool-result round trips.
- Token usage as reported by the upstream. Missing usage stays unknown rather than being fabricated as zero.
- Client disconnects and cancellation, request timeouts, concurrency limits, and project-key revocation.
- Management APIs for connections, catalogs, model enablement, aliases, project keys, and cancellation of in-flight requests.

**Compatibility is limited to an explicit subset.** Unsupported parameters return errors. Codex cannot guarantee the semantics of options such as `temperature` or `max_tokens`, so it does not silently accept and ignore them. See the [compatibility matrix](docs/compatibility.md) and [management API documentation](docs/api.md).

The initial release does not include the Responses API, image/audio/video support, remote device pairing, multi-user hosting, billing, automatic provider fallback, or Ollama model download/deletion/loading management. See the [roadmap](docs/roadmap.md) for the next phase.

## Data and configuration

Data is stored in the current user's `~/.model-dock` by default. Set `MODEL_DOCK_HOME` to use a dedicated directory. Only one gateway process may write to a directory at a time.

- `state.json`: connections, models, aliases, hashed project keys, and upstream keys encrypted with AES-256-GCM.
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
model-dock serve --open
```

Source repository: [idea007/model-dock](https://github.com/idea007/model-dock). The npm package name is `lab-model-dock`; it has not been published to npm. The installation command above uses a locally generated tarball. Building does not require the original blog repository, its database, or its environment files.

Automated tests use local HTTP/JSON-RPC fixtures. They do not read a real Codex account or call paid models. CI covers Node.js 22/24 on macOS, Linux, and Windows; refer to the CI runs for actual results.

See the [verification record](docs/verification.md) for the initial test results, real Ollama/Codex calls, and remaining verification boundaries.

```text
apps/gateway/       CLI, HTTP, and static asset entry points
apps/console/       Console with no build step
packages/core/      Persistence, authorization, catalogs, routing, and request controls
packages/protocol/  Validation, errors, and streaming protocol
packages/providers/ OpenAI-compatible, Ollama, and Codex adapters
examples/           Standalone client examples
tests/              Offline protocol and integration tests
```

See the [architecture and extraction boundaries](docs/architecture.md), [contributing guide](CONTRIBUTING.md), and [security notes](SECURITY.md).

## License

MIT. See [NOTICE](NOTICE) for provenance and extraction scope. This project does not distribute Codex, Ollama, or any model weights; their respective licenses and service terms apply independently.
