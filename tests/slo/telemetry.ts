import { PrometheusExporter } from '@opentelemetry/exporter-prometheus'
import {
	AggregationType,
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
		new PrometheusExporter({
			prefix: 'ydbjs',
			appendTimestamp: true,
		}),
	],
	views: [
		{
			instrumentUnit: 'seconds',
			aggregation: {
				type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
				options: {
					recordMinMax: true,
					boundaries: [
						0.005, // 5 ms
						0.01, // 10 ms
						0.015, // 15 ms
						0.02, // 20 ms
						0.025, // 25 ms
						0.05, // 50 ms
						0.075, // 75 ms
						0.1, // 100 ms
						0.15, // 150 ms
						0.2, // 200 ms
						0.25, // 250 ms
						0.5, // 500 ms
						0.75, // 750 ms
						1.0, // 1 s
						1.5, // 1 s 500 ms
						2.0, // 2 s
						5.0, // 5 s
						10.0, // 10 s
						30.0, // 30 s
						60.0, // 60 s
					],
				},
			},
		},
	],
})
;['SIGINT', 'SIGTERM'].forEach((signal) => {
	process.on(signal, () => meterProvider.shutdown().catch(console.error))
})
