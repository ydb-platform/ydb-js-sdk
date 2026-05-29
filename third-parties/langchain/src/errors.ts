/**
 * Base class for every error thrown by `@ydbjs/langchain`. Catch this to
 * separate store errors from framework errors at the LangChain layer.
 */
export class YDBVectorStoreError extends Error {
	constructor(msg: string) {
		super(msg)
		this.name = 'YDBVectorStoreError'
	}
}

/**
 * Constructor-time configuration is invalid (bad connection params, unknown
 * strategy, out-of-range tuning options, misuse of static helpers, …).
 */
export class YDBVectorStoreConfigError extends YDBVectorStoreError {
	constructor(msg: string) {
		super(msg)
		this.name = 'YDBVectorStoreConfigError'
	}
}

/**
 * Call-time argument is invalid (vector/document count mismatch, negative `k`, …).
 */
export class YDBVectorStoreArgumentError extends YDBVectorStoreError {
	constructor(msg: string) {
		super(msg)
		this.name = 'YDBVectorStoreArgumentError'
	}
}

/**
 * Operation cannot run in the current store state (filter combined with index,
 * `createVectorIndex` without `indexEnabled` / `indexVectorDimension`, …).
 */
export class YDBVectorStoreOperationError extends YDBVectorStoreError {
	constructor(msg: string) {
		super(msg)
		this.name = 'YDBVectorStoreOperationError'
	}
}
