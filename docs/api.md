# API reference · v0.1

The gateway listens on `127.0.0.1:4317` by default. Use `http://127.0.0.1:4317/v1` as the OpenAI SDK Base URL. For raw HTTP, append the full paths below to the gateway origin. The gateway checks `Host` and browser `Origin`.

Use a scoped project key (`md_key_…`) as `Authorization: Bearer <key>` for application requests. The local administrator token and an active console session also authenticate local inference. Send `Content-Type: application/json` for JSON bodies.

Download the [OpenAPI 3.1 specification](openapi.json) from the repository or from `GET /openapi.json` on either local app. To import it for a gateway on another port, update the OpenAPI server URL to that gateway's origin. The **API documentation** page (`/?view=api`) in both apps provides cURL examples. The console uses published model IDs. The client uses its connected project's authorized IDs. All examples read the project key from `MODEL_DOCK_API_KEY`.

| Method and path | Operation |
| --- | --- |
| `GET /v1/models` | List published models, deployment pools and legacy aliases visible to the supplied key |
| `POST /v1/chat/completions` | Accept text or images and return text or function calls as JSON or SSE |
| `POST /v1/responses` | Accept text or images and return a stateless response with up to one function call as JSON or SSE |
| `POST /v1/images/generations` | Generate or edit one Codex image using a JSON body |

## Inference

### List models

`GET /v1/models` returns `{ "object": "list", "data": [...] }`. Use `data[].id` as the complete model ID in the next call, including the connection prefix. An empty list means there are currently no published, available models or aliases within the key's scope. Listing a model reads gateway metadata. The upstream can still require authorization to run it.

See [authorized model metadata](#authorized-model-metadata) for capability fields.

### Chat Completions

Send an exact model ID, deployment pool ID or legacy alias, plus a `messages` array. Each message uses string `content` or a non-empty array of parts. Model Dock joins pure text arrays in order. A user message can mix `text` and `image_url` parts. Set `n: 1` or omit it. [Image input examples](#image-input)

An assistant message carrying `tool_calls` or an explicit refusal can use `content: null`. For a tool call, `content` may also be omitted. [Function call and replay example](#function-calling)

```json
{
  "model": "connection-id/model-id",
  "messages": [{ "role": "user", "content": "Introduce yourself in one sentence." }]
}
```

Each response contains one choice. Text is in `choices[0].message.content`. A function handoff uses `choices[0].message.tool_calls` and `finish_reason: "tool_calls"`. The caller executes the function. An explicit refusal uses `choices[0].message.refusal` and may have `content: null`. A refusal is a valid model response, including when `response_format` requests JSON. Usage is optional and is returned when the provider reports complete counters.

Set `stream: true` for `text/event-stream`. Text and refusals arrive as `choices[0].delta.content` and `delta.refusal`. The gateway emits completed, validated tool calls together in one `delta.tool_calls` chunk before `finish_reason: "tool_calls"`. A turn ending with `length` or `content_filter` has no executable tool calls. With `stream_options.include_usage: true`, ordinary chunks have `usage: null` and known counters arrive in a final `choices: []` chunk. A complete stream ends with `data: [DONE]`. Ignore heartbeat comments. If a failure occurs after streaming starts, the last data frame contains the error envelope. Execute calls only after receiving the expected finish reason and `[DONE]`.

For a completed `json_object` response, the gateway checks JSON syntax and requires a top-level object. In `json_schema` mode it checks syntax and passes the schema to the selected adapter. Schema constraints depend on the provider. Handle refusals, tool handoffs and truncated completions before parsing a structured result. See the [compatibility matrix](compatibility.md) for supported fields and provider mappings.

### Responses

Use `POST /v1/responses` for text or image input with OpenAI-compatible APIs, Ollama and Codex. Tool-capable models can hand off up to one application function per turn. The gateway uses the same model IDs, project permissions and inference limits as Chat Completions.

| Field | Accepted values |
| --- | --- |
| `model` | Authorized model ID, deployment pool ID or legacy alias |
| `input` | A non-empty user prompt or an ordered array of message and function items. Messages use `system`, `developer`, `user` or `assistant`. User messages can mix `input_text` and `input_image`. Replay assistant output with `output_text` or `refusal` parts |
| `instructions` | Optional string prepended as a system message. Resend it on each request that needs it |
| `stream` | Optional boolean. Set `true` for SSE |
| `store` | Omit or set `false`. Keep conversation history in the calling app |
| `max_output_tokens` | Optional integer from 1 to 1,000,000. Supported by compatible upstreams and Ollama. Codex rejects this field |
| `tools`, `tool_choice` | Optional flat function definitions with `type: "function"`, `name` and object-schema `parameters`. Use `auto` or `none` on all adapters. OpenAI-compatible APIs and Codex also accept `required` and named functions such as `{ "type": "function", "name": "weather" }`. Omitted or null `strict` selects `false`. `strict: true` requires support from the OpenAI-compatible upstream |
| `parallel_tool_calls` | Omit or set `false` |

The JSON request limit is 2 MiB. The 2048-message limit includes `instructions` when supplied as a non-empty string. State and background fields such as `previous_response_id`, `conversation`, `store: true` and `background` return `400`. Structured output settings are available through Chat Completions. `GET /v1/responses/{id}` returns `404`.

```js
import OpenAI from 'openai';

const sdk = new OpenAI({
  baseURL: 'http://127.0.0.1:4317/v1',
  apiKey: process.env.MODEL_DOCK_API_KEY,
  maxRetries: 0
});
const model = 'connection-id/model-id';
const input = [{ role: 'user', content: 'Introduce yourself in one sentence.' }];
const first = await sdk.responses.create({ model, input, store: false });
console.log(first.output_text);

const stream = await sdk.responses.create({ model, stream: true, input: [
  ...input, ...first.output, { role: 'user', content: 'Make that shorter.' }
] });
let terminal;
for await (const event of stream) {
  if (event.type === 'response.output_text.delta') process.stdout.write(event.delta);
  if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) terminal = event.response;
}
if (!terminal) throw new Error('The stream ended before a terminal event.');
if (terminal.status === 'failed') throw new Error(terminal.error.message);
if (terminal.status === 'incomplete') console.error(terminal.incomplete_details.reason);
```

Raw JSON puts text and refusals in the message items in `output`. The SDK derives `output_text` from those items. `usage` gives reported input, output and total token counts, or `null` when counts are unavailable. The gateway requests counts when streaming through the official OpenAI API. SSE includes `event:` names, increasing `sequence_number`, and stable item IDs and indexes. Read the final `response.completed`, `response.incomplete`, or `response.failed` event for the response snapshot. `incomplete_details.reason` gives `max_output_tokens` or `content_filter` when reported by the adapter. On failure after streaming starts, read `response.error`. A stream that ends without a terminal event has an unknown outcome.

With SSE, each validated call emits `response.function_call_arguments.delta` with the full JSON argument string, followed by `response.function_call_arguments.done` and `response.output_item.done`. Wait for `response.completed` before executing the call. [Function call and replay example](#function-calling) · [OpenAI Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)

### Function calling

Choose a project-authorized model that supports tools. Check `data[].capabilities.tools` from `GET /v1/models`. A value of `null` means the gateway has no capability metadata, so verify support with the upstream.

| | Chat Completions | Responses |
| --- | --- | --- |
| Function definition | `{ type: "function", function: { name, parameters } }` | `{ type: "function", name, parameters }` |
| Complete call | `choices[0].message.tool_calls` with `finish_reason: "tool_calls"` | `output` item of type `function_call` in a completed response |
| Replay | Original `messages`, the full assistant message, then one `role: "tool"` message per call. Match `tool_call_id` to the call's `id` | Original `input`, the full previous `output`, then a `function_call_output` item. Match `call_id` to the call's `call_id`. The item's `id` identifies it in SSE |

The caller validates the function name and arguments, executes the function, and sends each result as a string. Plain text, serialized JSON and an empty string are valid results. Keep all completed pairs in order when replaying multiple turns.

Use `tool_choice: "auto"` to let a model choose between text and a function, or `"none"` to suppress new calls. Ollama supports these two modes. OpenAI-compatible APIs and Codex also accept `"required"` and a named function. With `parallel_tool_calls: false`, at most one call is handed off per turn. Responses and Codex apply that limit every turn. OpenAI-compatible Chat may return multiple calls on a supporting model. [Provider compatibility](compatibility.md)

The following examples use the same `sdk` and `model` as above. Both submit one local addition result and then request a final answer.

```js
const history = [{ role: 'user', content: 'Use the add function to calculate 17 + 25.' }];
const add = {
  name: 'add',
  parameters: {
    type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'], additionalProperties: false
  }
};
const singleCall = { model, tool_choice: 'auto', parallel_tool_calls: false };

function runAdd(name, args) {
  const input = JSON.parse(args);
  if (name !== add.name || !Number.isFinite(input?.a) || !Number.isFinite(input?.b) || Object.keys(input).length !== 2) {
    throw new Error('Invalid add call.');
  }
  return JSON.stringify({ result: input.a + input.b });
}
```

#### Chat Completions round trip

```js
const chat = await sdk.chat.completions.create({
  ...singleCall, messages: history, tools: [{ type: 'function', function: add }]
});
const choice = chat.choices[0];
if (choice.finish_reason === 'tool_calls') {
  const [call] = choice.message.tool_calls;
  const final = await sdk.chat.completions.create({ model, messages: [
    ...history, choice.message,
    { role: 'tool', tool_call_id: call.id, content: runAdd(call.function.name, call.function.arguments) }
  ] });
  console.log(final.choices[0].message.content);
} else {
  console.log(choice.message.refusal ?? choice.message.content);
}
```

#### Responses round trip

```js
const turn = await sdk.responses.create({
  ...singleCall, input: history, store: false, tools: [{ type: 'function', ...add }]
});
if (turn.status === 'completed') {
  const call = turn.output.find(item => item.type === 'function_call');
  if (call) {
    const final = await sdk.responses.create({ model, store: false, input: [
      ...history, ...turn.output,
      { type: 'function_call_output', call_id: call.call_id, output: runAdd(call.name, call.arguments) }
    ] });
    console.log(final.output_text);
  } else {
    console.log(turn.output_text);
  }
}
```

### Image input

Choose a published model authorized for your project that can read images. The model catalog uses `capabilities.image_input` for this capability. A value of `false` rejects image requests. A value of `null` leaves support up to the upstream.

Both endpoints accept PNG, JPEG and WebP as Base64 data URLs in user messages. Omit `detail` or pass `"auto"`. HTTP URLs, local paths and `file_id` return `400`. The entire JSON request, including encoded images, instructions and history, must fit within 2 MiB. Base64 uses roughly four bytes for every three image bytes.

Use the same SDK setup as above, with `model` set to a vision-capable model ID. The example reads a local PNG and sends a Chat Completions request, then shows how to replay an image with Responses.

```js
import { readFile } from 'node:fs/promises';

const dataUrl = 'data:image/png;base64,' + (await readFile('reference.png')).toString('base64');
const question = 'What color is this image?';

const chat = await sdk.chat.completions.create({ model, messages: [{
  role: 'user', content: [
    { type: 'text', text: question },
    { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } }
  ]
}] });
console.log(chat.choices[0].message.content);

const history = [{
  role: 'user', content: [
    { type: 'input_text', text: question },
    { type: 'input_image', image_url: dataUrl }
  ]
}];
const reply = await sdk.responses.create({ model, input: history, store: false });
const followUp = await sdk.responses.create({
  model, input: [...history, ...reply.output, { role: 'user', content: 'Name a matching color.' }], store: false
});
console.log(followUp.output_text);
```

Both endpoints return text with the same JSON or SSE format used for text-only requests. Set `stream: true` to stream the answer. For a follow-up, resend the original user message with its image in `messages` or `input`. Images remain attached to their user messages throughout replay. [Provider compatibility](compatibility.md#image-input) · [OpenAI image input guide](https://developers.openai.com/api/docs/guides/images-vision)

### Images

`POST /v1/images/generations` uses a published, authorized `connection-id/codex-imagegen` model. Use a project key to list models and select an entry whose `capabilities.image_generation` is `true`. Basic generation works with the OpenAI SDK's `images.generate({ model, prompt })`. Use the Model Dock `reference_images` extension on the same JSON endpoint for reference-based editing. The SDK's `images.edit()` calls `/v1/images/edits`, which returns `404` on Model Dock. See the [OpenAI image edit reference](https://developers.openai.com/api/reference/resources/images/methods/edit).

```json
{"model":"connection-id/codex-imagegen","prompt":"A blue ceramic cup on a light background"}
```

| Field | Accepted values |
| --- | --- |
| `model` | Required. Full ID of the Codex image model |
| `prompt` | Required. Non-empty text up to 4,000 UTF-16 code units |
| `reference_images` | Optional. Up to 5 ordered PNG, JPEG or WebP Base64 data URLs. The MIME type must match the decoded image. At most 30 MiB per decoded image and 50 MiB in total |
| `aspect_ratio` | Optional. `16:9`, `9:16`, `1:1`, or `4:5`. Omit it to let Codex choose the canvas |
| `background` | Optional. `auto` or `transparent`. Transparency is a generation request |
| `n`, `response_format` | Optional. If supplied, use `1` and `b64_json` |

The complete JSON body may be up to 70 MiB. Refer to attached images by their order starting at 1. The example below uses Node.js and cURL. Set `MODEL_DOCK_IMAGE_MODEL` to the full authorized image model ID and `IMAGE_PATH` to a local PNG file.

```sh
export MODEL_DOCK_BASE_URL='http://127.0.0.1:4317/v1'
export MODEL_DOCK_IMAGE_MODEL='connection-id/codex-imagegen'
IMAGE_PATH=reference.png
node -e '
  const fs = require("node:fs")
  const [file, model] = process.argv.slice(1)
  const reference = "data:image/png;base64," + fs.readFileSync(file).toString("base64")
  const prompt = "Keep the cup from image 1 and make it green."
  process.stdout.write(JSON.stringify({ model, prompt, reference_images: [reference] }))
' "$IMAGE_PATH" "$MODEL_DOCK_IMAGE_MODEL" |
  curl "$MODEL_DOCK_BASE_URL/images/generations" \
    -H "Authorization: Bearer $MODEL_DOCK_API_KEY" \
    -H 'Content-Type: application/json' \
    --data-binary @-
```

The response contains one image. Decode `data[0].b64_json` to get the file, up to 30 MiB before Base64 encoding. `output_format` is `png`, `jpeg` or `webp`, and `data[0].width` and `data[0].height` give its actual pixel dimensions. Check the result for its aspect ratio and transparency. For another edit, add `` `data:image/${output_format};base64,${data[0].b64_json}` `` to `reference_images`. The console playground's **Continue editing** button adds the previous result as the first reference.

Text and image calls share the single Codex request slot. The same connection timeout, cancellation and key revocation rules apply. To limit the application to one submission, set `maxRetries: 0` in the JavaScript SDK or `max_retries=0` in Python. After losing the response, the result of the first submission may be unknown.

<a id="error-handling"></a>

## Errors and retries

Record the gateway response header `x-request-id`. Include it, the HTTP status and `error.code` when diagnosing a call. HTTP errors use `{ "error": { "message", "type", "code", "param" } }`. `param` can be `null`. After SSE starts, HTTP status remains `200`. Chat Completions sends the error envelope in a `data:` frame. Responses sends a `response.failed` event with details in `response.error`.

| HTTP status | Example codes | What to check |
| --- | --- | --- |
| `400` | `invalid_request`, `unsupported_parameter`, `unsupported_model_capability`, `invalid_image_input`, `invalid_image_reference`, `reasoning_effort_disabled`, `upstream_rejected` | Check the body, the selected model and its adapter. Use `error.param` when provided |
| `400` | `context_length_exceeded`, `codex_bad_request` | For a context limit, shorten the input or send less history. For a Codex bad request, check the selected model and parameters |
| `401` | `unauthorized`, `key_revoked` | Check or replace the project key |
| `403` | `model_forbidden`, `host_forbidden`, `origin_forbidden` | Check the project's permissions and gateway origin |
| `404` | `model_unavailable`, `not_found` | Refresh the model list or check the request path |
| `409` | `reasoning_policy_unavailable`, `connection_removed` | Refresh configuration or check whether the connection still exists |
| `409` | `budget_price_required`, `budget_token_ceiling_required` | Set a matching deployment price and verify token ceilings. Supply a supported output limit if relevant |
| `413` | `request_too_large`, `image_reference_too_large` | Reduce the body or decoded reference size |
| `415` | `unsupported_media_type` | Send `Content-Type: application/json` |
| `429` | `connection_busy` | Gateway capacity was exhausted before provider submission. `Retry-After: 2` gives a delay in seconds |
| `429` | `project_rate_limited`, `project_at_capacity`, `request_body_capacity` | A project limit or the shared request body capacity was reached before provider submission. `Retry-After` gives a delay in seconds |
| `429` | `project_budget_exceeded` | The remaining monthly budget cannot cover this reservation. Reduce an applicable output limit or review the project budget |
| `429` | `upstream_rate_limited`, `codex_rate_limited` | The request reached the provider. A valid HTTP upstream `Retry-After` is forwarded as seconds or a standard GMT HTTP date. If the header is absent, choose a backoff based on the provider's quota and your retry policy |
| `499` | `request_cancelled` | The active request was cancelled. A client that disconnected cannot read this response |
| `502` | `upstream_auth_failed`, `upstream_unreachable`, `upstream_protocol_error`, `upstream_json_invalid`, `codex_protocol_error` | Check upstream credentials, availability and response behavior |
| `502` | `upstream_tool_choice_failed`, `codex_tool_required`, `codex_tool_invalid` | Check that the model supports the requested choice and returned a valid call within the turn's limit |
| `503` | `codex_image_unavailable`, `shutting_down` | Check the local Codex runtime or gateway process |
| `503` | `pool_unavailable` | All compatible deployments are cooling down. `Retry-After` is the earliest cooldown expiry in seconds |
| `503` | `budget_ledger_unavailable` | Check the local budget ledger file and directory permissions |
| `504` | `request_timeout` | Check the configured connection deadline and provider state |

The gateway submits the request once to the selected adapter. SDKs can retry on their own. For deliberate retries, use `maxRetries: 0` or `max_retries=0` and make the decision in the application. A disconnect or timeout can leave the execution outcome unknown. After a Codex cancellation, the slot stays occupied until the turn ends or the local App Server process stops.

## Authorized model metadata

Each authorized model includes `name`, `source: {id, name, type}`, nullable `capabilities` values (`text`, `tools`, `structured`, `thinking`, `image_input`), `context_window`, `reasoning_efforts` and `default_reasoning_effort`. A null capability means unknown. `codex-imagegen` also sets `capabilities.image_generation: true` and `capabilities.text: false`. Deployment pools use `source.type: "pool"` and advertise shared capabilities. Legacy aliases carry `legacy_alias: true` and the base model identity fields.

The client app uses authorized text models and pools for application functions and uses available image model IDs for its API examples. The gateway returns metadata scoped to the key.

## Management

Call management routes at the gateway origin with the local administrator token or a console session. `GET /admin/state` returns the catalog, settings revision, safe connection and key metadata, active requests, recent request metadata, version and SDK Base URL. Stored upstream credentials and key hashes are excluded.

Configuration writes use the latest integer `revision`, including the JSON body on `DELETE` requests. A stale revision returns `409 revision_conflict`. Reload and resubmit the intended change. Successful changes return `{ ok, state, ...result }`.

| Method | Path | Fields in addition to `revision` |
| --- | --- | --- |
| POST | `/admin/connections` | `name`, `type` (`openai`, `ollama`, `codex`), `baseUrl?`, `apiKey?`, `enabled?`, `maxConcurrency?`, `timeoutSeconds?` |
| PATCH | `/admin/connections/:id` | Changed fields above. `type` is fixed after creation |
| DELETE | `/admin/connections/:id` | `revision` only |
| POST | `/admin/connections/:id/discover` | `revision` only. Discovers model metadata |
| POST | `/admin/models` | `connectionId`, `nativeId`, `name?`. Manually registers a model on an API connection |
| PATCH | `/admin/models/:encodedId` | `enabled`. URL-encode the entire model ID |
| PATCH | `/admin/model-settings` | Complete `models` array of `{id, enabled, reasoningPolicy?}` |
| POST | `/admin/pools` | `name`, `modelIds`, `enabled`. Returns the assigned pool ID |
| PATCH | `/admin/pools/:id` | `name`, `modelIds`, `enabled` |
| DELETE | `/admin/pools/:id` | `revision` only |
| POST | `/admin/routes` | Legacy route returns `410 client_owned_settings`. Configure new functions in the client |
| DELETE | `/admin/routes/:id` | `revision` only |
| POST | `/admin/keys` | `name`, `models`, `limits?` and `budget?`. Use `["*"]` for all published models and pools, including future ones |
| PATCH | `/admin/keys/:id` | `limits?`, `budget?`. Omitted settings keep their values |
| DELETE | `/admin/keys/:id` | `revision` only. Cancels active calls using the revoked key |
| PATCH | `/admin/usage/prices` | `modelId`, `price` |
| POST | `/admin/requests/:id/cancel` | Empty JSON object `{}`. Use the active request ID from `/admin/state` |

Key creation returns `token` once. `models` lists permitted model or deployment pool IDs and legacy aliases. For connection edits within the same URL origin, omitting `apiKey` keeps the saved key. Changing the scheme, host or port on a connection with a saved key requires a replacement `apiKey` or an empty string to remove it. Discovery failures preserve the saved catalog and record a diagnostic code. A discovery racing a configuration write can return `409 revision_conflict`.

### Deployment pools

Create a pool under **Models & services** by selecting at least two deployments of the same native model on distinct upstream addresses using the same adapter. Grant access to the assigned pool ID and use that ID in inference requests. A pool-scoped key can reach members through the pool. Direct member IDs require their own grants. Requests using an explicit deployment ID or legacy alias keep their existing routing.

The gateway filters by published status, capabilities, available connection slots and budget. Among eligible deployments it chooses the lowest fraction of occupied slots and rotates ties. A connection can enter cooldown after rate limits, authentication, network, timeout or upstream response failures. The gateway uses a valid upstream delay when available and defaults to 30 seconds. A submitted request stays with its chosen deployment. The usage log records the requested pool ID and the actual deployment.

### Project limits, budgets and local usage

`limits` accepts `{requestsPerMinute?, maxConcurrentRequests?}` with positive integer values. Omit a field or set it to `null` for unlimited use. A patch replaces both settings, and `limits: null` clears them. Existing keys without limits remain valid. A key shares one 60-second window and one concurrency limit across Chat Completions, Responses and Images. Admitted attempts count toward the time window even when subsequent validation or execution fails. Counters restart with the process. The gateway also reserves space for up to 32 JSON request bodies and 128 MiB in aggregate. A body without `Content-Length` reserves its endpoint maximum.

`GET /admin/usage` reports admitted executions, with daily, project and model totals and up to 100 recent entries. Use `days` from 1 to 30 (default 7), `project` for a project key ID and `model` for the full model ID. Dates use the gateway’s local time. Add `format=csv` to export all matching entries. Entries keep the project and model names from the request, including after a key has been revoked. They contain request metadata and usage only. Records without measured tokens or a known image count contribute to the unknown usage count.

For text models, `price` has `currency`, `inputPerMillion` and `outputPerMillion`, plus optional verified `maxInputTokens` and `maxOutputTokens` when catalog metadata omits them. For image models, it has `currency` and `perImage`. Use a three-letter uppercase currency code and non-negative prices. `price: null` clears the price. Estimates use the price at submission and apply when usage or output image count is known.

`budget` accepts `{currency, amount}` with a positive amount of up to six decimal places. `budget: null` clears the setting. Accounting starts with budgeted requests and follows the gateway's local calendar month. Changing the amount retains charges already tracked for the same key and currency. The admin snapshot reports settled, reserved, unconfirmed and remaining amounts.

The gateway reserves the cost before dispatch using a matching price and a verified token ceiling for each charged dimension or the price of one image. A supported output limit can lower the reservation. It rounds each charge up to a millionth of the currency unit. Complete usage settles the reservation, and unknown usage keeps it as an unconfirmed charge. A stopped request stays in the month when it was admitted. The allowance applies to the gateway's estimate. Its accuracy depends on configured prices, token ceilings and provider reporting. If reported usage exceeds the reservation, the gateway accounts for the full estimate and applies the reduced balance to future requests.

### Atomic model publication

`PATCH /admin/model-settings` validates and stores all publication changes atomically. The `models` array contains every catalog model exactly once with `id` and `enabled`. `reasoningPolicy: {allowedEfforts, defaultEffort}` restricts the model to declared reasoning levels. Supply at least one allowed level and choose the default from it. Omit the field to retain the policy or pass `null` to restore provider behavior. Removing a level used by a saved legacy alias or group returns `409 reasoning_policy_conflict`.

### Console session

`POST /admin/console-links` requires the administrator token and returns `{ "url": "http://127.0.0.1:4317/#session=…" }`. The fragment holds a one-time code valid for five minutes. `POST /console/session` redeems it with JSON `{ "code": "…" }` and returns `{ "session": "…" }`. `DELETE /console/session` revokes the submitted Bearer session. Sessions last up to seven days or until gateway restart. Treat the link and session as credentials.

### Health and client app

`GET /healthz` at the gateway origin needs no key and returns `{ "ok": true, "version": "0.1.0" }`. It reports process liveness. Model readiness depends on the connection and provider.

The [client-demo API](client-demo.md#demo-local-api) runs in the separate client process, on port `4318` by default, with its own local session. It uses a project key to call the gateway.
