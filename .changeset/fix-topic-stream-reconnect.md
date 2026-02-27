---
"@ydbjs/retry": minor
"@ydbjs/topic": patch
---

Fix topic reader/writer disconnecting after Discovery.listEndpoints

When the driver refreshed its endpoint pool on a periodic discovery round,
it closed and recreated gRPC channels for all known nodes. This caused active
bidirectional streams (topic reader / writer) to receive a `CANCELLED` gRPC
status, which was not treated as a retryable error — so the streams terminated
instead of reconnecting.

Changes:

- **`@ydbjs/retry`**: added `isRetryableStreamError` and `defaultStreamRetryConfig`.
  Long-lived streaming RPCs should reconnect on `CANCELLED` and `UNAVAILABLE`
  in addition to the errors already handled by `isRetryableError`, because for
  streams those codes indicate a transport interruption rather than a semantic
  cancellation.

- **`@ydbjs/topic`**: reader (`_consume_stream`) and both writers (`writer`,
  `writer2`) now use `isRetryableStreamError` / `defaultStreamRetryConfig` so
  they transparently reconnect after a discovery-triggered channel replacement.
  Fixed a zombie-reader bug where `read()` would block forever if the retry
  budget was exhausted: the reader is now destroyed on unrecoverable stream
  errors so pending `read()` calls are unblocked immediately.
