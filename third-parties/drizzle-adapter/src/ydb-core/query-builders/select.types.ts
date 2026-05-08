import type { SQLWrapper } from 'drizzle-orm/sql/sql'
import type { YdbSelectConfig } from '../../ydb/dialect.types.js'

export type SelectFields = Record<string, unknown>

export interface YdbSelectBuilderOptions {
	distinct?: boolean
	distinctOn?: SQLWrapper[]
}

export type SelectConfigWithTable = Omit<YdbSelectConfig, 'table'> & { table?: unknown }
