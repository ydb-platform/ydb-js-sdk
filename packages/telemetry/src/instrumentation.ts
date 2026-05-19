import { InstrumentationBase, type InstrumentationConfig } from '@opentelemetry/instrumentation'
import { addClientMiddleware } from '@ydbjs/core'

import pkg from '../package.json' with { type: 'json' }

import { YdbMetricsPipeline } from './metrics.js'
import { propagator } from './propagation.js'
import { YdbTracesPipeline } from './traces.js'

export type YdbInstrumentationConfig = InstrumentationConfig & {
	/**
	 * Include raw query text as `db.query.text`. Default `false`.
	 * Query text can carry PII (literals interpolated by the user), so the
	 * safe default is to omit. Enable per environment when you control the
	 * data flowing through.
	 */
	captureQueryText?: boolean
	/**
	 * Emit `ydb.AcquireSession` span. Default `false`.
	 * Session acquisition is almost always instant (warm pool hit), so the
	 * span is noise in 99% of traces. Turn on only when debugging session-
	 * pool starvation.
	 */
	emitAcquireSessionSpan?: boolean
}

export class YdbInstrumentation extends InstrumentationBase<YdbInstrumentationConfig> {
	#traces: YdbTracesPipeline | undefined
	#metrics: YdbMetricsPipeline | undefined
	#propagatorHandle: Disposable | undefined

	constructor(config: YdbInstrumentationConfig = {}) {
		// Defer `enable()` until our private fields are constructed —
		// `InstrumentationBase` would otherwise call it from inside super().
		super(pkg.name, pkg.version, { ...config, enabled: false })
		if (config.enabled !== false) this.enable()
	}

	protected init(): undefined {
		return undefined
	}

	override enable(): void {
		super.enable()
		if (this.#traces || this.#metrics) return

		let cfg = this.getConfig()
		this.#traces = new YdbTracesPipeline(this.tracer, this._diag, {
			captureQueryText: cfg.captureQueryText ?? false,
			emitAcquireSessionSpan: cfg.emitAcquireSessionSpan ?? false,
		})
		this.#traces.enable()

		this.#metrics = new YdbMetricsPipeline(this.meter)
		this.#metrics.enable()

		this.#propagatorHandle = addClientMiddleware(propagator)
	}

	override disable(): void {
		super.disable()
		this.#traces?.disable()
		this.#traces = undefined
		this.#metrics?.disable()
		this.#metrics = undefined
		this.#propagatorHandle?.[Symbol.dispose]()
		this.#propagatorHandle = undefined
	}
}
