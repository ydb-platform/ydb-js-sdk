import { createHash } from 'node:crypto'

export type TopicOracleOptions = {
	runId: string
	partitions: number
	messageBytes: number
}

export type TopicObservation = { partition: number; sequence: number }

export type TopicOraclePending = {
	unacknowledged: number
	undelivered: number
	uncommitted: number
	acknowledgedUndelivered: number
	uncertain: number
}

export type TopicOracleCounts = {
	accepted: number
	acknowledged: number
	delivered: number
	committed: number
	duplicates: number
}

export type TopicOracleSnapshot = {
	runId: string
	messageBytes: number
	complete: boolean
	totals: TopicOracleCounts
	pending: TopicOraclePending
	producers: Array<
		TopicOracleCounts & {
			partition: number
			producer: string
			pending: TopicOraclePending
			missing: {
				undelivered: number[]
				uncommitted: number[]
				acknowledgedUndelivered: number[]
			}
		}
	>
	errors: string[]
	failureCount: number
}

type ProducerState = {
	accepted: number
	acknowledged: number
	offsets: Map<number, bigint>
	committed: Set<number>
	duplicates: number
	nextObserved: number
	lastOffset: bigint | undefined
	confirmedOffset: bigint
	nextConfirmation: number
}

let HEADER_BYTES = 56
let MAGIC = 0x59444254
let VERSION = 1
let MAX_EXAMPLES = 10
let MAX_ERRORS = 20

export class TopicOracle {
	#runId: string
	#runHash: Uint8Array
	#messageBytes: number
	#producers: ProducerState[]
	#errors: string[] = []
	#failureCount = 0

	constructor(options: TopicOracleOptions) {
		if (!options.runId.trim()) {
			throw new RangeError('runId must not be empty')
		}
		if (
			!Number.isInteger(options.partitions) ||
			options.partitions <= 0 ||
			options.partitions > 0xffff_ffff
		) {
			throw new RangeError('partitions must be a positive uint32')
		}
		if (
			!Number.isInteger(options.messageBytes) ||
			options.messageBytes < 64 ||
			options.messageBytes > 0xffff_ffff
		) {
			throw new RangeError('messageBytes must be an integer between 64 and 4294967295')
		}
		this.#runId = options.runId
		this.#runHash = createHash('sha256').update(options.runId).digest()
		this.#messageBytes = options.messageBytes
		this.#producers = Array.from({ length: options.partitions }, () => ({
			accepted: 0,
			acknowledged: 0,
			offsets: new Map(),
			committed: new Set(),
			duplicates: 0,
			nextObserved: 1,
			lastOffset: undefined,
			confirmedOffset: 0n,
			nextConfirmation: 1,
		}))
	}

	producerId(partition: number): string {
		this.#partition(partition)
		return `slo-${Buffer.from(this.#runHash).toString('hex')}-${partition}`
	}

	createPayload(partition: number, sequence: number): Uint8Array {
		this.#partition(partition)
		this.#sequence(sequence)
		let payload = new Uint8Array(this.#messageBytes)
		let header = new DataView(payload.buffer)
		header.setUint32(0, MAGIC)
		header.setUint32(4, VERSION)
		payload.set(this.#runHash, 8)
		header.setUint32(40, partition)
		header.setBigUint64(44, BigInt(sequence))
		header.setUint32(52, this.#messageBytes)
		let pattern = createHash('sha256').update(payload.subarray(0, HEADER_BYTES)).digest()
		for (let i = HEADER_BYTES; i < payload.length; i++) {
			payload[i] = pattern[(i - HEADER_BYTES) % pattern.length]!
		}
		return payload
	}

	accept(partition: number, sequence: number): void {
		let state = this.#partition(partition)
		this.#sequence(sequence)
		if (sequence !== state.accepted + 1) {
			this.#reject(
				`Partition ${partition}: accepted sequence ${sequence}, expected ${state.accepted + 1}`
			)
		}
		state.accepted = sequence
	}

	acknowledge(partition: number, through: number): void {
		let state = this.#partition(partition)
		if (!Number.isSafeInteger(through) || through < 0 || through > state.accepted) {
			this.#reject(
				`Partition ${partition}: invalid acknowledged watermark ${through}, accepted ${state.accepted}`
			)
		}
		state.acknowledged = Math.max(state.acknowledged, through)
	}

	observe(message: {
		payload: Uint8Array
		producer: string
		partitionId: bigint
		offset: bigint
	}): TopicObservation {
		let { payload, producer, partitionId, offset } = message
		if (payload.byteLength !== this.#messageBytes) {
			this.#reject(`Payload length ${payload.byteLength}, expected ${this.#messageBytes}`)
		}
		let header = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
		if (header.getUint32(0) !== MAGIC || header.getUint32(4) !== VERSION) {
			this.#reject('Invalid topic payload magic or version')
		}
		for (let i = 0; i < this.#runHash.length; i++) {
			if (payload[8 + i] !== this.#runHash[i]) {
				this.#reject('Payload belongs to a different run')
			}
		}
		let partition = header.getUint32(40)
		let sequence = Number(header.getBigUint64(44))
		let state = this.#partition(partition)
		this.#sequence(sequence)
		if (producer !== this.producerId(partition) || partitionId !== BigInt(partition)) {
			this.#reject(
				`Partition ${partition} sequence ${sequence}: wrong producer or partition metadata`
			)
		}
		if (typeof offset !== 'bigint' || offset < 0n) {
			this.#reject(`Partition ${partition} sequence ${sequence}: invalid offset ${offset}`)
		}
		let expected = this.createPayload(partition, sequence)
		for (let i = 0; i < payload.length; i++) {
			if (payload[i] !== expected[i]) {
				this.#reject(
					`Partition ${partition} sequence ${sequence}: payload corruption at byte ${i}`
				)
			}
		}
		if (sequence > state.accepted) {
			this.#reject(`Partition ${partition}: observed unaccepted sequence ${sequence}`)
		}
		let previousOffset = state.offsets.get(sequence)
		if (previousOffset !== undefined) {
			state.duplicates++
			if (previousOffset !== offset) {
				this.#reject(
					`Partition ${partition} sequence ${sequence}: duplicate publication at offsets ${previousOffset} and ${offset}`
				)
			}
			return { partition, sequence }
		}
		state.offsets.set(sequence, offset)
		let expectedSequence = state.nextObserved
		state.nextObserved = Math.max(state.nextObserved, sequence + 1)
		if (sequence !== expectedSequence) {
			this.#reject(
				`Partition ${partition}: ${sequence > expectedSequence ? 'forward gap' : 'reorder'} at sequence ${sequence}, expected ${expectedSequence}`
			)
		}
		if (state.lastOffset !== undefined && offset <= state.lastOffset) {
			this.#reject(
				`Partition ${partition}: offset ${offset} did not advance past ${state.lastOffset}`
			)
		}
		state.lastOffset = offset
		this.#confirmObserved(state)
		return { partition, sequence }
	}

	confirmCommittedOffset(partition: number, committedOffset: bigint): void {
		let state = this.#partition(partition)
		if (typeof committedOffset !== 'bigint' || committedOffset < 0n) {
			this.#reject(`Partition ${partition}: invalid committed offset ${committedOffset}`)
		}
		if (committedOffset <= state.confirmedOffset) {
			return
		}
		state.confirmedOffset = committedOffset
		this.#confirmObserved(state)
	}

	commit(observed: TopicObservation[]): void {
		for (let { partition, sequence } of observed) {
			let state = this.#partition(partition)
			if (!state.offsets.has(sequence)) {
				this.#reject(
					`Partition ${partition}: cannot commit unobserved sequence ${sequence}`
				)
			}
		}
		for (let { partition, sequence } of observed) {
			this.#producers[partition]!.committed.add(sequence)
		}
	}

	fail(reason: string): void {
		this.#failureCount++
		if (this.#errors.length < MAX_ERRORS) {
			this.#errors.push(reason)
		}
	}

	get complete(): boolean {
		return (
			this.#failureCount === 0 &&
			this.#producers.every(
				(state) =>
					state.accepted > 0 &&
					state.acknowledged === state.accepted &&
					state.offsets.size === state.accepted &&
					state.committed.size === state.accepted
			)
		)
	}

	snapshot(): TopicOracleSnapshot {
		let totals: TopicOracleCounts = {
			accepted: 0,
			acknowledged: 0,
			delivered: 0,
			committed: 0,
			duplicates: 0,
		}
		let pending: TopicOraclePending = {
			unacknowledged: 0,
			undelivered: 0,
			uncommitted: 0,
			acknowledgedUndelivered: 0,
			uncertain: 0,
		}
		let producers = this.#producers.map((state, partition) => {
			let counts: TopicOracleCounts = {
				accepted: state.accepted,
				acknowledged: state.acknowledged,
				delivered: state.offsets.size,
				committed: state.committed.size,
				duplicates: state.duplicates,
			}
			let missing: TopicOracleSnapshot['producers'][number]['missing'] = {
				undelivered: [],
				uncommitted: [],
				acknowledgedUndelivered: [],
			}
			let acknowledgedUndelivered = 0
			let uncertain = 0
			for (let sequence = 1; sequence <= state.accepted; sequence++) {
				if (!state.offsets.has(sequence)) {
					if (missing.undelivered.length < MAX_EXAMPLES)
						missing.undelivered.push(sequence)
					if (sequence <= state.acknowledged) {
						acknowledgedUndelivered++
						if (missing.acknowledgedUndelivered.length < MAX_EXAMPLES)
							missing.acknowledgedUndelivered.push(sequence)
					} else {
						uncertain++
					}
				} else if (
					!state.committed.has(sequence) &&
					missing.uncommitted.length < MAX_EXAMPLES
				) {
					missing.uncommitted.push(sequence)
				}
			}
			let waiting: TopicOraclePending = {
				unacknowledged: state.accepted - state.acknowledged,
				undelivered: state.accepted - state.offsets.size,
				uncommitted: state.offsets.size - state.committed.size,
				acknowledgedUndelivered,
				uncertain,
			}
			for (let key of Object.keys(totals) as Array<keyof TopicOracleCounts>)
				totals[key] += counts[key]
			for (let key of Object.keys(pending) as Array<keyof TopicOraclePending>)
				pending[key] += waiting[key]
			return {
				partition,
				producer: this.producerId(partition),
				...counts,
				pending: waiting,
				missing,
			}
		})
		return {
			runId: this.#runId,
			messageBytes: this.#messageBytes,
			complete: this.complete,
			totals,
			pending,
			producers,
			errors: [...this.#errors],
			failureCount: this.#failureCount,
		}
	}

	#partition(partition: number): ProducerState {
		if (!Number.isInteger(partition) || partition < 0 || partition >= this.#producers.length) {
			this.#reject(`Invalid partition ${partition}`)
		}
		return this.#producers[partition]!
	}

	#confirmObserved(state: ProducerState): void {
		// Successful observations are ordered; each record crosses this cursor once.
		// A watermark cannot substitute for observing a missing business sequence.
		for (;;) {
			let offset = state.offsets.get(state.nextConfirmation)
			if (offset === undefined || offset >= state.confirmedOffset) {
				return
			}
			state.committed.add(state.nextConfirmation)
			state.nextConfirmation++
		}
	}

	#sequence(sequence: number): void {
		if (!Number.isSafeInteger(sequence) || sequence <= 0) {
			this.#reject(`Invalid business sequence ${sequence}`)
		}
	}

	#reject(reason: string): never {
		this.fail(reason)
		throw new Error(reason)
	}
}
