import { expect, test } from 'vitest'

import * as schema from './schema.ts'

let expectedSchemaExports = [
	'bigint',
	'binary',
	'boolean',
	'bytes',
	'columnFamily',
	'customType',
	'date',
	'date32',
	'datetime',
	'datetime64',
	'decimal',
	'double',
	'dyNumber',
	'float',
	'index',
	'indexView',
	'int',
	'int16',
	'int8',
	'integer',
	'interval',
	'interval64',
	'json',
	'jsonDocument',
	'partitionByHash',
	'primaryKey',
	'rawTableOption',
	'tableOptions',
	'text',
	'timestamp',
	'timestamp64',
	'ttl',
	'uint16',
	'uint32',
	'uint64',
	'uint8',
	'unique',
	'uniqueIndex',
	'uuid',
	'vectorIndex',
	'vectorIndexView',
	'ydbTable',
	'ydbTableCreator',
	'yson',
] as const

test('schema entrypoint exposes exactly the table-declaration surface', () => {
	expect(Object.keys(schema).sort()).toEqual([...expectedSchemaExports])
})
