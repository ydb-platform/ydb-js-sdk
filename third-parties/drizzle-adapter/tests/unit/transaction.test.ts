import { test } from 'vitest'
import assert from 'node:assert/strict'
import { TransactionRollbackError } from 'drizzle-orm/errors'
import { YdbDialect } from '../../src/ydb/dialect.ts'
import { YdbTransaction } from '../../src/ydb-core/transaction.ts'

test('transaction rollback throws Drizzle rollback error', () => {
	let tx = new YdbTransaction(new YdbDialect(), {} as any)

	assert.throws(() => tx.rollback(), TransactionRollbackError)
})

test('transaction rejects nested transactions explicitly', () => {
	let tx = new YdbTransaction(new YdbDialect(), {} as any)

	assert.throws(() => tx.transaction(), /Nested YDB transactions are not supported/u)
})
