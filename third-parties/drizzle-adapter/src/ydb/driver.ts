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

	const [rows] = result
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

	const executedQuery = options?.arrayMode ? query.values() : query
	const raw = await executedQuery
	const rows = getRows(raw)
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
	readonly client: QueryClient
	#ownsDriver: boolean

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

		this.client = createQueryClient(this.driver)
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
		const options = mapTransactionConfig(config)

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
