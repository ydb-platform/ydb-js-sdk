import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'

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
