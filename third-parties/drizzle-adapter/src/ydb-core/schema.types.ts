import type { ExtractTablesWithRelations } from 'drizzle-orm/relations'

export type YdbSchemaDefinition = Record<string, unknown>

export type YdbSchemaWithoutTables = Record<string, never>

export type YdbSchemaRelations<
	TSchemaDefinition extends YdbSchemaDefinition = YdbSchemaDefinition,
> = ExtractTablesWithRelations<TSchemaDefinition>
