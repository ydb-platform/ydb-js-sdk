# @ydbjs/retry

The `@ydbjs/retry` package provides utilities for implementing retry logic in your applications. It is designed to work seamlessly with YDB services, allowing you to handle transient errors and ensure reliable operations.

## Features

- Configurable retry policies
- Support for custom retry strategies
- Budget management for retry attempts
- Predicate functions to determine retryability
- TypeScript support with type definitions
- Lightweight and easy to integrate

## Installation

To install the package, use your preferred package manager:

```bash
npm install @ydbjs/retry@6.0.0-alpha.2
```

## Usage

### Basic Example

Here is an example of how to use the `@ydbjs/retry` package to implement retry logic:

```ts
import { retry, defaultRetryConfig } from '@ydbjs/retry'

async function fetchData() {
  return await retry(defaultRetryConfig, async () => {
    // Your operation that might fail
    const response = await fetch('https://example.com/api')
    if (!response.ok) {
      throw new Error('Failed to fetch data')
    }
    return response.json()
  })
}

fetchData()
  .then((data) => {
    console.log('Data fetched successfully:', data)
  })
  .catch((error) => {
    console.error('Failed to fetch data:', error)
  })
```

### Configuration Options

The `retry` function accepts the following configuration options:

```ts
import type { RetryConfig } from '@ydbjs/retry';

const options: RetryConfig = {
    /** Predicate to determine if an error is retryable */
    retry?: boolean | ((error: RetryContext['error'], idempotent: boolean) => boolean),
    /** Budget for retry attempts */
    budget?: number | RetryBudget,
    /** Strategy to calculate delay */
    strategy?: number | RetryStrategy,
    /** Idempotent operation */
    idempotent?: boolean,
    /** Hook to be called before retrying */
    onRetry?: (ctx: RetryContext) => void,
    /** Optional AbortSignal (from Abortable) */
    signal?: AbortSignal,
};
```

- `retry` (boolean | (error, idempotent) => boolean): Predicate to determine if an error is retryable. Receives both the error and the idempotent flag.
- `budget` (number | RetryBudget): The budget for retry attempts. Can be a fixed number or a custom function.
- `strategy` (number | RetryStrategy): Strategy to calculate delay between retries. Can be a fixed number or a custom function.
- `idempotent` (boolean): Indicates if the operation is idempotent.
- `onRetry` ((ctx) => void): Hook called before each retry attempt.
- `signal` (AbortSignal): Optional signal to support cancellation.

## Advanced Usage

### Custom Retry Strategy

You can define your own retry strategy to control the delay between attempts:

```ts
import { retry } from '@ydbjs/retry'

const customStrategy = (ctx, cfg) => {
  // Exponential backoff with a cap
  return Math.min(1000 * 2 ** ctx.attempt, 10000)
}

await retry(
  {
    strategy: customStrategy,
    budget: 5,
    retry: (error) => error instanceof Error,
  },
  async () => {
    // Your operation
  }
)
```

### Dynamic Retry Budget

Budgets can be dynamic, based on error type or context:

```ts
const dynamicBudget = (ctx, cfg) => {
  // Allow more attempts for network errors
  if (ctx.error && ctx.error.message.includes('network')) {
    return 10
  }
  return 3
}

await retry(
  {
    budget: dynamicBudget,
    // ...other config
  },
  async () => {
    /* ... */
  }
)
```

### onRetry Hook

You can use the `onRetry` hook to log or perform side effects on each retry:

```ts
await retry(
  {
    onRetry: (ctx) => {
      console.log(`Retry attempt #${ctx.attempt} after error:`, ctx.error)
    },
    // ...other config
  },
  async () => {
    /* ... */
  }
)
```

### Combining Strategies

You can compose multiple strategies for more advanced control:

```ts
import { strategies, retry } from '@ydbjs/retry'

const combined = strategies.compose(strategies.exponential(500), strategies.jitter(100))

await retry(
  {
    strategy: combined,
    budget: 5,
  },
  async () => {
    /* ... */
  }
)
```

### Using AbortSignal in Retry Callback

You can use the `AbortSignal` provided to the retried function to support cancellation with custom clients (for example, a YDB driver from the core package):

```ts
import { retry } from '@ydbjs/retry'
import { Driver } from '@ydbjs/core'

const driver = new Driver('grpc://localhost:2135?database=/local')

await retry(
  {
    budget: 5,
  },
  async (signal) => {
    // Pass the signal to a method that supports AbortSignal, e.g., driver.ready
    await driver.ready(signal)
    // Or, if using a generated client:
    // const client = driver.createClient(SomeServiceDefinition);
    // return await client.someMethod(request, { signal });
  }
)
```

## Observability via `node:diagnostics_channel`

`@ydbjs/retry` publishes events to [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) so external subscribers (`@ydbjs/telemetry`, OpenTelemetry, custom loggers) can build traces and metrics for retry behaviour without the caller knowing anything about them.

Every code path that uses `retry()` — driver discovery, query execution, transactions, auth token refresh — inherits these channels automatically.

### Channels

| Channel                     | Type    | Payload                                                                             |
| --------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `tracing:ydb:retry.run`     | tracing | `{ idempotent: boolean }` — whole retry loop                                        |
| `tracing:ydb:retry.attempt` | tracing | `{ attempt: number, idempotent: boolean }` — a single attempt (including the first) |
| `ydb:retry.exhausted`       | publish | `{ attempts: number, totalDuration: number, lastError: unknown }` — see below       |

`retry.attempt` is published once per attempt starting from `attempt: 1`. The corresponding `error` sub-channel of `tracing:ydb:retry.attempt` fires for failed attempts that will be retried; the final attempt's failure is also visible on `tracing:ydb:retry.run`'s `error` sub-channel.

`ydb:retry.exhausted` fires when the retry policy itself gives up — either the budget ran out or the predicate returned `false`. It does **not** fire when the loop exits via `AbortError` or `TimeoutError`: those are rethrown immediately as caller-driven cancellations. Subscribers tracking "retry budget exhausted" should not expect this event for cancellations or timeouts; use `tracing:ydb:retry.run.error` for the broader "retry loop failed" signal.

### Subscribing

```ts
import { channel, tracingChannel } from 'node:diagnostics_channel'

tracingChannel('tracing:ydb:retry.run').subscribe({
  start(ctx) {
    // ctx.idempotent
  },
  asyncEnd() {
    /* success */
  },
  error(ctx) {
    /* ctx.error is the final failure */
  },
})

channel('ydb:retry.exhausted').subscribe((msg) => {
  alert.budgetExhausted.add(1, { attempts: msg.attempts })
})
```

### ⚠️ Subscribers must be safe

**`node:diagnostics_channel` invokes subscribers synchronously.** Any exception thrown inside a subscriber propagates up the call stack and **will** disrupt the SDK — a buggy retry subscriber can break the very operation it observes. `@ydbjs/retry` does **not** wrap subscribers; wrap them yourself:

```ts
tracingChannel('tracing:ydb:retry.attempt').subscribe({
  start(ctx) {
    try {
      span.startChild({ name: 'retry.attempt', attributes: { attempt: ctx.attempt } })
    } catch (err) {
      console.error('telemetry subscriber failed', err)
    }
  },
})
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
