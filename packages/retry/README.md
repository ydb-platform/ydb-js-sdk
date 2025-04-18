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
import { retry, defaultRetryConfig } from '@ydbjs/retry';

async function fetchData() {
    return await retry(defaultRetryConfig, async () => {
        // Your operation that might fail
        const response = await fetch('https://example.com/api');
        if (!response.ok) {
            throw new Error('Failed to fetch data');
        }
        return response.json();
    });
}

fetchData().then(data => {
    console.log('Data fetched successfully:', data);
}).catch(error => {
    console.error('Failed to fetch data:', error);
});
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
import { retry } from '@ydbjs/retry';

const customStrategy = (ctx, cfg) => {
    // Exponential backoff with a cap
    return Math.min(1000 * 2 ** ctx.attempt, 10000);
};

await retry({
    strategy: customStrategy,
    budget: 5,
    retry: (error) => error instanceof Error,
}, async () => {
    // Your operation
});
```

### Dynamic Retry Budget

Budgets can be dynamic, based on error type or context:

```ts
const dynamicBudget = (ctx, cfg) => {
    // Allow more attempts for network errors
    if (ctx.error && ctx.error.message.includes('network')) {
        return 10;
    }
    return 3;
};

await retry({
    budget: dynamicBudget,
    // ...other config
}, async () => { /* ... */ });
```

### onRetry Hook

You can use the `onRetry` hook to log or perform side effects on each retry:

```ts
await retry({
    onRetry: (ctx) => {
        console.log(`Retry attempt #${ctx.attempt} after error:`, ctx.error);
    },
    // ...other config
}, async () => { /* ... */ });
```

### Combining Strategies

You can compose multiple strategies for more advanced control:

```ts
import { strategies, retry } from '@ydbjs/retry';

const combined = strategies.compose(
    strategies.exponential(500),
    strategies.jitter(100)
);

await retry({
    strategy: combined,
    budget: 5,
}, async () => { /* ... */ });
```

### Using AbortSignal in Retry Callback

You can use the `AbortSignal` provided to the retried function to support cancellation with custom clients (for example, a YDB driver from the core package):

```ts
import { retry } from '@ydbjs/retry';
import { Driver } from '@ydbjs/core';

const driver = new Driver('grpc://localhost:2135?database=/local');

await retry({
    budget: 5,
}, async (signal) => {
    // Pass the signal to a method that supports AbortSignal, e.g., driver.ready
    await driver.ready(signal);
    // Or, if using a generated client:
    // const client = driver.createClient(SomeServiceDefinition);
    // return await client.someMethod(request, { signal });
});
```

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
