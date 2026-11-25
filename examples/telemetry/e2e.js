import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { json } from 'node:stream/consumers'
import { test } from 'node:test'

test('exports YDB query traces and metrics to an OTLP collector', async () => {
	let spans = []
	let metrics = []
	await using collector = createServer(async (request, response) => {
		let batch = await json(request)
		if (request.url === '/v1/traces') {
			for (let resource of batch.resourceSpans) {
				for (let scope of resource.scopeSpans) {
					spans.push(...scope.spans)
				}
			}
		}
		if (request.url === '/v1/metrics') {
			for (let resource of batch.resourceMetrics) {
				for (let scope of resource.scopeMetrics) {
					metrics.push(...scope.metrics)
				}
			}
		}
		response.writeHead(200, { 'Content-Type': 'application/json' })
		response.end('{}')
	})
	await once(collector.listen(0, '127.0.0.1'), 'listening')
	let endpoint = `http://127.0.0.1:${collector.address().port}`
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = endpoint + '/v1/traces'
	process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = endpoint + '/v1/metrics'
	await import('./index.js')

	let workload = spans.find((span) => span.name === 'demo.workload')
	assert.ok(workload)
	assert.ok(
		spans.some((span) => span.name === 'ydb.ExecuteQuery' && span.traceId === workload.traceId)
	)
	assert.ok(metrics.some((metric) => metric.name === 'db.client.operation.duration'))
})
