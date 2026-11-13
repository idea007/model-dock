# API reference · v0.1

All endpoints except the console assets and `/healthz` require `Authorization: Bearer <token>`. Management endpoints require the local administrator token. Requests with bodies require `Content-Type: application/json`. The server only listens on `127.0.0.1`; cross-origin browser requests and unrecognized Host values are rejected.

## Inference

`GET /v1/models` returns only enabled and available models/aliases permitted by the current key.

`POST /v1/chat/completions` accepts the subset in [compatibility.md](compatibility.md). The `model` field is required and is either an exact connection-qualified model ID or a feature alias. Client abort or connection close cancels the upstream. Every response includes `x-request-id`.

## Management

`GET /admin/state` returns the catalog, settings revision, safe connection projections, keys without hashes, active requests, recent metadata, version and Base URL. It never returns saved upstream credentials.

All configuration mutations require the latest integer `revision`. A stale revision returns `409 revision_conflict`; reload and resubmit the intended change. Successful mutations return `{ ok, state, ...result }`.

| Method | Path | Fields in addition to revision |
| --- | --- | --- |
| POST | `/admin/connections` | name, type=openai/ollama/codex, baseUrl?, apiKey?, enabled?, maxConcurrency?, timeoutSeconds? |
| PATCH | `/admin/connections/:id` | changed fields above; type cannot change |
| DELETE | `/admin/connections/:id` | none |
| POST | `/admin/connections/:id/discover` | none; checks metadata only, no generation |
| POST | `/admin/models` | connectionId, nativeId, name?; manual registration for API sources |
| PATCH | `/admin/models/:encodedId` | enabled |
| POST | `/admin/routes` | id, name?, modelId; creates or replaces an alias |
| DELETE | `/admin/routes/:id` | none |
| POST | `/admin/keys` | name, models: array of permitted IDs/aliases, or `["*"]` for all enabled models including future ones |
| DELETE | `/admin/keys/:id` | none; also cancels calls using this key |
| POST | `/admin/requests/:id/cancel` | empty object; no revision required |

Creation of a key additionally returns `token` once. Omitting `apiKey` on connection edits retains the original; sending an empty string removes it. Connection secrets cannot be read back. Discovery failures preserve the saved catalog and record a diagnostic code, rather than deleting choices. Discovery that races a configuration write returns a revision conflict instead of applying stale results.

`GET /healthz` returns process health and version only; it does not call models or prove upstream readiness.

## Error handling

Errors follow `{ "error": { "message", "type", "code", "param" } }`. Typical codes include `unauthorized`, `model_forbidden`, `model_unavailable`, `connection_busy`, `unsupported_parameter`, `upstream_auth_failed`, `upstream_protocol_error`, `request_timeout` and `revision_conflict`. A capacity rejection includes `Retry-After: 2` and means no provider generation started. Do not blindly replay requests after a transport failure; the upstream outcome can be unknown.
