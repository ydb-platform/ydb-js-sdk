import type { DriverIdentity } from '@ydbjs/core'

/** A database commit position returned by a StrictSerializableRW write transaction. */
export interface VirtualTimestamp {
	readonly planStep: bigint
	readonly txId: bigint
	/** Compare commit positions obtained through the same Driver. */
	compare(other: VirtualTimestamp): number
}

class DriverVirtualTimestamp implements VirtualTimestamp {
	readonly planStep: bigint
	readonly txId: bigint
	readonly #driver: DriverIdentity

	constructor(value: { planStep: bigint; txId: bigint }, driver: DriverIdentity) {
		let maxUint64 = (1n << 64n) - 1n
		if (
			value.planStep < 0n ||
			value.planStep > maxUint64 ||
			value.txId < 0n ||
			value.txId > maxUint64
		) {
			throw new RangeError('VirtualTimestamp fields must be uint64 values')
		}
		this.planStep = value.planStep
		this.txId = value.txId
		this.#driver = driver
		Object.freeze(this)
	}

	compare(other: VirtualTimestamp): number {
		if (!(other instanceof DriverVirtualTimestamp) || this.#driver !== other.#driver) {
			throw new Error('VirtualTimestamp values must come from the same Driver')
		}
		if (this.planStep !== other.planStep) return this.planStep < other.planStep ? -1 : 1
		if (this.txId !== other.txId) return this.txId < other.txId ? -1 : 1
		return 0
	}
}

export function virtualTimestampFromProto(
	value: { planStep: bigint; txId: bigint } | undefined,
	driver: DriverIdentity
): VirtualTimestamp | undefined {
	return value ? new DriverVirtualTimestamp(value, driver) : undefined
}
