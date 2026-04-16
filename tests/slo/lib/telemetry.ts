import { type Meter, type ObservableGauge, ValueType } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import type * as hdr from 'hdr-histogram-js'

let ref = process.env['WORKLOAD_REF'] || 'unknown'

// Promote `ref` resource attribute to every data point so it becomes
// a Prometheus label (the SLO report splits series by ref=current/baseline).
// OTel JS Views can only filter attributes, not inject new ones,
// so we wrap the exporter instead.
let exporter = new OTLPMetricExporter({})
let originalExport = exporter.export.bind(exporter)
exporter.export = (metrics, resultCallback) => {
	for (let scope of metrics.scopeMetrics) {
		for (let metric of scope.metrics) {
			for (let dp of metric.dataPoints) {
				dp.attributes['ref'] = ref
			}
		}
	}
	return originalExport(metrics, resultCallback)
}

export const meterProvider = new MeterProvider({
	resource: resourceFromAttributes({ ref }),
	readers: [
		new PeriodicExportingMetricReader({
			exporter,
			exportIntervalMillis: 1000,
		}),
	],
})

;['SIGINT', 'SIGTERM'].forEach((signal) => {
	process.on(signal, () => meterProvider.shutdown().catch(console.error))
})

export type LatencyAttributes = {
	operation_type: 'read' | 'write'
	operation_status: 'success' | 'error'
}

/**
 * Register three observable gauges (p50/p95/p99) backed by the given
 * hdr histograms. The gauges are populated via a single batch callback
 * so that all percentiles are read atomically before the histograms
 * are reset — otherwise separate callbacks can race and some gauges
 * may observe a freshly-reset histogram.
 */
export function registerLatencyGauges(
	meter: Meter,
	histograms: Record<'read' | 'write', hdr.Histogram>
): {
	p50: ObservableGauge<LatencyAttributes>
	p95: ObservableGauge<LatencyAttributes>
	p99: ObservableGauge<LatencyAttributes>
} {
	let p50 = meter.createObservableGauge<LatencyAttributes>('sdk_operation_latency_p50_seconds', {
		unit: 'seconds',
		valueType: ValueType.DOUBLE,
	})
	let p95 = meter.createObservableGauge<LatencyAttributes>('sdk_operation_latency_p95_seconds', {
		unit: 'seconds',
		valueType: ValueType.DOUBLE,
	})
	let p99 = meter.createObservableGauge<LatencyAttributes>('sdk_operation_latency_p99_seconds', {
		unit: 'seconds',
		valueType: ValueType.DOUBLE,
	})

	meter.addBatchObservableCallback(
		(result) => {
			for (let op of ['read', 'write'] as const) {
				let h = histograms[op]
				let attrs: LatencyAttributes = { operation_type: op, operation_status: 'success' }
				result.observe(p50, h.getValueAtPercentile(50) / 1000, attrs)
				result.observe(p95, h.getValueAtPercentile(95) / 1000, attrs)
				result.observe(p99, h.getValueAtPercentile(99) / 1000, attrs)
				h.reset()
			}
		},
		[p50, p95, p99]
	)

	return { p50, p95, p99 }
}
