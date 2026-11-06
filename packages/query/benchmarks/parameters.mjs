import assert from 'node:assert/strict'

import { create, toBinary } from '@bufbuild/protobuf'
import { TypedValueSchema } from '@ydbjs/api/value'
import { fromJs } from '@ydbjs/value'

import { snapshotValue } from '../dist/parameters.js'

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

function serialize(value) {
	let message = create(TypedValueSchema, {
		type: value.type.encode(),
		value: value.encode(),
	})

	return toBinary(TypedValueSchema, message)
}

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
	// Reused Values retain their encode caches. Native inputs create a fresh Value per operation.
	let sources = [
		{ name: 'native', value: input },
		{ name: 'reused Value', value: fromJs(input) },
	]

	for (let source of sources) {
		let expected = serialize(fromJs(source.value))

		assert.deepEqual(serialize(snapshotValue(source.value)), expected)

		for (let stage of ['create', 'create and serialize']) {
			let withoutSnapshot = () => {
				let value = fromJs(source.value)

				return stage === 'create' ? value : serialize(value)
			}

			// The current snapshot path includes encoding and protobuf validation as well as copying.
			let withSnapshot = () => {
				let value = snapshotValue(source.value)

				return stage === 'create' ? value : serialize(value)
			}

			measure(withoutSnapshot, batchSize, 100)
			measure(withSnapshot, batchSize, 100)

			let without = { operation: withoutSnapshot, samples: [] }
			let withCopy = { operation: withSnapshot, samples: [] }

			for (let trial = 0; trial < 7; trial++) {
				let order = trial % 2 === 0 ? [without, withCopy] : [withCopy, without]

				for (let entry of order) {
					entry.samples.push(measure(entry.operation, batchSize, 50))

					assert.deepEqual(stage === 'create' ? serialize(result) : result, expected)
				}
			}

			let baseline = median(without.samples)
			let snapshot = median(withCopy.samples)

			reports.push({
				input: name,
				source: source.name,
				stage,
				'without snapshot, us': baseline.toFixed(3),
				'with snapshot, us': snapshot.toFixed(3),
				ratio: (snapshot / baseline).toFixed(2),
			})
		}
	}
}

console.log({ node: process.versions.node, bun: process.versions.bun })
console.table(reports)
