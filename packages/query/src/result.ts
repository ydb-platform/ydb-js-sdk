import type { QueryPart, QueryStream, QuerySummary } from './stream.js'

export type ResultTypes = [] | [unknown, ...unknown[]]

export type ResultSet<Row = unknown> = Omit<QueryPart<Row>, 'resultSetIndex'>

export interface QueryResult<T extends ResultTypes = ResultTypes> extends QuerySummary {
	resultSets: { [Index in keyof T]: ResultSet<T[Index]> }
}

export async function collect<T extends ResultTypes>(
	stream: QueryStream<T[number]>
): Promise<QueryResult<T>> {
	let resultSets: ResultSet<T[number]>[] = []

	for await (let part of stream) {
		let result = resultSets[part.resultSetIndex]

		if (!result) {
			result = { columns: part.columns, rows: part.rows, truncated: false }
			resultSets[part.resultSetIndex] = result
		} else {
			for (let row of part.rows) result.rows.push(row)
		}

		result.truncated ||= part.truncated
	}

	return { resultSets: resultSets as QueryResult<T>['resultSets'], ...stream.summary }
}
