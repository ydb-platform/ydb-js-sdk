import { TransactionRollbackError } from 'drizzle-orm/errors'
import type { TablesRelationalConfig } from 'drizzle-orm/relations'
import type {
	YdbSchemaDefinition,
	YdbSchemaRelations,
	YdbSchemaWithoutTables,
} from './schema.types.js'
import { YdbDatabase } from './db.js'

export class YdbTransaction<
	TSchemaDefinition extends YdbSchemaDefinition = YdbSchemaWithoutTables,
	TSchemaRelations extends TablesRelationalConfig = YdbSchemaRelations<TSchemaDefinition>,
> extends YdbDatabase<TSchemaDefinition, TSchemaRelations> {
	rollback(): never {
		throw new TransactionRollbackError()
	}

	override transaction(): never {
		throw new Error('Nested YDB transactions are not supported')
	}
}
