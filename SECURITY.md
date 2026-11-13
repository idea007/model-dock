# Security scope

Model Dock v0.1 is a single-operator, loopback-only local application. It is not a multi-tenant hosted gateway. Do not expose it with an unauthenticated tunnel or reverse proxy and assume its local trust model still holds.

- Administrator tokens can read and change all local gateway settings. Use scoped project tokens for applications.
- Provider addresses are configured by the trusted administrator, never by inference callers. HTTPS is required except for loopback addresses. Redirects are rejected.
- Browser Host/Origin restrictions, a restrictive CSP and bearer authentication protect local management endpoints from other websites. The console stores its administrator token only in the current tab's session storage, and removes login URL fragments immediately.
- Saved upstream credentials are encrypted. The master key and administrator token are private local files; the current OS account remains trusted. POSIX permissions do not replace Windows ACLs, full-disk encryption or a protected user session.
- Codex receives a temporary working directory, a restricted environment, read-only sandbox and disabled host tools. Inherited MCP definitions are disabled. Function execution belongs to the calling application.
- Cancellation is best-effort at the upstream boundary. An upstream may already have performed work or charged usage before an interrupted connection. The gateway does not automatically replay uncertain requests.
- Logs keep metadata only. Provider error bodies and Codex stderr are not returned to callers.

If you find a vulnerability, do not post live secrets or a working exploit against another person's deployment. Use the repository's private security advisory channel when enabled. The publishing owner should configure that channel before promoting public use.
