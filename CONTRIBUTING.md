# Contributing

Use Node.js 22.12+ (24 LTS recommended), then run `npm ci` and `npm run verify`. `npm run pack:check` tests the actual packaged artifact in a temporary installation.

Documentation defaults to English. Keep `README.md` and `README.zh-CN.md` in sync, and preserve the language switch links at the top of both versions.

Keep protocol validation browser-independent and core free of HTTP/UI dependencies. Providers must declare only supported behavior and reject unsupported options. Never introduce automatic provider/credential fallback or infer model permissions from discovery.

Tests should use local fixtures. Do not add real API credentials, account exports, model weights, local data directories or production traces. A meaningful provider change needs a contract test for errors/cancellation as well as its successful response. A real-model smoke test is separate and must state which account/runtime it used and whether it generated billable work, without exposing credentials.

Changes to persistent schema require a version and an explicit migration design. Do not reset corrupted state or silently replace encryption keys. The version in `package.json`, workspace package manifests and `packages/protocol/index.mjs` should remain consistent.

Before opening a PR, describe the user-visible behavior, compatibility changes and verification performed. UI visual inspection is separate from DOM or HTTP tests.
