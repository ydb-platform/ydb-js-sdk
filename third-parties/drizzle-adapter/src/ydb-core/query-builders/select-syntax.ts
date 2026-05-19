import { SQL, type SQLWrapper, sql as yql } from 'drizzle-orm/sql/sql'

export type YdbOrderDirection = 'asc' | 'desc'

export type YdbValuesPrimitive = string | number | boolean | bigint | null | Uint8Array | Date
export type YdbValuesRow =
	| readonly YdbValuesPrimitive[]
	| Readonly<Record<string, YdbValuesPrimitive>>

export interface YdbValuesOptions {
	alias?: string | undefined
	columns?: readonly string[] | undefined
}

export type YdbFlattenMode = 'by' | 'list by' | 'dict by' | 'optional by' | 'columns'

export interface YdbFlattenConfig {
	mode: YdbFlattenMode
	expressions?: SQLWrapper[] | undefined
}

export type YdbSampleConfig =
	| { kind: 'sample'; ratio: number | SQLWrapper }
	| {
			kind: 'tablesample'
			method: string
			size: number | SQLWrapper
			repeatable?: number | SQLWrapper | undefined
	  }

export interface YdbMatchRecognizeConfig {
	partitionBy?: SQLWrapper[] | undefined
	orderBy?: SQLWrapper[] | undefined
	measures?: Readonly<Record<string, SQLWrapper>> | undefined
	rowsPerMatch?: 'ONE ROW PER MATCH' | 'ALL ROWS PER MATCH' | undefined
	afterMatchSkip?: string | undefined
	pattern: string | SQLWrapper
	define?: Readonly<Record<string, SQLWrapper>> | undefined
}

export interface YdbUniqueDistinctHint {
	kind: 'unique' | 'distinct'
	columns?: readonly string[] | undefined
}

export interface YdbWindowClause {
	name: string
	definition: SQLWrapper
}

export interface YdbWindowDefinitionConfig {
	partitionBy?: readonly SQLWrapper[] | undefined
	orderBy?: readonly SQLWrapper[] | undefined
	frame?: string | SQLWrapper | undefined
}

export type YdbGroupingSet = readonly SQLWrapper[]

export type YdbKnnDistanceFunction = 'CosineDistance' | 'EuclideanDistance' | 'ManhattanDistance'

export type YdbKnnSimilarityFunction = 'CosineSimilarity' | 'InnerProductSimilarity'

function assertIdentifier(name: string, context: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
		throw new Error(`YDB ${context} must be a simple identifier`)
	}
}

function assertHintColumn(name: string): void {
	assertIdentifier(name, 'UNIQUE DISTINCT hint column')
}

function renderBindingName(name: string): SQL {
	const binding = name.startsWith('$') ? name : `$${name}`
	if (!/^\$[A-Za-z_][A-Za-z0-9_]*$/u.test(binding)) {
		throw new Error('YDB AS_TABLE binding must look like $name')
	}

	return yql.raw(binding)
}

function renderValue(value: YdbValuesPrimitive): SQL {
	return value === null ? yql`NULL` : yql`${value}`
}

function normalizeRows(rows: readonly YdbValuesRow[]): {
	rows: readonly SQL[]
	columns?: string[]
} {
	if (rows.length === 0) {
		throw new Error('YDB VALUES requires at least one row')
	}

	if (Array.isArray(rows[0])) {
		const expectedLength = (rows[0] as readonly unknown[]).length
		if (expectedLength === 0) {
			throw new Error('YDB VALUES rows require at least one value')
		}

		return {
			rows: rows.map((row) => {
				if (!Array.isArray(row) || row.length !== expectedLength) {
					throw new Error('YDB VALUES array rows must have the same length')
				}

				return yql`(${yql.join(
					row.map((value) => renderValue(value)),
					yql`, `
				)})`
			}),
		}
	}

	const columns = Object.keys(rows[0] as Record<string, YdbValuesPrimitive>)
	if (columns.length === 0) {
		throw new Error('YDB VALUES object rows require at least one key')
	}

	for (const column of columns) {
		assertIdentifier(column, 'VALUES column')
	}

	return {
		columns,
		rows: rows.map((row) => {
			if (Array.isArray(row)) {
				throw new Error('YDB VALUES cannot mix object and array rows')
			}

			const keys = Object.keys(row)
			if (
				keys.length !== columns.length ||
				keys.some((key, index) => key !== columns[index])
			) {
				throw new Error('YDB VALUES object rows must have identical key order')
			}

			const objectRow = row as Record<string, YdbValuesPrimitive>
			return yql`(${yql.join(
				columns.map((column) => renderValue(objectRow[column] ?? null)),
				yql`, `
			)})`
		}),
	}
}

function isMatchRecognizeConfig(
	value: YdbMatchRecognizeConfig | SQLWrapper
): value is YdbMatchRecognizeConfig {
	return typeof value === 'object' && value !== null && 'pattern' in value
}

function isWindowDefinitionConfig(
	value: YdbWindowDefinitionConfig | SQLWrapper
): value is YdbWindowDefinitionConfig {
	return (
		typeof value === 'object' &&
		value !== null &&
		('partitionBy' in value || 'orderBy' in value || 'frame' in value)
	)
}

function renderExpressionList(expressions: readonly SQLWrapper[]): SQL {
	return yql.join(
		expressions.map((value) => yql`${value}`),
		yql`, `
	)
}

function renderIntervalLiteral(value: string | SQLWrapper): SQLWrapper {
	return typeof value === 'string' ? yql`${value}` : value
}

export function values(rows: readonly YdbValuesRow[]): SQL {
	const normalized = normalizeRows(rows)
	return yql`VALUES ${yql.join([...normalized.rows], yql`, `)}`
}

export function valuesTable(rows: readonly YdbValuesRow[], options: YdbValuesOptions = {}): SQL {
	const normalized = normalizeRows(rows)
	const alias = options.alias
	const columns = options.columns ?? normalized.columns
	const columnSql =
		columns && columns.length > 0
			? yql.raw(
					`(${columns
						.map((column) => {
							assertIdentifier(column, 'VALUES column')
							return `\`${column.replace(/`/g, '``')}\``
						})
						.join(', ')})`
				)
			: undefined
	const source = yql`(${yql.raw('VALUES')} ${yql.join([...normalized.rows], yql`, `)})`

	if (!alias) {
		return source
	}

	assertIdentifier(alias, 'VALUES alias')
	return columnSql
		? yql`${source} as ${yql.identifier(alias)}${columnSql}`
		: yql`${source} as ${yql.identifier(alias)}`
}

export function asTable(binding: string | SQLWrapper, alias?: string): SQL {
	const source =
		typeof binding === 'string'
			? yql`AS_TABLE(${renderBindingName(binding)})`
			: yql`AS_TABLE(${binding})`

	if (!alias) {
		return source
	}

	assertIdentifier(alias, 'AS_TABLE alias')
	return yql`${source} as ${yql.identifier(alias)}`
}

export function matchRecognize(config: YdbMatchRecognizeConfig | SQLWrapper): SQL {
	if (!isMatchRecognizeConfig(config)) {
		return yql`${config}`
	}

	const partitionBy =
		config.partitionBy && config.partitionBy.length > 0
			? yql`PARTITION BY ${yql.join(
					config.partitionBy.map((value) => yql`${value}`),
					yql`, `
				)} `
			: undefined
	const orderBy =
		config.orderBy && config.orderBy.length > 0
			? yql`ORDER BY ${yql.join(
					config.orderBy.map((value) => yql`${value}`),
					yql`, `
				)} `
			: undefined
	const measures =
		config.measures && Object.keys(config.measures).length > 0
			? yql`MEASURES ${yql.join(
					Object.entries(config.measures).map(([alias, expression]) => {
						assertIdentifier(alias, 'MATCH_RECOGNIZE measure alias')
						return yql`${expression} AS ${yql.identifier(alias)}`
					}),
					yql`, `
				)} `
			: undefined
	const rowsPerMatch = config.rowsPerMatch ? yql.raw(`${config.rowsPerMatch} `) : undefined
	const afterMatchSkip = config.afterMatchSkip
		? yql.raw(`AFTER MATCH SKIP ${config.afterMatchSkip} `)
		: undefined
	const pattern = typeof config.pattern === 'string' ? yql.raw(config.pattern) : config.pattern
	const define =
		config.define && Object.keys(config.define).length > 0
			? yql` DEFINE ${yql.join(
					Object.entries(config.define).map(([name, expression]) => {
						assertIdentifier(name, 'MATCH_RECOGNIZE variable')
						return yql`${yql.raw(name)} AS ${expression}`
					}),
					yql`, `
				)}`
			: undefined

	return yql`(${partitionBy}${orderBy}${measures}${rowsPerMatch}${afterMatchSkip}PATTERN ${pattern}${define})`
}

export function uniqueHint(...columns: string[]): YdbUniqueDistinctHint {
	columns.forEach(assertHintColumn)
	return { kind: 'unique', columns }
}

export function distinctHint(...columns: string[]): YdbUniqueDistinctHint {
	columns.forEach(assertHintColumn)
	return { kind: 'distinct', columns }
}

export function renderUniqueDistinctHints(hints: readonly YdbUniqueDistinctHint[]): SQL {
	if (hints.length === 0) {
		throw new Error('YDB UNIQUE DISTINCT hints require at least one hint')
	}

	const rendered = hints.map((hint) => {
		const columns = hint.columns ?? []
		columns.forEach(assertHintColumn)
		return `${hint.kind}(${columns.join(' ')})`
	})

	return yql.raw(`/*+ ${rendered.join(' ')} */`)
}

export function windowDefinition(config: YdbWindowDefinitionConfig | SQLWrapper): SQL {
	if (!isWindowDefinitionConfig(config)) {
		return yql`${config}`
	}

	const parts: SQL[] = []
	if (config.partitionBy && config.partitionBy.length > 0) {
		parts.push(yql`PARTITION BY ${renderExpressionList(config.partitionBy)}`)
	}
	if (config.orderBy && config.orderBy.length > 0) {
		parts.push(yql`ORDER BY ${renderExpressionList(config.orderBy)}`)
	}
	if (config.frame) {
		parts.push(typeof config.frame === 'string' ? yql.raw(config.frame) : yql`${config.frame}`)
	}

	return yql`(${yql.join(parts, yql` `)})`
}

export function groupKey(expression: SQLWrapper, alias: string): SQL {
	assertIdentifier(alias, 'GROUP BY alias')
	return yql`${expression} AS ${yql.identifier(alias)}`
}

export function rollup(...expressions: SQLWrapper[]): SQL {
	if (expressions.length === 0) {
		throw new Error('YDB ROLLUP requires at least one expression')
	}

	return yql`ROLLUP(${renderExpressionList(expressions)})`
}

export function cube(...expressions: SQLWrapper[]): SQL {
	if (expressions.length === 0) {
		throw new Error('YDB CUBE requires at least one expression')
	}

	return yql`CUBE(${renderExpressionList(expressions)})`
}

export function groupingSets(...sets: [YdbGroupingSet, ...YdbGroupingSet[]]): SQL {
	return yql`GROUPING SETS(${yql.join(
		sets.map((set) => yql`(${renderExpressionList(set)})`),
		yql`, `
	)})`
}

export function grouping(...expressions: SQLWrapper[]): SQL {
	if (expressions.length === 0) {
		throw new Error('YDB GROUPING requires at least one expression')
	}

	return yql`GROUPING(${renderExpressionList(expressions)})`
}

export function sessionWindow(
	orderExpression: SQLWrapper,
	timeoutExpression: string | SQLWrapper
): SQL
export function sessionWindow(
	orderExpression: SQLWrapper,
	initLambda: SQLWrapper,
	updateLambda: SQLWrapper,
	calculateLambda: SQLWrapper
): SQL
export function sessionWindow(
	orderExpression: SQLWrapper,
	second: string | SQLWrapper,
	updateLambda?: SQLWrapper,
	calculateLambda?: SQLWrapper
): SQL {
	if (updateLambda || calculateLambda) {
		if (!updateLambda || !calculateLambda || typeof second === 'string') {
			throw new Error(
				'YDB SessionWindow extended form requires init, update, and calculate lambdas'
			)
		}

		return yql`SessionWindow(${orderExpression}, ${second}, ${updateLambda}, ${calculateLambda})`
	}

	return yql`SessionWindow(${orderExpression}, ${renderIntervalLiteral(second)})`
}

export function sessionStart(): SQL {
	return yql.raw('SessionStart()')
}

export function hop(
	timeExtractor: SQLWrapper,
	hopInterval: string | SQLWrapper,
	windowInterval: string | SQLWrapper,
	delay: string | SQLWrapper
): SQL {
	return yql`HOP(${timeExtractor}, ${renderIntervalLiteral(hopInterval)}, ${renderIntervalLiteral(windowInterval)}, ${renderIntervalLiteral(delay)})`
}

export function hopStart(): SQL {
	return yql.raw('HOP_START()')
}

export function hopEnd(): SQL {
	return yql.raw('HOP_END()')
}

export function knnDistance(
	fn: YdbKnnDistanceFunction,
	vector: SQLWrapper,
	target: SQLWrapper
): SQL {
	return yql`${yql.raw(`Knn::${fn}`)}(${vector}, ${target})`
}

export function knnSimilarity(
	fn: YdbKnnSimilarityFunction,
	vector: SQLWrapper,
	target: SQLWrapper
): SQL {
	return yql`${yql.raw(`Knn::${fn}`)}(${vector}, ${target})`
}

export function knnCosineDistance(vector: SQLWrapper, target: SQLWrapper): SQL {
	return knnDistance('CosineDistance', vector, target)
}

export function knnEuclideanDistance(vector: SQLWrapper, target: SQLWrapper): SQL {
	return knnDistance('EuclideanDistance', vector, target)
}

export function knnManhattanDistance(vector: SQLWrapper, target: SQLWrapper): SQL {
	return knnDistance('ManhattanDistance', vector, target)
}

export function knnCosineSimilarity(vector: SQLWrapper, target: SQLWrapper): SQL {
	return knnSimilarity('CosineSimilarity', vector, target)
}

export function knnInnerProductSimilarity(vector: SQLWrapper, target: SQLWrapper): SQL {
	return knnSimilarity('InnerProductSimilarity', vector, target)
}
