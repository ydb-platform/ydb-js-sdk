import { type LinkedSignal, linkSignals } from '@ydbjs/abortable'
import type { QueryStats } from '@ydbjs/api/query'
import type { Column } from '@ydbjs/api/value'
import type { Metadata } from '@ydbjs/grpc'

export interface QuerySummary {
	stats?: QueryStats | undefined
	metadata?: Metadata | undefined
}

export interface QueryPart<Row = Record<string, unknown>> {
	resultSetIndex: number
	columns: readonly Column[]
	rows: Row[]
	truncated: boolean
}

export interface QueryResult<Row = Record<string, unknown>> extends QuerySummary {
	resultSets: Array<Omit<QueryPart<Row>, 'resultSetIndex'>>
}

/** A single execution. Errors during consumption never restart this iterator. */
export class QueryStream<Row = Record<string, unknown>>
	implements AsyncIterableIterator<QueryPart<Row>>, AsyncDisposable
{
	#source:
		| ((
				signal: AbortSignal,
				complete: (summary: QuerySummary) => void
		  ) => AsyncGenerator<QueryPart<Row>>)
		| undefined
	#signals: readonly AbortSignal[]
	#controller = new AbortController()
	#linked: LinkedSignal | undefined
	#iterator: AsyncGenerator<QueryPart<Row>> | undefined
	#closing: Promise<IteratorResult<QueryPart<Row>>> | undefined
	#summary: QuerySummary | undefined
	#pendingSummary: QuerySummary | undefined
	#pending = false
	#returned = false
	#finished = false
	#failed = false
	#failure: unknown
	#onFinish: (() => void) | undefined
	#onAbort = () => {
		if (!this.#returned) {
			this.#failed = true
			this.#failure = this.#linked!.signal.reason
		}
		void this.#close().catch(() => {})
	}

	constructor(
		source: (
			signal: AbortSignal,
			complete: (summary: QuerySummary) => void
		) => AsyncGenerator<QueryPart<Row>>,
		signals: readonly AbortSignal[],
		onFinish?: () => void
	) {
		this.#source = source
		this.#signals = signals
		this.#onFinish = onFinish
	}

	get summary(): QuerySummary | undefined {
		return this.#summary
	}

	[Symbol.asyncIterator](): this {
		return this
	}

	async next(): Promise<IteratorResult<QueryPart<Row>>> {
		if (this.#returned) return { done: true, value: undefined }
		if (this.#failed) throw this.#failure
		if (this.#finished) return { done: true, value: undefined }
		if (this.#pending) throw new Error('A query stream supports only one pending next() call.')
		this.#pending = true
		try {
			if (!this.#iterator) {
				this.#linked = linkSignals(this.#controller.signal, ...this.#signals)
				this.#linked.signal.throwIfAborted()
				this.#iterator = this.#source!(this.#linked.signal, (summary) => {
					this.#pendingSummary = summary
				})
				this.#linked.signal.addEventListener('abort', this.#onAbort, { once: true })
			}
			let result = await this.#iterator.next()
			if (result.done) {
				this.#summary = this.#pendingSummary
				this.#finish()
			}
			return result
		} catch (error) {
			this.#failed = true
			this.#failure = error
			this.#finish()
			throw error
		} finally {
			this.#pending = false
		}
	}

	async return(): Promise<IteratorResult<QueryPart<Row>>> {
		this.#returned = true
		return this.#close()
	}

	async throw(error: unknown): Promise<IteratorResult<QueryPart<Row>>> {
		this.cancel(error)
		await this.#close()
		throw error
	}

	cancel(reason: unknown = new DOMException('Query stream cancelled.', 'AbortError')): void {
		if (this.#finished || this.#controller.signal.aborted) return
		this.#failed = true
		this.#failure = reason
		this.#controller.abort(reason)
		void this.#close().catch(() => {})
	}

	#close(): Promise<IteratorResult<QueryPart<Row>>> {
		if (this.#closing) return this.#closing
		this.#closing = Promise.resolve()
			.then(
				() => this.#iterator?.return(undefined) ?? { done: true as const, value: undefined }
			)
			.finally(() => this.#finish())
		// AsyncGenerator.return() alone queues behind a pending read instead of cancelling it.
		this.#controller.abort(new DOMException('Query stream closed.', 'AbortError'))
		return this.#closing
	}

	#finish(): void {
		if (this.#finished) return
		this.#finished = true
		this.#linked?.signal.removeEventListener('abort', this.#onAbort)
		this.#linked?.[Symbol.dispose]()
		this.#linked = undefined
		this.#signals = []
		this.#iterator = undefined
		this.#source = undefined
		this.#pendingSummary = undefined
		this.#onFinish?.()
		this.#onFinish = undefined
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.return()
	}
}
