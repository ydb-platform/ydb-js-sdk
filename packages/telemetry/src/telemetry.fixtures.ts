// Shared scaffolding for the metrics-pipeline tests. Lives in src/ (not tests/)
// so both vitest projects can import it; `*.fixtures.ts` is excluded from
// coverage by the root vitest config.

import type { MetricAttributes } from '@opentelemetry/api'
import {
	AggregationTemporality,
	type DataPoint,
	InMemoryMetricExporter,
	MeterProvider,
	type MetricData,
	PeriodicExportingMetricReader,
	type ResourceMetrics,
} from '@opentelemetry/sdk-metrics'

export let driverIdentity = {
	address: '127.0.0.1',
	port: 2136,
	database: '/local',
}

export type MetricHarness = {
	provider: MeterProvider
	/** Force an export and return the newest ResourceMetrics, or undefined if nothing was recorded. */
	collect(): Promise<ResourceMetrics | undefined>
	shutdown(): Promise<void>
}

export function createMetricHarness(): MetricHarness {
	let exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
	let provider = new MeterProvider({
		readers: [
			new PeriodicExportingMetricReader({
				exporter,
				// Long enough that it never auto-fires within a test; flushes are
				// driven explicitly via collect().
				exportIntervalMillis: 60_000,
				exportTimeoutMillis: 5_000,
			}),
		],
	})
	return {
		provider,
		async collect() {
			await provider.forceFlush()
			let exported = exporter.getMetrics()
			return exported[exported.length - 1]
		},
		shutdown: () => provider.shutdown(),
	}
}

export function findInstrument(rm: ResourceMetrics, name: string): MetricData {
	for (let scope of rm.scopeMetrics) {
		let found = scope.metrics.find((inst) => inst.descriptor.name === name)
		if (found) return found
	}
	throw new Error(`no instrument named ${name}`)
}

/** Every datapoint of `name` whose attributes are a superset of `filter`. */
export function pointsFor<T>(
	rm: ResourceMetrics | undefined,
	name: string,
	filter: MetricAttributes = {}
): DataPoint<T>[] {
	if (!rm) return []
	let all = rm.scopeMetrics
		.flatMap((scope) => scope.metrics)
		.filter((inst) => inst.descriptor.name === name)
		.flatMap((inst) => inst.dataPoints as DataPoint<T>[])
	return all.filter((p) =>
		Object.entries(filter).every(([k, v]) => (p.attributes as Record<string, unknown>)[k] === v)
	)
}

export function findPoint<T>(
	rm: ResourceMetrics,
	name: string,
	filter: MetricAttributes
): DataPoint<T> {
	let matches = pointsFor<T>(rm, name, filter)
	if (matches.length === 0) {
		let inst = findInstrument(rm, name)
		throw new Error(
			`no datapoint for ${name} matching ${JSON.stringify(filter)}. Got: ${JSON.stringify(inst.dataPoints.map((p) => p.attributes))}`
		)
	}
	return matches[0]!
}
