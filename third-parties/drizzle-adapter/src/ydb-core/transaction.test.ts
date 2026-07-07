import { expect, test } from 'vitest'
import { TransactionRollbackError } from 'drizzle-orm/errors'
import { YdbDialect } from '../ydb/dialect.ts'
import { YdbTransaction } from '../ydb-core/transaction.ts'

test('transaction rollback throws Drizzle rollback error', () => {
	let tx = new YdbTransaction(new YdbDialect(), {} as any)

	expect(() => tx.rollback()).toThrow(TransactionRollbackError)
})

test('transaction rejects nested transactions explicitly', () => {
	let tx = new YdbTransaction(new YdbDialect(), {} as any)

	expect(() => tx.transaction()).toThrow(/Nested YDB transactions are not supported/u)
})
