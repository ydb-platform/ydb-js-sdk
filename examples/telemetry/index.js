/**
 * YDB Telemetry (OpenTelemetry Tracing) Example
 *
 * Demonstrates how to connect OpenTelemetry tracing to the YDB JavaScript SDK
 * using @ydbjs/telemetry. Spans are exported via OTLP/HTTP.
 *
 * Run (requires an OTLP collector, e.g. Jaeger or OpenTelemetry Collector):
 *   YDB_CONNECTION_STRING=grpc://localhost:2136/local node index.js
 *
 * Override the collector endpoint:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node index.js
 */

import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { register } from '@ydbjs/telemetry'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

let connectionString = process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2136/local'

// 1. Start the OpenTelemetry SDK before any instrumented code runs.
//    Defaults to http://localhost:4318/v1/traces; override with OTEL_EXPORTER_OTLP_ENDPOINT.
let sdk = new NodeSDK({
	serviceName: 'my-ydb-app',
	traceExporter: new OTLPTraceExporter(),
})
sdk.start()

// 2. Register @ydbjs/telemetry — subscribes to SDK diagnostics_channel events
//    and bridges them to the active OTel trace provider.
let telemetry = register({
	endpoint: connectionString,
	// captureQueryText: true, // Uncomment to include YQL text in spans (may expose PII)
})

// 3. Create the driver, passing telemetry hooks for per-RPC span enrichment
//    (node ID, datacenter, gRPC status code).
using driver = new Driver(connectionString, {
	hooks: telemetry.hooks,
})
await driver.ready()

await using sql = query(driver)

// Suppress AbortError noise that some query internals may emit after the demo
// finishes — production code should attach .on('error', ...) per query.
process.on('uncaughtException', (err) => {
	if (err instanceof Error && err.name === 'AbortError') return
	throw err
})

console.log('\n# 1. Single-shot SELECT 1\n')
let [[row]] = await sql`SELECT 1 AS n`
console.log(`  → result: ${JSON.stringify(row)}\n`)

console.log('\n# 2. Transaction with two queries\n')
let result = await sql.begin(async (tx) => {
	let [[a]] = await tx`SELECT 1 AS a`
	let [[b]] = await tx`SELECT ${a.a + 1} AS b`
	return b.b
})
console.log(`  → result: ${result}\n`)

console.log('\n# Done, shutting down\n')

// 4. Flush pending spans, then unsubscribe telemetry.
//    `await using` above drains the session pool before driver.close() fires.
await sdk.shutdown()
telemetry()
