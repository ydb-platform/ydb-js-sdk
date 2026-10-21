# @ydbjs/grpc

A gRPC client and server over `node:http2`, with Promise unary calls and AsyncIterable streams. Runs on Node.js `^22.15.0 || >=23.8.0` or Bun `>=1.4.0`. Cancellation waits use `@ydbjs/abortable`.

## Calling a service directly

For direct gRPC access, create a `Client` for the server authority and pass it to `createServiceClient(serviceDefinition, transport)`. The service definition supplies each method's path, streaming flags, request serializer, and response deserializer. The method name `close` is reserved for transport cleanup; a definition containing it is rejected. The transport itself has no database or credentials configuration and does not depend on protobuf or YDB.

`Client` connects lazily to one authority. `connect(signal?)` explicitly waits for a connection. `close()` or disposal cancels outstanding calls and closes its sessions; closing a service client also closes its transport. Share a Client only between services with the same lifetime.

## Streaming and cancellation

Unary and client-streaming methods return `Promise<Response>`. Server-streaming and bidirectional methods return `AsyncIterable<Response>` and begin when iteration starts. Streaming requests take an `AsyncIterable<Request>` and respect HTTP/2 backpressure. Ending the request iterable half-closes the RPC; responses can continue afterward.

Pass `signal` to cancel a call, or `deadline` as an absolute timestamp or Date. Cancellation rejects with `signal.reason` and stops delivery of buffered responses. Breaking out of response iteration cancels the RPC. Request producer errors preserve the original error. Cancellation requests `iterator.return()` without waiting indefinitely for a blocked producer; producers waiting on external work must arrange cancellation of that work themselves.

`createDeadline(timestampOrDate)` creates a disposable deadline signal for preparation that runs before an RPC, such as authentication. Expiry aborts it with `RpcError(Status.DEADLINE_EXCEEDED)`; disposal only cancels its timer and does not abort the signal. An omitted value or `Infinity` returns `undefined`. Pass the same absolute deadline to the RPC so preparation consumes its time budget.

Encoded request bytes are sent without a payload copy for the gRPC frame header. Serializers must keep returned buffers immutable until the RPC completes; reusing an immutable buffer is supported. Received message views may share their backing buffer with the HTTP/2 input chunk.

## Metadata and errors

Metadata is a read-only record: string values for ordinary keys, Uint8Array values for `-bin` keys, or arrays for repeated values. Keys are normalized to lowercase. The transport handles binary base64 encoding and protects its protocol headers.

Call options accept `onHeader`, `onTrailer`, and `onStatus` callbacks. A header or trailer callback error cancels the call with that error. `onStatus` reports the terminal transport status once; it can run while response messages remain buffered. Errors thrown by this observer are ignored. A later cancellation or decoding failure still rejects response iteration without a second status notification. `RpcError` carries the gRPC `code`, `details`, and trailing `metadata`. `MessageSizeError` identifies a local send or receive limit with `direction` and `limit`, so callers can distinguish a permanent size failure from server throttling. Local signal cancellation and request producer failures preserve their original errors.

## Serving RPCs

`Server` uses the same service definitions as `createServiceClient`. Each registered method also needs `requestDeserialize` and `responseSerialize`. Handlers receive decoded requests and return values accepted by the response serializer. Register only the methods a test or application needs; other methods reply with `Status.UNIMPLEMENTED`.

For a service definition with unary `echo` and server-streaming `repeat` methods:

```ts
import { Server } from '@ydbjs/grpc'
import { EchoServiceDefinition } from './echo.js'

using server = new Server()
server.add(EchoServiceDefinition, {
  echo(request) {
    return { value: request.value }
  },
  async *repeat(request, context) {
    for (let index = 0; index < request.count; index++) {
      context.signal.throwIfAborted()
      yield { value: request.value }
    }
  },
})

let port = await server.listen('127.0.0.1:0')
```

Unary and client-streaming handlers return a value or Promise. Server-streaming and bidirectional handlers return an AsyncIterable. A client-streaming or bidirectional handler receives an AsyncIterable of requests. Reading requests and producing responses respect HTTP/2 backpressure.

The context contains request `metadata`, an `AbortSignal`, the absolute `deadline` when supplied, and the remote `peer` address. Use `context.sendHeader(metadata)` once before the first response and `context.setTrailer(metadata)` to add trailing metadata. Throw `new RpcError(Status.PERMISSION_DENIED, 'details', metadata)` to finish with a gRPC error. Cancellation and deadlines abort the context signal; handlers waiting on external work must pass that signal to the operation they await.

Response metadata must not contain HTTP/2 connection-specific headers. Invalid response metadata fails only its RPC.

If a deadline interrupts an incomplete response message, the server resets the HTTP/2 stream with [`CANCEL`](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md#errors) instead of appending trailers to a truncated message. Clients can observe `Status.CANCELLED` when their own deadline has not expired; a local client deadline still reports `Status.DEADLINE_EXCEEDED`. Complete response messages can be followed by ordinary gRPC error trailers.

`listen()` defaults to `127.0.0.1:0` and returns the bound TCP port. IPv6 bind addresses use brackets, such as `[::1]:0`. A `unix:///path/to/socket` address listens on a Unix socket and returns `0`.

`using server = new Server()` disposes the server through `destroy()`: active RPCs are cancelled and connections are destroyed without waiting for streams to finish.

For graceful shutdown, explicitly `await server.close()` before leaving the scope. It stops accepting connections and new RPCs, waits for accepted RPCs to finish, and releases the remaining sockets and registered handlers. There is no automatic shutdown timeout: long-lived RPCs must finish or be cancelled by their owner.

For TLS, pass Node HTTP/2 secure-server options at construction:

```ts
import { readFile } from 'node:fs/promises'
import { Server } from '@ydbjs/grpc'

using server = new Server({
  tls: {
    key: await readFile('server-key.pem'),
    cert: await readFile('server-cert.pem'),
  },
  maxReceiveBytes: 4 * 1024 * 1024,
  maxSendBytes: 4 * 1024 * 1024,
})
```

Both message limits default to 64 MiB. `maxReceiveBytes` limits each encoded request and its decompressed body; `maxSendBytes` limits each serialized response. The server accepts identity, gzip, and deflate request messages and sends uncompressed responses. Response serializers must keep returned bytes immutable until the RPC completes because framing does not copy the payload.

## Connection options

| Option                  | Default       | Purpose                                                                    |
| ----------------------- | ------------- | -------------------------------------------------------------------------- |
| `tls`                   | Node defaults | CA, servername, client certificates, and other Node TLS connection options |
| `maxSendBytes`          | 64 MiB        | Maximum serialized request size                                            |
| `maxReceiveBytes`       | 64 MiB        | Maximum response size, checked before and after decompression              |
| `connectTimeoutMs`      | 30,000        | Connection attempt timeout; zero disables it                               |
| `keepaliveIntervalMs`   | Disabled      | Interval between HTTP/2 pings                                              |
| `keepaliveTimeoutMs`    | 10,000        | Timeout for an outstanding ping                                            |
| `connectionWindowBytes` | Node default  | HTTP/2 connection receive window                                           |
| `streamWindowBytes`     | Node default  | HTTP/2 stream receive window                                               |
| `userAgent`             | `ydbjs-grpc`  | HTTP user-agent value                                                      |

Timer options (`connectTimeoutMs`, `keepaliveIntervalMs`, and `keepaliveTimeoutMs`) accept integer milliseconds from 0 through 2,147,483,647. Larger values are rejected to prevent Node timer overflow. Absolute RPC deadlines can extend beyond this limit.

Authorities support `http:`, `https:`, `grpc:`, `grpcs:`, and `unix:`. Responses support identity, gzip, and deflate; requests use identity encoding. GOAWAY retires the connection for new calls while accepted streams finish. Subsequent calls open a new connection. A `too_many_pings` GOAWAY doubles the keepalive interval for subsequent connections without replaying requests.

The transport does not replay RPCs, balance nodes, or refresh credentials. YDB Driver and its clients own those decisions. It does not implement HTTP proxy tunneling, service-config resolution, xDS, or hedging.
