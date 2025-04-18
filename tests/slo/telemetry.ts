import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { AggregationType, ConsoleMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';


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
			instrumentUnit: "seconds",
			aggregation: {
				type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
				options: {
					recordMinMax: true,
					boundaries: [
						0.005,  // 5 ms
						0.010,  // 10 ms
						0.015,  // 15 ms
						0.020,  // 20 ms
						0.025,  // 25 ms
						0.050,  // 50 ms
						0.075,  // 75 ms
						0.100,  // 100 ms
						0.150,  // 150 ms
						0.200,  // 200 ms
						0.250,  // 250 ms
						0.500,  // 500 ms
						0.750,  // 750 ms
						1.000,  // 1 s
						1.500,  // 1 s 500 ms
						2.000,  // 2 s
						5.000,  // 5 s
						10.000, // 10 s
						30.000, // 30 s
						60.000, // 60 s
					]
				}
			}
		}
	]
});

['SIGINT', 'SIGTERM'].forEach(signal => {
	process.on(signal, () => meterProvider.shutdown().catch(console.error));
});
