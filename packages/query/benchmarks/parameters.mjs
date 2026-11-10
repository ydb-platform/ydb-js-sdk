import assert from 'node:assert/strict'

import { QueryServiceDefinition } from '@ydbjs/api/query'
import { fromJs } from '@ydbjs/value'

import { prepareQuery } from '../dist/client.js'

// Build @ydbjs/query and its dependencies before running this file with Node or Bun.
// Native ESM imports avoid the export-getter overhead of Vitest's module runner.
let rows = Array.from({ length: 1000 }, (_, id) => {
	return { id: BigInt(id), name: `name-${id}`, active: true, score: 3.5 }
})

let cases = [
	{ name: 'Int32', input: 42, batchSize: 64 },
	{ name: 'Struct / 4 fields', input: rows[0], batchSize: 16 },
	{ name: 'Buffer / 1 KiB', input: Buffer.alloc(1024, 42), batchSize: 16 },
	{ name: 'Buffer / 64 KiB', input: Buffer.alloc(64 * 1024, 42), batchSize: 8 },
	{ name: 'Buffer / 1 MiB', input: Buffer.alloc(1024 * 1024, 42), batchSize: 4 },
	{ name: 'List / 1000 structs', input: rows, batchSize: 1 },
]

let result
let reports = []
let text = 'SELECT $input'
let method = QueryServiceDefinition.executeQuery
let sessionIds = ['benchmark-session-1', 'benchmark-session-2', 'benchmark-session-3']
let sessions = sessionIds.map((sessionId) => {
	return method.requestSerialize({ sessionId })
})

function measure(operation, batchSize, durationMs) {
	let started = performance.now()
	let now = started
	let count = 0

	do {
		for (let index = 0; index < batchSize; index++) {
			result = operation()
		}

		count += batchSize
		now = performance.now()
	} while (now - started < durationMs)

	return ((now - started) * 1000) / count
}

function median(samples) {
	let sorted = samples.toSorted((left, right) => {
		return left - right
	})

	return sorted[Math.floor(sorted.length / 2)]
}

for (let { name, input, batchSize } of cases) {
	// Reused Values retain their encode caches. Native inputs create fresh Values per preparation.
	let sources = [
		{ name: 'native', value: input },
		{ name: 'reused Value', value: fromJs(input) },
	]

	for (let source of sources) {
		let parameters = { input: source.value }
		let prepareEveryAttempt = () => {
			return sessions.map((session) => {
				return [session, prepareQuery(text, parameters).bytes]
			})
		}
		let prepareOnce = () => {
			let prepared = prepareQuery(text, parameters)

			return sessions.map((session) => {
				return [session, prepared.bytes]
			})
		}
		let expected = prepareEveryAttempt()

		assert.deepEqual(prepareOnce(), expected)
		for (let [attempt, parts] of expected.entries()) {
			let request = method.requestDeserialize(Buffer.concat(parts))

			assert.equal(request.sessionId, sessionIds[attempt])
			assert.equal(request.query.value.text, text)
		}

		measure(prepareEveryAttempt, batchSize, 100)
		measure(prepareOnce, batchSize, 100)

		let repeated = { operation: prepareEveryAttempt, samples: [] }
		let reused = { operation: prepareOnce, samples: [] }

		for (let trial = 0; trial < 7; trial++) {
			let order = trial % 2 === 0 ? [repeated, reused] : [reused, repeated]

			for (let entry of order) {
				entry.samples.push(measure(entry.operation, batchSize, 50))
				assert.deepEqual(result, expected)
			}
		}

		let repeatedTime = median(repeated.samples)
		let reusedTime = median(reused.samples)

		reports.push({
			input: name,
			source: source.name,
			'prepare every attempt, us / 3 attempts': repeatedTime.toFixed(3),
			'prepare once, us / 3 attempts': reusedTime.toFixed(3),
			'repeated / once': (repeatedTime / reusedTime).toFixed(2),
		})
	}
}

console.log({ node: process.versions.node, bun: process.versions.bun })
console.table(reports)
