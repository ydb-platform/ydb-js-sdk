# FSM Runtime Example

This example demonstrates how to use `@ydbjs/fsm` as a lightweight async-first machine runtime.

## What this example shows

- Creating a machine with `initialState` and mutable `context`
- Handling events with `transition(...)`
- Running typed side effects via `effects`
- Consuming machine outputs using `for await ... of runtime`
- Feeding external async sources with `runtime.ingest(...)`
- Stopping and disposing runtime safely

## Prerequisites

- Node.js `>= 20.19.0`
- npm `>= 10`

## Running the example

```bash
cd examples/fsm
npm install
npm start
```

## Notes

- Runtime itself is `AsyncIterable`, so outputs are consumed directly from the runtime instance.
- `ingest(...)` is intended for long-lived async sources (streams, timers, channels).
- After `runtime.close()` or `runtime.destroy()` the machine is terminal and `ingest(...)` will throw.

## Related docs

- [@ydbjs/fsm package](../../packages/fsm)
- [@ydbjs/fsm design](../../packages/fsm/DESIGN.md)
