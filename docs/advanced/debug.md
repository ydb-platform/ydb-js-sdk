---
title: Debug Logging
---

# Debug Logging

The SDK uses a structured debug logger exposed by `@ydbjs/debug`. You can enable granular logs via the standard `DEBUG` environment variable.

## Packages and namespaces

- `ydbjs:driver:*` — driver internals (connections, discovery, middleware)
- `ydbjs:query:*` — Query client (SQL text, retries, stats)
- `ydbjs:topic:*` — Topic reader/writer (streaming, commits, acks)
- `ydbjs:retry:*` — retry helper decisions
- `ydbjs:error:*` — error classification and wrapping

## Enable logs

```bash
# enable all logs
DEBUG=ydbjs:* node app.js

# only topic logs
DEBUG=ydbjs:topic:* node app.js

# specific component (topic writer)
DEBUG=ydbjs:topic:writer node app.js
```

In Docker/Kubernetes, set `DEBUG` in the container env. In NestJS/Next.js, export `DEBUG` before starting the dev server.

## Using the logger in your code

```ts
import { loggers } from '@ydbjs/debug'

const dbg = loggers.topic.extend('writer')

dbg.log('creating writer with producer: %s', producerId)
```

You can also create your own named logger tree and reuse it across modules.

## Example output

```
ydbjs:topic:writer creating writer with producer: my-producer +0ms
ydbjs:topic:writer connecting to topic service +2ms
ydbjs:topic:writer connected successfully +45ms
```

Tip: combine with application-level correlation IDs in log messages to trace flows across services.

