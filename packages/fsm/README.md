# @ydbjs/fsm

`@ydbjs/fsm` is a lightweight async-first finite state machine runtime for YDB JavaScript SDK packages.

It is designed for long-lived async workflows where predictable state transitions, explicit side effects, and safe shutdown semantics are required.

## Features

- Single-writer event processing (race-resistant transition flow)
- Explicit transition contract with typed effects
- Runtime outputs as `AsyncIterable` (`for await ... of runtime`)
- Async source ingestion via `runtime.ingest(...)`
- Native `AbortSignal` integration
- `AsyncDisposable` support for runtime and ingest handles
- Minimal runtime surface (`dispatch`, `ingest`, `close`, `destroy`)

## Installation

```sh
npm install @ydbjs/fsm
```

Requires Node.js `>= 20.19.0`.

## Quick Start

```ts
import { createMachineRuntime } from '@ydbjs/fsm'

type State = 'idle' | 'running' | 'done'
type Event =
  | { type: 'counter.start' }
  | { type: 'counter.increment'; step?: number }
  | { type: 'counter.finish' }

type Effect = { type: 'counter.log'; message: string }
type Output = { type: 'counter.state'; value: State } | { type: 'counter.value'; value: number }

type Context = { count: number }

let runtime = createMachineRuntime<State, Context, Event, Effect, Output>({
  initialState: 'idle',
  context: { count: 0 },
  transition(context, state, event, runtime) {
    switch (event.type) {
      case 'counter.start':
        runtime.emit({ type: 'counter.state', value: 'running' })
        return { state: 'running', effects: [{ type: 'counter.log', message: 'started' }] }

      case 'counter.increment':
        if (state !== 'running') return
        context.count += event.step ?? 1
        runtime.emit({ type: 'counter.value', value: context.count })
        return { effects: [{ type: 'counter.log', message: `count=${context.count}` }] }

      case 'counter.finish':
        runtime.emit({ type: 'counter.state', value: 'done' })
        return { state: 'done', effects: [{ type: 'counter.log', message: 'finished' }] }
    }
  },
  effects: {
    'counter.log'(effect) {
      console.log('[effect]', effect.message)
    },
  },
})

void (async () => {
  for await (let out of runtime) {
    console.log(out)
  }
})()

runtime.dispatch({ type: 'counter.start' })
runtime.dispatch({ type: 'counter.increment' })
runtime.dispatch({ type: 'counter.finish' })

await runtime.close('done')
await runtime.destroy('finalized')
```

## Core Concepts

### Transition

`transition(context, state, event, runtime)` is called for every event in queue order.

It can:

- return next `state`
- return `effects` to execute
- emit output events via `runtime.emit(...)`

### Effects

`effects` is a typed map keyed by `effect.type`.
Each effect handler receives `(effect, context, state, runtime)`.

This map-based approach keeps handlers exhaustive and explicit.

### Runtime Output

Runtime itself is `AsyncIterable<Output>`:

```ts
for await (let out of runtime) {
  // ...
}
```

## Lifecycle: `close` vs `destroy`

`@ydbjs/fsm` intentionally provides two shutdown modes.

| Method             | Semantics                                                                                         | Typical Use                   |
| ------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------- |
| `close(reason?)`   | Graceful shutdown: stop accepting new work, drain queued events/effects, then close output stream | Normal completion             |
| `destroy(reason?)` | Hard shutdown: abort signal, drop queued events immediately, close output stream                  | Fatal error / forced teardown |

### Recommended pattern

Use graceful-first teardown for async disposal:

```ts
await runtime.close('graceful shutdown')
await runtime.destroy('finalized')
```

`[Symbol.asyncDispose]` follows this same intent.

## Ingesting Async Sources

Use `runtime.ingest(source, map, signal?)` to route external async streams into machine events.

```ts
await using ingest = runtime.ingest(stream, (input) => {
  if (input.type === 'message') {
    return { type: 'reader.message', payload: input.payload }
  }
  return null
})
```

Notes:

- `map` can filter by returning `null`
- `ingest` is rejected after runtime is closing/closed/destroyed
- ingest handle is `AsyncDisposable`

## API Summary

- `createMachineRuntime(options)`
- `runtime.dispatch(event)`
- `runtime.ingest(source, map, signal?)`
- `runtime.close(reason?)`
- `runtime.destroy(reason?)`
- `runtime[Symbol.asyncIterator]()`
- `runtime[Symbol.asyncDispose]()`

## Design Notes

This package is runtime infrastructure, not a domain framework.
Domain-specific states/events/effects must stay in each package (`coordination`, `topic`, `query`, etc).

For full design rationale, see [DESIGN.md](./DESIGN.md).

## Examples

- Runnable example package: [`../../examples/fsm`](../../examples/fsm)
- Example documentation: [`../../examples/fsm/README.md`](../../examples/fsm/README.md)

## Development

```sh
npm run build
npm run test
```

## License

Apache-2.0
