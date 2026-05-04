---
'@ydbjs/auth': minor
---

Publish credentials-provider events on `node:diagnostics_channel`.

New channels:

- `tracing:ydb:auth.token.fetch` — span around the full token fetch, including retries. Context: `{ provider }`.
- `ydb:auth.token.refreshed` — `{ provider, expiresAt }` (unix ms). Single, monotonic timestamp instead of per-provider `expiresIn` semantics.
- `ydb:auth.token.expired` — `{ provider, stalenessMs }`. Fires once per expiration incident, not per call.
- `ydb:auth.provider.failed` — `{ provider, error }`. Fires after all retries are exhausted.

`provider` is an open string set. Built-in values: `'static'`, `'metadata'`, plus values contributed by external providers (e.g. `'yc-service-account'` from `@ydbjs/auth-yandex-cloud`). Custom `CredentialsProvider` implementations should mint a stable, namespaced provider id.

Channel names and payload fields are part of the public API. See `packages/auth/README.md` for the full contract and a warning about safe subscribers.
