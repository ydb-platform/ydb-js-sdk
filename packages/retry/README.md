# @ydbjs/retry

[![codecov](https://codecov.io/gh/ydb-platform/ydb-js-sdk/graph/badge.svg?component=retry)](https://ydb-appteam-sdk-reports.website.yandexcloud.net/ydb-js-sdk/coverage/packages/retry/)

The `@ydbjs/retry` package provides utilities for implementing retry logic in your applications. It is designed to work seamlessly with YDB services, allowing you to handle transient errors and ensure reliable operations.

## Features

- Configurable retry policies
- Support for custom retry strategies
- Budget management for retry attempts
- Predicate functions to determine retryability
- TypeScript support with type definitions
- Lightweight and easy to integrate

## Installation

Supported Node.js versions: `^22.23.5 || ^24.22.3 || >=26.13.1`.

```sh
npm install @ydbjs/retry
```

## Usage

`retry(config, callback)` invokes the callback with an attempt-specific `AbortSignal`.
The default predicate recognizes retryable YDB and gRPC errors; it does not retry arbitrary `Error` objects or failed HTTP responses.
For another service, supply a predicate matching that service's retryable failures:

```ts
import { retry } from '@ydbjs/retry'

class RetryableHttpError extends Error {}

async function fetchData(signal: AbortSignal) {
  return retry(
    {
      signal,
      budget: 3,
      strategy: 200,
      retry: (error) => {
        return error instanceof RetryableHttpError
      },
    },
    async (attemptSignal) => {
      let response = await fetch('https://example.com/api', { signal: attemptSignal })

      if (response.status === 429 || response.status === 503) {
        await response.body?.cancel()
        throw new RetryableHttpError(`HTTP ${response.status}`)
      }

      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`HTTP ${response.status}`)
      }

      return response.json()
    }
  )
}

let data = await fetchData(AbortSignal.timeout(5000))

console.log(data)
```

The example retries only HTTP 429 and 503 for a GET request; other HTTP failures and network errors remain terminal under its predicate.
A callback can execute more than once. Its external effects must tolerate every retry allowed by the configured policy.

### Configuration

```ts
import { type RetryConfig, isRetryableError } from '@ydbjs/retry'

let options: RetryConfig = {
  retry: isRetryableError,
  budget: 3,
  strategy: 200,
  idempotent: true,
  signal: AbortSignal.timeout(5000),
  onRetry(ctx) {
    console.log('Completed attempts:', ctx.attempt, 'Last error:', ctx.error)
  },
}
```

| Option       | Meaning                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retry`      | Boolean or `(error, idempotent) => boolean`; defaults to `isRetryableError`.                                                                                                           |
| `budget`     | Total allowed attempts, including the first, or a function `(ctx, config) => number`; defaults to `Infinity`.                                                                          |
| `strategy`   | Number of milliseconds or a function `(ctx, config) => number`; defaults to YDB-specific exponential backoff. The elapsed duration of the failed attempt is subtracted before waiting. |
| `idempotent` | Passed to the retry predicate; defaults to `false`. It does not by itself disable retries.                                                                                             |
| `onRetry`    | Runs before a subsequent attempt, after its backoff; receives the count of completed failed attempts and the last error.                                                               |
| `signal`     | Cancels the entire retry loop, including backoff and waiting for a running callback.                                                                                                   |

`RetryConfig` and `RetryContext` are exported from `@ydbjs/retry`; `RetryBudget` is exported from `@ydbjs/retry/budget`, and `RetryStrategy` from `@ydbjs/retry/strategy`.
Strategy helpers are available through the root `strategies` namespace or the `/strategy` subpath.

The default policy does not retry `ProtocolError`, including `MessageSizeError`, because replay does not repair an invalid message or its size limit.
Server gRPC `ABORTED` and `RESOURCE_EXHAUSTED` statuses remain retryable.
gRPC `INTERNAL`, `UNAVAILABLE`, and HTTP/2 overload resets require `idempotent: true`: these failures do not establish whether the server applied the request.
`TransactionCompletionError` is terminal because the transaction already committed.

Aborting `signal` always stops the retry loop without consulting the retry predicate, even when its reason looks retryable.
The rejection preserves `signal.reason`, including cancellation during backoff.
Errors named `AbortError` or `TimeoutError` also stop retries.
The callback must pass its signal to asynchronous work to stop that work; cancellation of the retry loop alone cannot stop arbitrary application promises.
The attempt signal is aborted when that attempt finishes, so do not retain it for work outside the callback.

## Custom strategies and budgets

### Retry strategy

```ts
import type { RetryStrategy } from '@ydbjs/retry/strategy'

let customStrategy: RetryStrategy = (ctx) => {
  return Math.min(1000 * 2 ** ctx.attempt, 10_000)
}
```

Pass it as `strategy` in the configuration.
The first strategy call follows the first failed attempt, so `ctx.attempt` is `1`.

### Dynamic budget

```ts
import type { RetryBudget } from '@ydbjs/retry/budget'

let dynamicBudget: RetryBudget = (ctx) => {
  if (ctx.error instanceof Error && ctx.error.message.includes('network')) {
    return 10
  }

  return 3
}
```

Pass it as `budget` in the configuration alongside a retry predicate appropriate for those errors.
A larger budget does not make a non-retryable error retryable.

### Combining strategies

```ts
import { strategies } from '@ydbjs/retry'

let strategy = strategies.combine(strategies.exponential(500), strategies.jitter(100))
```

`combine()` adds the strategy delays; `compose()` selects their maximum.

### Using the callback signal

```ts
import { Driver } from '@ydbjs/core'
import { retry } from '@ydbjs/retry'

using driver = new Driver('grpc://localhost:2136/local')

await retry({ budget: 3, signal: AbortSignal.timeout(5000) }, async (signal) => {
  await driver.ready(signal)
})
```

## Observability via `node:diagnostics_channel`

`@ydbjs/retry` publishes events to [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) so external subscribers (`@ydbjs/telemetry`, OpenTelemetry, custom loggers) can build traces and metrics for retry behaviour without the caller knowing anything about them.

Every code path that uses `retry()` — driver discovery, query execution, transactions, auth token refresh — inherits these channels automatically.

### Channels

| Channel                       | Type    | Payload                                                                                                                                                                                                                                  |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracing:ydb:retry.run`       | tracing | `{ idempotent: boolean, outcome?: RetryOutcome }` — whole retry loop. `outcome` is set on the ctx before resolve / throw.                                                                                                                |
| `tracing:ydb:retry.attempt`   | tracing | `{ attempt: number, idempotent: boolean, backoffMs: number }` — a single attempt (including the first); `backoffMs` is the scheduled wait before this attempt, after subtracting the previous attempt duration (`0` for `attempt === 1`) |
| `ydb:retry.attempt.completed` | publish | `{ attempt: number, idempotent: boolean, outcome: RetryOutcome }` — emitted once per attempt with its outcome                                                                                                                            |
| `ydb:retry.exhausted`         | publish | `{ attempts: number, totalDuration: number, lastError: unknown }` — ms. See below.                                                                                                                                                       |

```ts
type RetryOutcome = 'success' | 'retried' | 'non_retryable' | 'exhausted'
```

`retry.attempt` is published once per attempt starting from `attempt: 1`. Because `tracingChannel.tracePromise` wraps every attempt, the `error` event of `tracingChannel('tracing:ydb:retry.attempt')` fires for **every** failed attempt — both the ones that will be retried and the final one that exits the loop. The final attempt's failure additionally surfaces on the run tracing channel's `error` event.

`ydb:retry.attempt.completed` is the metrics-friendly companion: it fires exactly once per attempt regardless of success or failure, with an `outcome` tag suited for a `Counter`. Use it instead of subscribing to both `attempt.asyncEnd` and `attempt.error` when all you want is a count.

`ydb:retry.exhausted` fires when the retry policy itself gives up — either the budget ran out or the predicate returned `false`. It does **not** fire when the caller's signal aborts or an attempt throws `AbortError` or `TimeoutError`: these terminate the loop immediately. Subscribers tracking "retry budget exhausted" should not expect this event for cancellations or timeouts; use the run tracing channel's `error` event for the broader "retry loop failed" signal.

### Subscribing

Install subscribers before starting operations. Track timing separately from the publisher's context and record a completed run once, in `asyncEnd`:

```ts
import { channel, tracingChannel } from 'node:diagnostics_channel'
import type { RetryOutcome } from '@ydbjs/retry'

type RunContext = { idempotent: boolean; outcome?: RetryOutcome }

let started = new WeakMap<RunContext, number>()

tracingChannel<RunContext>('tracing:ydb:retry.run').subscribe({
  start(ctx) {
    started.set(ctx, performance.now())
  },
  asyncEnd(ctx) {
    let start = started.get(ctx)

    if (start === undefined) {
      return
    }

    started.delete(ctx)
    console.log('Retry run:', {
      durationMs: performance.now() - start,
      outcome: ctx.outcome,
    })
  },
})

channel('ydb:retry.exhausted').subscribe((message) => {
  let event = message as { attempts: number; totalDuration: number }

  console.log('Retry stopped:', event.attempts, event.totalDuration)
})
```

`error` and `asyncEnd` can both fire for a failed run. Do not record the same completed operation in both callbacks.

### Subscriber errors

`node:diagnostics_channel` invokes subscribers synchronously. An exception thrown by a subscriber triggers an `uncaughtException` and can terminate the process. The SDK does not wrap subscribers; handle failures inside callbacks that call your telemetry code:

```ts
import { tracingChannel } from 'node:diagnostics_channel'

function observeAttempts(record: (attempt: number) => void) {
  let attempts = tracingChannel<{ attempt: number }>('tracing:ydb:retry.attempt')
  let subscribers = {
    start(ctx: { attempt: number }) {
      try {
        record(ctx.attempt)
      } catch (error) {
        console.error('Telemetry subscriber failed:', error)
      }
    },
  }

  attempts.subscribe(subscribers)

  return () => {
    attempts.unsubscribe(subscribers)
  }
}
```

### Stability

Channel names and payload field names follow semantic versioning. Adding new optional fields is a minor change; renaming or removing fields is a major change. Treat the channel surface as a public API.

## Development

To build the package:

```bash
npm run build
```

To run tests:

```bash
npm test
```

## License

This project is licensed under the [Apache 2.0 License](../../LICENSE).

## Links

- [YDB Documentation](https://ydb.tech)
- [GitHub Repository](https://github.com/ydb-platform/ydb-js-sdk)
- [Issues](https://github.com/ydb-platform/ydb-js-sdk/issues)
