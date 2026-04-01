import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import {
	ConsoleMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'

export const meterProvider = new MeterProvider({
	readers: [
		new PeriodicExportingMetricReader({
			exporter: new ConsoleMetricExporter({}),
			exportIntervalMillis: 30 * 1000,
		}),
		new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({}),
			exportIntervalMillis: 1000,
		}),
	],
})

;['SIGINT', 'SIGTERM'].forEach((signal) => {
	process.on(signal, () => meterProvider.shutdown().catch(console.error))
})
