---
'@ydbjs/auth-yandex-cloud': minor
---

Participate in the `node:diagnostics_channel` surface defined by `@ydbjs/auth`.

`ServiceAccountCredentialsProvider` now publishes:

- `tracing:ydb:auth.token.fetch` — span around `getToken()` with `provider: 'yc-service-account'`.
- `ydb:auth.token.refreshed` — `{ provider, expiresAt }` after a successful IAM token exchange.
- `ydb:auth.token.expired` — `{ provider, stalenessMs }`, once per incident.
- `ydb:auth.provider.failed` — `{ provider, error }` when all retries are exhausted.

Retry attempts inside the IAM exchange are visible on `tracing:ydb:retry.*` from `@ydbjs/retry`. See `@ydbjs/auth` README for the full channel contract and the warning about safe subscribers.
