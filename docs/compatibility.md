# Compatibility contract · v0.1

This release implements a text-only subset of OpenAI Chat Completions. It does not claim complete OpenAI API compatibility. Requests use one model and one choice. Unknown fields, unsupported message modalities and invalid tool histories fail before inference.

| Feature | OpenAI-compatible provider | Ollama native API | Codex App Server |
| --- | --- | --- | --- |
| JSON response / SSE | Yes | Yes | Yes |
| Text messages and role history | Forwarded | Native roles; developer mapped to system | Native history injection, not a flattened transcript |
| Function tools and results | Forwarded | Model-dependent; function arguments translated | One function handoff per request; caller executes it |
| JSON object / schema | Provider-dependent | `format` mapping | Native output schema; JSON-object instruction |
| `temperature`, `top_p`, `seed`, `stop` | Forwarded | Native options | Rejected |
| `max_tokens` / `max_completion_tokens` | Forwarded (one only) | `num_predict` | Rejected: no enforceable equivalent |
| `reasoning_effort` | Forwarded | none/low/medium/high; requires supporting model | Validated against the discovered model catalog |
| `tool_choice` | Forwarded | auto/none only | auto/none/required/specified function |
| `parallel_tool_calls` | Forwarded | Rejected | false only |
| Tool schema `strict:true` | Forwarded | Rejected | Rejected |
| Output schema `strict:true` | Forwarded | Rejected | Passed to the native output-schema path |
| `user` | Forwarded | Rejected | Rejected |
| Usage | Reported by provider | eval counters | Complete native cumulative counters only |
| Images/audio/video/embeddings | Not exposed | Not exposed | Not exposed |
| Responses API / persistent conversations | Not exposed | Not exposed | Not exposed |

Model aliases are resolved to a fixed connection and native model for each request. Errors never trigger an automatic retry, model fallback or credential switch in the gateway. Codex itself may reconnect or fall back from WebSockets to HTTPS within a native turn; these native attempts still count toward the configured timeout. A caller may choose its own retry policy; SDKs often enable retries by default. For explicit control, configure the OpenAI SDK with `maxRetries: 0` (JavaScript) or `max_retries=0` (Python).

Once SSE has begun, a failure is emitted as `data: {"error": ...}` and the stream closes **without** `[DONE]`. Consumers must not interpret partial text or a dropped connection as success. Normal completion ends with a finish-reason chunk, optional usage chunk (when requested and known), and `[DONE]`.

Limits: 2 MiB request body, 8 MiB generated data, 2048 messages, 128 function definitions, at most 32 active requests globally. Per-connection concurrency defaults to 2; Codex is limited to one active request across Codex connections. Timeout is configurable from 5 to 1800 seconds. Quota/cost controls are not implemented.

Codex is experimental because history injection and dynamic tools use its experimental API. The initial implementation was checked against a locally installed `codex-cli 0.164.0`. Fixtures validate the JSON-RPC contract, but each new CLI version still needs a real protocol smoke test. Listing models does not prove account entitlements. Native errors are mapped to fixed error codes; stderr, host paths and account details are not forwarded.

The provider catalog does not infer capabilities from names. OpenAI `/models` often does not supply capability metadata, so entries are explicitly unknown. Ollama uses `/api/show`; embedding-only entries are excluded from this text release. Displayed context metadata is not a tokenizer guarantee and is not used to maximize memory allocation.

References: [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility), [Codex App Server](https://learn.chatgpt.com/docs/app-server).
