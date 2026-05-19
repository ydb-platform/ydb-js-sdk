---
'@ydbjs/telemetry': patch
---

Tighten `@ydbjs/core` dependency to `^6.2.0` — the new `addClientMiddleware` API used to install the W3C trace context propagation middleware is only available there. Without this bump, installs that resolved `@ydbjs/core` to `6.1.x` would fail at runtime when `register()` tries to install the middleware.

Refresh OpenTelemetry dependencies to current versions:

- `@opentelemetry/api` `^1.9.0` → `^1.9.1`
- `@opentelemetry/instrumentation` `^0.57.0` → `^0.218.0`
- `@opentelemetry/semantic-conventions` `^1.32.0` → `^1.41.1`
- dev deps (`@opentelemetry/core`, `@opentelemetry/context-async-hooks`, `@opentelemetry/sdk-metrics`, `@opentelemetry/sdk-trace-{base,node}`) aligned at `^2.7.1`
