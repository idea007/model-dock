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

The screenshots use a separate local instance on ports 4327 and 4328. When following the steps, copy the Base URL shown in your own console.

Use **简体中文 / English** at the bottom of the sidebar in either app. Each app remembers its language in the current browser.

**Server console** with English selected

![English API documentation in the server console with English selected in the lower-left language switcher](docs/screenshots/server-english.webp)

**Client app** with English selected

![English connection settings in the client app with English selected in the lower-left language switcher](docs/screenshots/client-english.webp)

### 1. Add a model source

Open **Connections & credentials** (`连接与凭证`) and add your model API, Ollama instance, or signed-in local Codex CLI. The walkthrough uses Codex. Save the connection, then click **Discover models** (`发现模型`) on its card. The card shows the discovery status and model count.

![Server console showing successful model discovery for a local Codex connection](docs/screenshots/server-connections.webp)

### 2. Publish a model

Open **Models & services** (`模型与服务`) and turn on the switch for the model you want to publish. Newly discovered models start disabled. For models with reasoning levels, choose which levels to expose and use the pin to set the default. Click **Save changes** (`保存更改`) in the upper right to publish. You can try the model under **Playground** (`调用测试`) by selecting it, entering a prompt, and clicking **Send request** (`发送请求`).

![Server model publication page with GPT-6.1 Terra enabled in the draft and Save changes ready](docs/screenshots/server-publish-model.webp)

### 3. Create a project key

Under **Project access** (`项目访问`), click **Create key** (`创建密钥`), enter a project name, and select the published models the project may call. Create the key and copy the full `md_key_…` value while it is visible. Also copy the gateway Base URL from this page.

![Create project access key dialog with one published model selected](docs/screenshots/server-project-key.webp)

## Try the independent client demo

```sh
npm run demo -- --open
```

Start the client in a second terminal while the gateway is running. The client opens directly at **http://127.0.0.1:4318** and shows an empty model catalog until you connect it.

### 1. Connect to the gateway

In **Connection settings** (`接入设置`), paste the gateway Base URL, including `/v1`, and the `md_key_…` project key. Click **Connect and load models** (`连接并读取模型`). Check that **Connected to server** (`已连接服务端`) appears and that the authorized model count matches the project's access. After publishing models or changing capabilities or reasoning levels on the server, use **Refresh models** (`刷新模型`) to sync them.

![Client connection settings with the gateway URL and one authorized model loaded](docs/screenshots/client-connection.webp)

### 2. Assign a model to a feature

Open **Functions & models** (`功能与模型`), enable the model for this client, and select **Free chat** (`自由对话`) in the model's feature column. Click **Save changes** (`保存更改`). For features with multiple candidates, select the allowed models and pin the one to use by default. You can switch between the credential and feature views. [Model preference guide](docs/model-settings.md)

![Client model configuration with an enabled model assigned to Free chat](docs/screenshots/client-functions-models.webp)

### 3. Run the feature

In **Application experience** (`应用体验`), select **Free chat**, keep the default model or pick an allowed candidate, and enter a prompt. Click **Run feature** (`运行功能`) to see the reply under **Result** (`运行结果`). Calls use the selected provider's resources. [Client setup](docs/client-demo.md)

![Client application experience with a prompt and its reply in the result panel](docs/screenshots/client-experience.webp)

| Server console · 4317 | Client demo · 4318 |
| --- | --- |
| Provider connections and upstream secrets | Project connection and authorized catalog |
| Model publication and project scopes | App model choices, feature groups and defaults |
| Capacity, timeout, revocation and request metadata | Prompt templates, per-feature reasoning and user interactions |

Existing server aliases remain compatible with existing keys and calls. New application functions belong in clients; the gateway no longer creates global business aliases.

## Connect your app

Open **API documentation** (`接口文档`) in either sidebar for parameters, response examples and cURL. The client page uses the saved gateway address and authorized model IDs. Run `GET /v1/models` with your project key to get a model's full `data[].id`. To import the API into a client tool, download [OpenAPI 3.1](docs/openapi.json) from the repository or open `/openapi.json` on either local app. [API reference](docs/api.md)

![Client API documentation with GET /v1/models expanded and a Copy cURL button](docs/screenshots/client-api-docs.webp)

```sh
export MODEL_DOCK_API_KEY='your-project-key-from-the-console'
export MODEL_DOCK_BASE_URL='http://127.0.0.1:4317/v1'
curl "$MODEL_DOCK_BASE_URL/models" -H "Authorization: Bearer $MODEL_DOCK_API_KEY"

# Use the full ID of a text model returned above.
export MODEL_DOCK_MODEL='connection-id/model-id'
node examples/chat.mjs
```

No particular SDK is required. Any client that uses the supported subset of the Chat Completions protocol can connect.

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: process.env.MODEL_DOCK_BASE_URL || 'http://127.0.0.1:4317/v1',
  apiKey: process.env.MODEL_DOCK_API_KEY,
  maxRetries: 0,
});
const result = await client.chat.completions.create({
  model: process.env.MODEL_DOCK_MODEL,
  messages: [{ role: 'user', content: 'Hello' }],
});
const { content, refusal } = result.choices[0].message;
console.log(refusal ?? content);
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

Discover models on the Codex connection and publish `codex-imagegen` under **Models & services → Image generation**. In the playground, add up to five reference images, request an aspect ratio or a transparent background, or use **Continue editing**. Grant your project key access to the image model. Use the OpenAI SDK's `images.generate()` for basic generation and the Model Dock JSON extension `reference_images` on `POST /v1/images/generations` for edits. Requests use the signed-in Codex account's quota. [Image API and runnable edit example](docs/api.md#images)

Codex inherits `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` from the environment that starts the gateway. When no proxy is explicitly configured, macOS detects enabled system HTTP/HTTPS proxies on loopback and passes them only to the Codex child process, without changing system settings. PAC and non-loopback proxies are not imported automatically; set the environment variables explicitly on other platforms or for custom networks. If model listing works but inference keeps reconnecting, check the CLI's proxy connection first.

Built-in Codex authentication has a different scope from hosted services. For commercial or hosted use, evaluate the official API or Sign in with ChatGPT separately. This release does not implement Sign in with ChatGPT or provide shared-account resale or public proxy deployment. [Official App Server documentation](https://learn.chatgpt.com/docs/app-server#auth-endpoints) · [Sign in with ChatGPT](https://developers.openai.com/siwc)

## Compatibility

- `GET /v1/models`
- `POST /v1/chat/completions` accepts text and ordered content parts, with one choice per request. It supports JSON, SSE, explicit refusals, and function calls with tool-result round trips.
- `POST /v1/responses` supports stateless text and SSE on all three adapters, plus a single function handoff on OpenAI-compatible APIs and Codex. Use `sdk.responses.create()` and carry forward history in `input`. The gateway defaults to `store: false`. [Responses examples](docs/api.md#responses)
- Vision-capable models on all three adapters can read PNG, JPEG or WebP Base64 data URLs in user messages. Use `image_url` with Chat Completions or `input_image` with Responses. Omit `detail` or set it to `auto`. Images and history count toward the 2 MiB JSON limit. [Image input examples](docs/api.md#image-input)
- `POST /v1/images/generations`: one Base64-encoded image from Codex, with optional reference images.
- Token usage as reported by the upstream. Missing usage stays unknown rather than being fabricated as zero.
- Client disconnects and cancellation, request timeouts, concurrency limits, and project-key revocation.
- Management APIs for connections, catalogs, model publication, project keys, and cancellation of in-flight requests.

**Compatibility covers the documented subset.** Unsupported parameters return errors. For example, Codex rejects `temperature` and `max_tokens`. On a `429`, inspect `error.code` to distinguish gateway capacity from provider rate limits. See the [compatibility matrix](docs/compatibility.md), [errors and retries](docs/api.md#errors-and-retries) and [management API](docs/api.md#management).

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
