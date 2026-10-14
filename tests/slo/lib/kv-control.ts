import { deepStrictEqual } from 'node:assert'

function controlRow(generation: bigint) {
	return Object.freeze({
		hash: 0n,
		id: 18446744073709551615n,
		payload_str: `slo:${generation}`,
		payload_double: 0.5,
		payload_timestamp: 1_700_000_000_000_000n,
		payload_hash: generation,
	})
}

export function kvTableName(namespace: string | undefined): string {
	if (!namespace || !/^[a-zA-Z0-9_]{1,64}$/.test(namespace))
		throw new Error('Invalid KV namespace')
	return `test_${namespace}`
}

export function controlSequence() {
	let busy = false
	let generation = 0n
	return async (
		write: (row: ReturnType<typeof controlRow>) => PromiseLike<unknown>,
		read: (row: ReturnType<typeof controlRow>) => PromiseLike<unknown>
	): Promise<void> => {
		if (busy) return
		busy = true
		try {
			let expected = controlRow(++generation)
			await write(expected)
			deepStrictEqual(await read(expected), [[expected]])
		} finally {
			busy = false
		}
	}
}
