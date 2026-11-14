# Compatibility contract · v0.1

Model Dock implements text subsets of OpenAI Chat Completions and Responses, and a single-image endpoint for Codex. Chat requests use one model and one choice. Omit `n` or set it to `1`. The gateway joins non-empty arrays of text parts in order, and turns omitted assistant tool-call content into `null` before calling the adapter. Other content part types and invalid tool histories are rejected before inference. See the [OpenAPI 3.1 specification](openapi.json) for request and response schemas.

## Chat Completions and other endpoints

| Feature | OpenAI-compatible provider | Ollama native API | Codex App Server |
| --- | --- | --- | --- |
| JSON response / SSE | Yes | Yes | Yes |
| Text messages and role history | Forwarded after input normalization | Native roles, with developer mapped to system | Native role history injection |
| Explicit refusal in response | `message.refusal` in JSON and `delta.refusal` in SSE when reported | Native text output | Native text output |
| Function tools and results | Forwarded | Model-dependent; function arguments translated | One function handoff per request; caller executes it |
| JSON object / schema | Provider-dependent | `format` mapping | Native output schema; JSON-object instruction |
| `temperature`, `top_p`, `seed`, `stop` | Forwarded | Native options | Rejected |
| `max_tokens` / `max_completion_tokens` | Forwarded (one only) | `num_predict` | Rejected: no enforceable equivalent |
| `reasoning_effort` | Forwarded | none/low/medium/high; requires supporting model | Validated against the discovered model catalog |
| `tool_choice` | Forwarded | auto/none only | auto/none/required/specified function |
| `parallel_tool_calls` | Forwarded | Rejected | false only |
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
| One application function per turn | Model-dependent | Unavailable | Supported |
| Function tool choice | `auto`, `none`, `required`, or a named function, subject to the upstream | Text only | `auto`, `none`, `required`, or a named function |
| Function `strict: true` | Forwarded | Text only | Rejected |

All three adapters accept a text prompt or caller-supplied message history. Responses always uses `store: false` and sends that flag to OpenAI-compatible Chat Completions upstreams. Send a completed `function_call` and a matching `function_call_output` with a string result when resuming a tool turn. The caller executes the function. Responses-only upstreams need a separate native adapter. Requests for stored responses, background execution, built-in tools, multimodal input, reasoning replay, and `max_output_tokens` are outside this release's request schema. See the [Responses API examples](api.md#responses).

The stream emits typed events and ends with `response.completed`, `response.incomplete` or `response.failed`. Known usage is included in the terminal response; otherwise it is `null`. Partial or invalid tool calls are withheld. The request body limit is 2 MiB, with up to 2048 input items within the shared message and output limits.

## Shared behavior

Compatible legacy model aliases are resolved to a fixed connection and native model for each request. The gateway submits the request to the selected adapter once. Codex may reconnect or fall back from WebSockets to HTTPS within a native turn. These attempts count toward the configured timeout. For explicit control over application retries, configure the OpenAI SDK with `maxRetries: 0` (JavaScript) or `max_retries=0` (Python).

A gateway `429 connection_busy` includes `Retry-After: 2` and is returned before provider submission. `429 upstream_rate_limited` carries the valid delay in seconds or GMT HTTP date when the HTTP upstream supplies it. `429 codex_rate_limited` can omit the header. See [error handling](api.md#errors-and-retries).

An explicit refusal completes normally even when structured output was requested. For other completed text outputs, Model Dock checks JSON syntax in both structured modes and the top-level object type in `json_object` mode. Schema constraints are handled by the upstream or native runtime. Assistant refusal history uses `refusal` and may use `content: null`. The OpenAI-compatible adapter forwards that history. Ollama and Codex can carry the refusal as assistant text.

Chat Completions SSE ends with a finish-reason chunk, an optional usage chunk with `choices: []` when requested and known, then `[DONE]`. The earlier chunks omit `usage`. A failure after streaming starts arrives as `data: {"error": ...}` and closes without `[DONE]`. Treat any Chat Completions stream without the sentinel as incomplete.

The chat request body limit is 2 MiB. Chat supports up to 8 MiB of output, 2048 messages and 128 function definitions. The image endpoint accepts up to 70 MiB of JSON, including a prompt of up to 4,000 characters and up to 50 MiB of decoded references. A single result may be up to 30 MiB before Base64 encoding. The gateway allows up to 32 active requests globally. Per-connection concurrency defaults to 2. Codex allows one active request across text, images and all Codex connections. The connection timeout is configurable from 5 to 1800 seconds.

Codex is experimental because history injection and dynamic tools use its experimental API. The initial implementation was checked against a locally installed `codex-cli 0.164.0`. Fixtures validate the JSON-RPC contract. Each new CLI version needs a real protocol smoke test. Available account entitlements can differ from the model catalog.

Codex context limits return `400 context_length_exceeded`, native bad requests return `400 codex_bad_request`, and native rate limits return `429 codex_rate_limited`. An empty or inconsistent completed text turn returns `codex_protocol_error`. The shared Codex slot stays occupied until the interrupted turn reaches a terminal event or the local process stops.

Image generation uses a separate native process and the signed-in Codex account's quota. Publish the image model from the local runtime before use. Model Dock returns one complete image with its actual size and format. OpenAI's `/v1/images/edits` route returns `404` on Model Dock. See the [image parameters and reference-edit example](api.md#images).

The OpenAI-compatible adapter can read optional `/models` metadata from `capabilities`, `reasoning_efforts`, `default_reasoning_effort`, `context_window`, `max_input_tokens`, and `max_output_tokens`. Missing capabilities and limits stay unknown. Ollama uses `/api/show` and filters out embedding-only entries. Displayed context limits are informational. Ollama's configured context determines memory allocation.

References: [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility), [Codex App Server](https://learn.chatgpt.com/docs/app-server).
