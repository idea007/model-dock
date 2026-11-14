# API reference · v0.1

The gateway listens on `127.0.0.1:4317` by default. Use `http://127.0.0.1:4317/v1` as the OpenAI SDK Base URL. For raw HTTP, append the full paths below to the gateway origin. The gateway checks `Host` and browser `Origin`.

Use a scoped project key (`md_key_…`) as `Authorization: Bearer <key>` for application requests. The local administrator token and an active console session also authenticate local inference. Send `Content-Type: application/json` for JSON bodies.

Download the [OpenAPI 3.1 specification](openapi.json) from the repository or from `GET /openapi.json` on either local app. To import it for a gateway on another port, update the OpenAPI server URL to that gateway's origin. The **API documentation** page (`/?view=api`) in both apps provides cURL examples. The console uses published model IDs. The client uses its connected project's authorized IDs. All examples read the project key from `MODEL_DOCK_API_KEY`.

| Method and path | Operation |
| --- | --- |
| `GET /v1/models` | List published models and legacy aliases visible to the supplied key |
| `POST /v1/chat/completions` | Generate one text completion as JSON or SSE |
| `POST /v1/responses` | Create a stateless text response as JSON or SSE |
| `POST /v1/images/generations` | Generate or edit one Codex image using a JSON body |

## Inference

### List models

`GET /v1/models` returns `{ "object": "list", "data": [...] }`. Use `data[].id` as the complete model ID in the next call, including the connection prefix. An empty list means there are currently no published, available models or aliases within the key's scope. Listing a model reads gateway metadata. The upstream can still require authorization to run it.

See [authorized model metadata](#authorized-model-metadata) for capability fields.

### Chat Completions

Send an exact model ID or an existing legacy alias and a `messages` array. Each message uses string `content` or a non-empty array of `{"type":"text","text":"…"}` parts. Model Dock joins the parts in order without adding separators. Set `n: 1` or omit it.

An assistant message carrying `tool_calls` can omit `content` or set it to `null`. An explicit refusal can also use `content: null`. To resume after a function call, send the assistant's tool calls and all matching `tool` result messages. On Codex the gateway hands off one function per request and the calling app executes it.

```json
{
  "model": "connection-id/model-id",
  "messages": [{ "role": "user", "content": "Introduce yourself in one sentence." }]
}
```

Each response contains one choice. Text is in `choices[0].message.content`. A function handoff uses `choices[0].message.tool_calls` and `finish_reason: "tool_calls"`. The caller executes the function. An explicit refusal uses `choices[0].message.refusal` and may have `content: null`. A refusal is a valid model response, including when `response_format` requests JSON. Usage is optional and is returned when the provider reports complete counters.

Set `stream: true` for `text/event-stream`. Accumulate `choices[0].delta.content`, `delta.refusal` and `delta.tool_calls` across data frames. A complete stream sends a finish-reason chunk, a separate `choices: []` usage chunk if `stream_options.include_usage` is `true` and counters are available, then `data: [DONE]`. Ignore heartbeat comments. If an error occurs after streaming starts, the final data frame contains the error envelope and the connection closes without `[DONE]`. Treat that outcome, or a disconnect without `[DONE]`, as incomplete.

For a completed `json_object` response, the gateway checks JSON syntax and requires a top-level object. In `json_schema` mode it checks syntax and passes the schema to the selected adapter. Schema constraints depend on the provider. Handle refusals, tool handoffs and truncated completions before parsing a structured result. See the [compatibility matrix](compatibility.md) for supported fields and provider mappings.

### Responses

Use `POST /v1/responses` for text with OpenAI-compatible APIs, Ollama and Codex. OpenAI-compatible APIs and Codex can hand off one application function per turn. The gateway uses the same model IDs, project permissions and inference limits as Chat Completions.

| Field | Accepted values |
| --- | --- |
| `model` | Full authorized model ID or a legacy alias |
| `input` | A non-empty user prompt or an ordered array of message and function items. Messages use `system`, `developer`, `user` or `assistant`. Send a string or `input_text` parts. You can replay emitted assistant message items with `output_text` or `refusal` parts |
| `instructions` | Optional string prepended as a system message. Resend it on each request that needs it |
| `stream` | Optional boolean. Set `true` for SSE |
| `store` | Omit or set `false`. Keep conversation history in the calling app |
| `tools`, `tool_choice` | Optional flat function definitions with `type: "function"`, `name` and object-schema `parameters`. Use `auto`, `none`, `required` or `{ "type": "function", "name": "weather" }`. Omitted or null `strict` selects `false`. Explicit strict schemas depend on the upstream and are rejected by Codex |
| `parallel_tool_calls` | Omit or set `false` |

The JSON request limit is 2 MiB. The 2048-message limit includes `instructions` when supplied as a non-empty string. State and background fields such as `previous_response_id`, `conversation`, `store: true` and `background` return `400`. The first release accepts the fields above. Other parameters, such as `max_output_tokens` and structured output settings, return `400`. `GET /v1/responses/{id}` returns `404`.

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

Raw JSON puts text and refusals in the message items in `output`. The SDK derives `output_text` from those items. `usage` gives reported input, output and total token counts, or `null` when counts are unavailable. SSE includes `event:` names, increasing `sequence_number`, and stable item IDs and indexes. Read the final `response.completed`, `response.incomplete`, or `response.failed` event for the response snapshot. `incomplete_details.reason` gives `max_output_tokens` or `content_filter` when reported by the adapter. On failure after streaming starts, read `response.error`. A stream that ends without a terminal event has an unknown outcome.

For functions, read the completed `function_call` item from `output`, execute it in the caller, then send the original history, the returned call item, and its result. Use the call's `call_id` for the result. Streamed function arguments are emitted after the gateway validates the complete call.

```js
const tools = [{
  type: 'function', name: 'weather', strict: false,
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
}];
const history = [{ role: 'user', content: 'What is the weather in Hangzhou?' }];
const turn = await sdk.responses.create({ model, input: history, tools, tool_choice: 'required' });
const call = turn.output.find(item => item.type === 'function_call');
if (call) {
  const result = await sdk.responses.create({ model, input: [
    ...history, ...turn.output,
    { type: 'function_call_output', call_id: call.call_id, output: '22 degrees Celsius.' }
  ] });
  console.log(result.output_text);
}
```

See the [provider compatibility matrix](compatibility.md#responses) and the [OpenAI Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create).

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
| `400` | `invalid_request`, `unsupported_parameter`, `unsupported_model_capability`, `invalid_image_reference`, `reasoning_effort_disabled`, `upstream_rejected` | Check the body, the selected model and its adapter. Use `error.param` when provided |
| `400` | `context_length_exceeded`, `codex_bad_request` | For a context limit, shorten the input or send less history. For a Codex bad request, check the selected model and parameters |
| `401` | `unauthorized`, `key_revoked` | Check or replace the project key |
| `403` | `model_forbidden`, `host_forbidden`, `origin_forbidden` | Check the project's permissions and gateway origin |
| `404` | `model_unavailable`, `not_found` | Refresh the model list or check the request path |
| `409` | `reasoning_policy_unavailable`, `connection_removed` | Refresh configuration or check whether the connection still exists |
| `413` | `request_too_large`, `image_reference_too_large` | Reduce the body or decoded reference size |
| `415` | `unsupported_media_type` | Send `Content-Type: application/json` |
| `429` | `connection_busy` | Gateway capacity was exhausted before provider submission. `Retry-After: 2` gives a delay in seconds |
| `429` | `upstream_rate_limited`, `codex_rate_limited` | The request reached the provider. A valid HTTP upstream `Retry-After` is forwarded as seconds or a standard GMT HTTP date. If the header is absent, choose a backoff based on the provider's quota and your retry policy |
| `499` | `request_cancelled` | The active request was cancelled. A client that disconnected cannot read this response |
| `502` | `upstream_auth_failed`, `upstream_unreachable`, `upstream_protocol_error`, `upstream_json_invalid`, `upstream_tool_choice_failed`, `codex_protocol_error` | Check upstream credentials, availability and response behavior |
| `503` | `codex_image_unavailable`, `shutting_down` | Check the local Codex runtime or gateway process |
| `504` | `request_timeout` | Check the configured connection deadline and provider state |

The gateway submits the request once to the selected adapter. SDKs can retry on their own. For deliberate retries, use `maxRetries: 0` or `max_retries=0` and make the decision in the application. A disconnect or timeout can leave the execution outcome unknown. After a Codex cancellation, the slot stays occupied until the turn ends or the local App Server process stops.

## Authorized model metadata

Each authorized native model includes `name`, `source: {id, name, type}`, nullable `capabilities` values (`text`, `tools`, `structured`, `thinking`), `context_window`, `reasoning_efforts` and `default_reasoning_effort`. A null capability means unknown. `codex-imagegen` also sets `capabilities.image_generation: true` and `capabilities.text: false`. Legacy aliases carry `legacy_alias: true` and the base model identity fields. Use connection-qualified model IDs for new integrations.

The client app uses authorized native text models for application functions and uses the available image model IDs for its API examples. The gateway returns safe metadata scoped to the key.

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
| POST | `/admin/routes` | Legacy route returns `410 client_owned_settings`. Configure new functions in the client |
| DELETE | `/admin/routes/:id` | `revision` only |
| POST | `/admin/keys` | `name` and `models`, an array of permitted IDs or legacy aliases. Use `["*"]` for all published models, including future ones |
| DELETE | `/admin/keys/:id` | `revision` only. Cancels active calls using the revoked key |
| POST | `/admin/requests/:id/cancel` | Empty JSON object `{}`. Use the active request ID from `/admin/state` |

Key creation returns `token` once. On a connection edit, omitting `apiKey` retains the original and an empty string removes it. Discovery failures preserve the saved catalog and record a diagnostic code. A discovery racing a configuration write can return `409 revision_conflict`.

### Atomic model publication

`PATCH /admin/model-settings` validates and stores all publication changes atomically. The `models` array contains every catalog model exactly once with `id` and `enabled`. `reasoningPolicy: {allowedEfforts, defaultEffort}` restricts the model to declared reasoning levels. Supply at least one allowed level and choose the default from it. Omit the field to retain the policy or pass `null` to restore provider behavior. Removing a level used by a saved legacy alias or group returns `409 reasoning_policy_conflict`.

### Console session

`POST /admin/console-links` requires the administrator token and returns `{ "url": "http://127.0.0.1:4317/#session=…" }`. The fragment holds a one-time code valid for five minutes. `POST /console/session` redeems it with JSON `{ "code": "…" }` and returns `{ "session": "…" }`. `DELETE /console/session` revokes the submitted Bearer session. Sessions last up to seven days or until gateway restart. Treat the link and session as credentials.

### Health and client app

`GET /healthz` at the gateway origin needs no key and returns `{ "ok": true, "version": "0.1.0" }`. It reports process liveness. Model readiness depends on the connection and provider.

The [client-demo API](client-demo.md#demo-local-api) runs in the separate client process, on port `4318` by default, with its own local session. It uses a project key to call the gateway.
