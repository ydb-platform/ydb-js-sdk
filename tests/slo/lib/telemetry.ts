import { type Meter, type ObservableGauge, ValueType } from '@opentelemetry/api'
import {
	AggregationTemporalityPreference,
	OTLPMetricExporter,
} from '@opentelemetry/exporter-metrics-otlp-http'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import type * as hdr from 'hdr-histogram-js'

let ref = process.env['WORKLOAD_REF'] || 'unknown'

let exporter = new OTLPMetricExporter({
	temporalityPreference: AggregationTemporalityPreference.CUMULATIVE,
})

export const meterProvider = new MeterProvider({
	readers: [
		new PeriodicExportingMetricReader({
			exporter,
			exportIntervalMillis: 1000,
		}),
	],
	views: [
		{
			instrumentName: '*',
			attributesProcessors: [{ process: (incoming) => ({ ...incoming, ref }) }],
		},
	],
})

export type OpAttrs = {
	operation_type: 'read' | 'write'
}

export type FinOpAttrs = {
	operation_type: 'read' | 'write'
	operation_status: 'success' | 'error'
}

/**
 * Register p50/p95/p99 gauges backed by HDR histogram.
 * Single batch callback reads all percentiles atomically before reset —
 * separate callbacks could race a freshly-reset histogram.
 */
export function registerLatencyGauges(
	meter: Meter,
	histogram: hdr.Histogram,
	attributes: FinOpAttrs
): {
	p50: ObservableGauge<FinOpAttrs>
	p95: ObservableGauge<FinOpAttrs>
	p99: ObservableGauge<FinOpAttrs>
} {
	let p50 = meter.createObservableGauge<FinOpAttrs>('sdk_operation_latency_p50_seconds', {
		unit: 'seconds',
		valueType: ValueType.DOUBLE,
	})

	let p95 = meter.createObservableGauge<FinOpAttrs>('sdk_operation_latency_p95_seconds', {
		unit: 'seconds',
		valueType: ValueType.DOUBLE,
	})

	let p99 = meter.createObservableGauge<FinOpAttrs>('sdk_operation_latency_p99_seconds', {
		unit: 'seconds',
		valueType: ValueType.DOUBLE,
	})

	meter.addBatchObservableCallback(
		(result) => {
			result.observe(p50, histogram.getValueAtPercentile(50) / 1000, attributes)
			result.observe(p95, histogram.getValueAtPercentile(95) / 1000, attributes)
			result.observe(p99, histogram.getValueAtPercentile(99) / 1000, attributes)
		},
		[p50, p95, p99]
	)

	return { p50, p95, p99 }
}
