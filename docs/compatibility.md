# Compatibility contract · v0.1

Model Dock implements OpenAI-compatible text generation from text or images through Chat Completions and Responses, with a separate Codex image generation endpoint. Chat requests use one model and one choice. Omit `n` or set it to `1`. The gateway joins pure text arrays in order, preserves image parts in user messages and turns omitted assistant tool-call content into `null`. See the [OpenAPI 3.1 specification](openapi.json) for request and response schemas.

## Chat Completions and other endpoints

| Feature | OpenAI-compatible provider | Ollama native API | Codex App Server |
| --- | --- | --- | --- |
| JSON response / SSE | Yes | Yes | Yes |
| Text messages and role history | Forwarded after input normalization | Native roles, with developer mapped to system | Native role history injection |
| Image input `image_url` | Model-dependent | Model-dependent | Model-dependent |
| Explicit refusal in response | `message.refusal` in JSON and `delta.refusal` in SSE when reported | Native text output | Native text output |
| Function tools and results | Forwarded | Model-dependent; arguments translated and call IDs preserved or generated | One function handoff per request |
| JSON object / schema | Provider-dependent | `format` mapping | Native output schema; JSON-object instruction |
| `temperature`, `top_p`, `seed`, `stop` | Forwarded | Native options | Rejected |
| `max_tokens` / `max_completion_tokens` | Forwarded (one only) | `num_predict` | Rejected: no enforceable equivalent |
| `reasoning_effort` | Forwarded | none/low/medium/high; requires supporting model | Validated against the discovered model catalog |
| `tool_choice` | Forwarded | auto/none only | auto/none/required/specified function |
| `parallel_tool_calls` | Forwarded | `false` limits the turn to one call at most. Omission follows the model. | Omit or use `false` |
| Tool schema `strict:true` | Forwarded | Rejected | Rejected |
| Output schema `strict:true` | Forwarded for the provider to enforce | Rejected | Schema passed as native `outputSchema` |
| `user` | Forwarded | Rejected | Rejected |
| Usage | Reported by provider | eval counters | Complete native cumulative counters only |
| Image generation and editing (`/v1/images/generations`) | Not exposed | Not exposed | `codex-imagegen`. SDK `images.generate()` for basic generation, Model Dock `reference_images` JSON extension for edits |
| Audio/video/embeddings | Not exposed | Not exposed | Not exposed |

## Responses

| `POST /v1/responses` | OpenAI-compatible provider | Ollama native API | Codex App Server |
| --- | --- | --- | --- |
| Stateless text / SSE | Via Chat Completions | Via `/api/chat` | Via temporary threads |
| Image input `input_image` | Converted to `image_url` | Converted to message `images` | Native image input and history |
| Up to one application function per turn | Model-dependent | Model-dependent via `/api/chat` | Supported |
| Function tool choice | `auto`, `none`, `required`, or a named function, subject to the upstream | `auto` or `none` | `auto`, `none`, `required`, or a named function |
| Function `strict: true` | Forwarded | Rejected | Rejected |

All three adapters accept a text prompt or caller-supplied message history. Responses always uses `store: false` and sends that flag to OpenAI-compatible Chat Completions upstreams. Send a completed `function_call` and a matching `function_call_output` with a string result when resuming a tool turn. The caller executes the function. Responses-only upstreams need a separate native adapter. `max_output_tokens` maps to `max_completion_tokens` on compatible APIs and `num_predict` on Ollama. Codex rejects the parameter. Stored responses, background execution, built-in tools, audio, video, file input, and reasoning replay are outside this release's request schema. [Responses API examples](api.md#responses)

The stream emits typed events and ends with `response.completed`, `response.incomplete` or `response.failed`. The gateway requests usage when streaming through the official OpenAI API. The terminal response carries reported counters or `usage: null`. The request body limit is 2 MiB, with up to 2048 input items within the shared message and output limits.

## Image input

Both text generation endpoints accept PNG, JPEG or WebP Base64 data URLs in user messages. Omit `detail` or use `auto`. The 2 MiB JSON limit includes all text, image data and replayed history. Resend each prior image in its original user message. [API examples](api.md#image-input)

| Adapter | Image mapping | Model capability |
| --- | --- | --- |
| OpenAI-compatible API | Forwards ordered Chat Completions content parts and data URLs | Reads optional `capabilities.image_input` from `/models` |
| Ollama | Sends the joined text and one ordered bare-Base64 `images` array per user message | Reads `vision` from `/api/show` |
| Codex | Sends ordered image items in the current turn and `input_image` parts in earlier user messages | Reads `image` from `model/list` input modalities |

The gateway rejects images when the model declares `image_input: false`. Unspecified support is reported as `null` and the selected upstream handles the request.

## Shared behavior

Compatible legacy model aliases are resolved to a fixed connection and native model for each request. The gateway submits the request to the selected adapter once. Codex may reconnect or fall back from WebSockets to HTTPS within a native turn. These attempts count toward the configured timeout. For explicit control over application retries, configure the OpenAI SDK with `maxRetries: 0` (JavaScript) or `max_retries=0` (Python).

A gateway `429 connection_busy` includes `Retry-After: 2` and is returned before provider submission. `429 upstream_rate_limited` carries the valid delay in seconds or GMT HTTP date when the HTTP upstream supplies it. `429 codex_rate_limited` can omit the header. See [error handling](api.md#errors-and-retries).

An explicit refusal completes normally even when structured output was requested. For other completed text outputs, Model Dock checks JSON syntax in both structured modes and the top-level object type in `json_object` mode. Schema constraints are handled by the upstream or native runtime. Assistant refusal history uses `refusal` and may use `content: null`. The OpenAI-compatible adapter forwards that history. Ollama and Codex can carry the refusal as assistant text.

Both endpoints stream text as it arrives and hand off tool calls only after a completed turn and full validation. The caller executes the functions and sends back the results. Ollama tool results include the native `tool_name` and matching `tool_call_id`, and Ollama models must support tools. A declared lack of tool support rejects requests with new tool definitions. [Call and replay examples](api.md#function-calling)

Chat Completions SSE ends with a finish-reason chunk, an optional usage chunk with `choices: []` when requested and known, then `[DONE]`. With `include_usage: true`, earlier chunks include `usage: null`. A failure after streaming starts arrives as `data: {"error": ...}` and closes without `[DONE]`. Treat any Chat Completions stream without the sentinel as incomplete.

The chat request body limit is 2 MiB. Chat supports up to 8 MiB of output, 2048 messages and 128 function definitions. The image endpoint accepts up to 70 MiB of JSON, including a prompt of up to 4,000 characters and up to 50 MiB of decoded references. A single result may be up to 30 MiB before Base64 encoding. The gateway allows up to 32 active requests globally. Per-connection concurrency defaults to 2. Codex allows one active request across text, images and all Codex connections. The connection timeout is configurable from 5 to 1800 seconds.

Codex is experimental because history injection and dynamic tools use its experimental API. The initial implementation was checked against a locally installed `codex-cli 0.164.0`. Fixtures validate the JSON-RPC contract. Each new CLI version needs a real protocol smoke test. Available account entitlements can differ from the model catalog.

Codex context limits return `400 context_length_exceeded`, native bad requests return `400 codex_bad_request`, and native rate limits return `429 codex_rate_limited`. An empty or inconsistent completed text turn returns `codex_protocol_error`. The shared Codex slot stays occupied until the interrupted turn reaches a terminal event or the local process stops.

Image generation uses a separate native process and the signed-in Codex account's quota. Publish the image model from the local runtime before use. Model Dock returns one complete image with its actual size and format. OpenAI's `/v1/images/edits` route returns `404` on Model Dock. See the [image parameters and reference-edit example](api.md#images).

The OpenAI-compatible adapter can read optional `/models` metadata from `capabilities`, `reasoning_efforts`, `default_reasoning_effort`, `context_window`, `max_input_tokens`, and `max_output_tokens`. Missing capabilities and limits stay unknown. Ollama uses `/api/show` and filters out embedding-only entries. Displayed context limits are informational. Ollama's configured context determines memory allocation.

References: [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility), [Codex App Server](https://learn.chatgpt.com/docs/app-server).
