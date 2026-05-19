/**
 * YDB OpenTelemetry Example
 *
 * Wires `@ydbjs/telemetry` into a typical OpenTelemetry Node SDK setup, runs
 * a couple of queries inside a user-created span, and exports both spans and
 * metrics via OTLP/HTTP.
 *
 * Run:
 *   YDB_CONNECTION_STRING=grpc://localhost:2136/local node index.js
 *
 * Default exporter target is http://localhost:4318 (the OTLP/HTTP port of an
 * OpenTelemetry Collector or Jaeger ≥ 1.50). Override with
 * `OTEL_EXPORTER_OTLP_ENDPOINT=…`.
 */

import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { trace } from '@opentelemetry/api'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { register } from '@ydbjs/telemetry'

let connectionString = process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2136/local'

// 1. Start the OTel Node SDK BEFORE any YDB code imports/runs. NodeSDK
//    installs an AsyncLocalStorage-backed context manager, which is what
//    `@ydbjs/core`'s propagation middleware reads from to write `traceparent`
//    into outgoing gRPC metadata.
let sdk = new NodeSDK({
	serviceName: 'ydb-telemetry-example',
	traceExporter: new OTLPTraceExporter(),
	metricReader: new PeriodicExportingMetricReader({
		exporter: new OTLPMetricExporter(),
		// Demos export quickly so you see metrics without waiting; production
		// defaults to 60s.
		exportIntervalMillis: 5_000,
	}),
})
sdk.start()

// 2. Register `@ydbjs/telemetry` — `InstrumentationBase` subclass that
//    subscribes to SDK `diagnostics_channel` events and emits spans + metrics
//    via the global TracerProvider/MeterProvider installed in step 1.
let instrumentation = register({
	// Off by default — query text can carry PII via interpolated literals.
	// Turn on per-environment when you control the data.
	captureQueryText: false,
	// Off by default — warm-pool session acquires are sub-ms and only add
	// noise to traces. Turn on to debug pool starvation.
	emitAcquireSessionSpan: false,
})

// 3. Construct the driver. No hooks wiring required — `@ydbjs/telemetry`
//    plugs into `node:diagnostics_channel` topics that `@ydbjs/core`
//    publishes natively. We close driver / query explicitly later so the
//    teardown order is observable: workload → query close → driver close →
//    instrumentation disable → SDK shutdown.
let driver = new Driver(connectionString)
await driver.ready()

let sql = query(driver)

// `Query` extends `EventEmitter`; its `.finally` aborts an internal controller
// which can synthesise a stray `'error'` event after the awaited result is
// already resolved. Demos silence it; production code should attach
// `.on('error', …)` per query or install a process-level handler.
process.on('uncaughtException', (err) => {
	if (err instanceof Error && err.name === 'AbortError') return
	throw err
})

// 4. Wrap the workload in a user-created span. The propagation middleware in
//    `@ydbjs/core` reads `context.active()` on every outgoing RPC and injects
//    W3C `traceparent` / `tracestate` headers — so the server sees this trace
//    id and any future server-side instrumentation can correlate.
let tracer = trace.getTracer('ydb-telemetry-example')

await tracer.startActiveSpan('demo.workload', async (span) => {
	try {
		console.log('\n# 1. single-shot SELECT 1\n')
		let [[row]] = await sql`SELECT 1 AS n`
		console.log(`  → result: ${JSON.stringify(row)}\n`)

		console.log('\n# 2. transaction with two SELECTs\n')
		let result = await sql.begin(async (tx) => {
			let [[a]] = await tx`SELECT 1 AS a`
			let [[b]] = await tx`SELECT ${a.a + 1} AS b`
			return b.b
		})
		console.log(`  → result: ${result}\n`)
	} finally {
		span.end()
	}
})

console.log('\n# done, shutting down\n')

// 5. Drain query (publishes `session.closed{pool_close}` for each pooled
//    session) → close driver (publishes `driver.closed`) → disable
//    instrumentation so any post-shutdown events stop generating spans →
//    flush the OTel SDK so the final span batch and metric tick reach the
//    collector before the process exits.
await sql[Symbol.asyncDispose]()
driver[Symbol.dispose]()
instrumentation.disable()
await sdk.shutdown()
