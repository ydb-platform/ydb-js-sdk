import { Driver } from '@ydbjs/core'
import { type QueryClient, type TX, query as createQueryClient } from '@ydbjs/query'
import { fromJs } from '@ydbjs/value'
export interface YdbTransactionConfig {
	accessMode?: 'read only' | 'read write' | undefined
	isolationLevel?: 'serializableReadWrite' | 'snapshotReadOnly' | undefined
	idempotent?: boolean | undefined
}

export type YdbExecutionMethod = 'all' | 'execute'

export interface YdbExecuteOptions {
	arrayMode?: boolean | undefined
	typings?: unknown[] | undefined
}

export interface YdbQueryMeta {
	arrayMode: boolean
	typings?: unknown[] | undefined
}

export interface YdbQueryResult {
	rows: unknown[]
	rowCount?: number
	command?: YdbExecutionMethod
	meta?: YdbQueryMeta
}

export type YdbRemoteCallback = (
	sql: string,
	params: unknown[],
	method: YdbExecutionMethod,
	options?: YdbExecuteOptions
) => Promise<YdbQueryResult>

export interface YdbExecutor {
	execute(
		sql: string,
		params: unknown[],
		method: YdbExecutionMethod,
		options?: YdbExecuteOptions
	): Promise<YdbQueryResult>
	ready?(signal?: AbortSignal): Promise<void>
	close?(): Promise<void> | void
}

export interface YdbTransactionalExecutor extends YdbExecutor {
	transaction<T>(
		callback: (tx: YdbExecutor) => Promise<T>,
		config?: YdbTransactionConfig
	): Promise<T>
}

function getRows<T = unknown>(result: unknown): T[] {
	if (!Array.isArray(result) || result.length === 0) {
		return []
	}

	if (result.length > 1) {
		// Drizzle generates one statement per call, so multi-result-set responses
		// only happen when the caller (or a raw SQL fragment) packs several
		// statements into one query. Silently dropping the tail hides real bugs.
		throw new Error(
			`YDB query returned ${result.length} result sets, but the Drizzle adapter expects exactly one. ` +
				'Split the query so each call runs a single statement, or use the @ydbjs/query API directly for multi-result-set responses.'
		)
	}

	let [rows] = result
	return Array.isArray(rows) ? (rows as T[]) : []
}

async function execQuery(
	ql: QueryClient | TX,
	text: string,
	params: unknown[],
	method: YdbExecutionMethod,
	options?: YdbExecuteOptions
): Promise<YdbQueryResult> {
	let query = ql(text)

	for (let i = 0; i < params.length; i++) {
		query = query.parameter(`p${i}`, fromJs(params[i] as any))
	}

	let executedQuery = options?.arrayMode ? query.values() : query
	let raw = await executedQuery
	let rows = getRows(raw)
	return {
		rows,
		rowCount: rows.length,
		command: method,
		meta: {
			arrayMode: options?.arrayMode === true,
			typings: options?.typings ? [...options.typings] : undefined,
		},
	}
}

function mapTransactionConfig(
	config?: YdbTransactionConfig
): { isolation?: 'serializableReadWrite' | 'snapshotReadOnly'; idempotent?: boolean } | undefined {
	if (!config) {
		return undefined
	}

	function withIdempotent(
		isolation: 'serializableReadWrite' | 'snapshotReadOnly',
		idempotent?: boolean
	): { isolation: 'serializableReadWrite' | 'snapshotReadOnly'; idempotent?: boolean } {
		return idempotent === undefined ? { isolation } : { isolation, idempotent }
	}

	if (config.isolationLevel) {
		return withIdempotent(config.isolationLevel, config.idempotent)
	}

	if (config.accessMode === 'read only') {
		return { isolation: 'snapshotReadOnly', idempotent: true }
	}

	return withIdempotent('serializableReadWrite', config.idempotent)
}

class YdbTxExecutor implements YdbExecutor {
	constructor(private readonly tx: TX) {}

	execute(
		sql: string,
		params: unknown[],
		method: YdbExecutionMethod,
		options?: YdbExecuteOptions
	): Promise<YdbQueryResult> {
		return execQuery(this.tx, sql, params, method, options)
	}
}

export interface YdbDriverOptions {
	connectionString: string
}

export class YdbDriver implements YdbTransactionalExecutor {
	readonly driver: Driver
	#ownsDriver: boolean
	#client: QueryClient | undefined

	constructor(connectionString: string)
	constructor(options: YdbDriverOptions)
	/**
	 * Wraps an existing YDB driver instance.
	 *
	 * @param driver Existing YDB driver instance. The adapter does not close borrowed drivers.
	 */
	constructor(driver: Driver)
	constructor(arg: string | YdbDriverOptions | Driver) {
		if (arg instanceof Driver) {
			this.driver = arg
			this.#ownsDriver = false
		} else if (typeof arg === 'string') {
			this.driver = new Driver(arg)
			this.#ownsDriver = true
		} else {
			this.driver = new Driver(arg.connectionString)
			this.#ownsDriver = true
		}
	}

	// Lazy: avoid constructing SessionPool until the first query/transaction.
	// Setter exists so callers (and tests) can swap in a pre-built QueryClient.
	get client(): QueryClient {
		this.#client ??= createQueryClient(this.driver)
		return this.#client
	}

	set client(value: QueryClient) {
		this.#client = value
	}

	async ready(signal?: AbortSignal): Promise<void> {
		await this.driver.ready(signal)
	}

	execute(
		sql: string,
		params: unknown[],
		method: YdbExecutionMethod,
		options?: YdbExecuteOptions
	): Promise<YdbQueryResult> {
		return execQuery(this.client, sql, params, method, options)
	}

	async transaction<T>(
		callback: (tx: YdbExecutor) => Promise<T>,
		config?: YdbTransactionConfig
	): Promise<T> {
		let options = mapTransactionConfig(config)

		if (options) {
			return this.client.begin(options, async (tx) => callback(new YdbTxExecutor(tx)))
		}

		return this.client.begin(async (tx) => callback(new YdbTxExecutor(tx)))
	}

	/**
	 * Closes the owned YDB driver instance.
	 *
	 * Borrowed driver instances passed to the constructor are not closed.
	 */
	close(): void {
		if (this.#ownsDriver) {
			this.driver.close()
		}
	}

	static fromCallback(callback: YdbRemoteCallback): YdbExecutor {
		return {
			execute(sql, params, method, options) {
				return callback(sql, params, method, options)
			},
		}
	}
}
