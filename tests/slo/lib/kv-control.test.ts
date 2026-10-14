import { expect, test } from 'vitest'
import { controlSequence, kvTableName } from './kv-control.ts'
test('isolates lifecycle table names and rejects unsafe namespaces', () => {
	expect(kvTableName('current')).not.toBe(kvTableName('baseline'))
	for (let value of [undefined, '', 'a`', '../x']) expect(() => kvTableName(value)).toThrow(Error)
})
test('publishes only successful writes and serializes generations without blocking load', async () => {
	let verify = controlSequence(),
		entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>()
	let first = verify(
		() => {
			entered.resolve()
			return release.promise
		},
		async (row) => [[row]]
	)
	await entered.promise
	await verify(
		async () => {
			throw new Error('overlapping owner')
		},
		async () => []
	)
	release.resolve()
	await first
	await verify(
		async (row) => {
			expect(row.payload_hash).toBe(2n)
		},
		async (row) => [[{ ...row }]]
	)
	let cause = new Error('write failed')
	await expect(
		verify(
			async () => {
				throw cause
			},
			async () => {
				throw new Error('unpublished read')
			}
		)
	).rejects.toBe(cause)
	await expect(
		verify(
			async () => {},
			async () => {
				throw cause
			}
		)
	).rejects.toBe(cause)
})
for (let corrupt of [
	'missing',
	'extra',
	'hash',
	'id',
	'payload_str',
	'payload_double',
	'payload_timestamp',
]) {
	test(`rejects ${corrupt} after a successful write`, async () => {
		await expect(
			controlSequence()(
				async () => {},
				async (row) =>
					corrupt === 'missing'
						? [[]]
						: corrupt === 'extra'
							? [[row, row]]
							: [[{ ...row, [corrupt]: null }]]
			)
		).rejects.toThrow(Error)
	})
}
test('rejects a stale generation independently of payload', async () => {
	await expect(
		controlSequence()(
			async () => {},
			async (row) => [[{ ...row, payload_hash: 0n }]]
		)
	).rejects.toThrow(Error)
})

test('rejects timestamp corruption below one millisecond', async () => {
	await expect(
		controlSequence()(
			async () => {},
			async (row) => [[{ ...row, payload_timestamp: row.payload_timestamp + 1n }]]
		)
	).rejects.toThrow(Error)
})
