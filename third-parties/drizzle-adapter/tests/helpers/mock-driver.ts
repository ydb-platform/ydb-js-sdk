import { Driver, kRegisterLibrary } from '@ydbjs/core'

// Object.create(Driver.prototype) skips constructor → no private fields.
// Driver.prototype[kRegisterLibrary] reads #libraries, so YdbDriver's
// constructor would TypeError on such a mock. Stub the symbol to no-op.
export function createBorrowedDriverStub(): Driver {
	let stub = Object.create(Driver.prototype) as Driver
	;(stub as unknown as Record<symbol, unknown>)[kRegisterLibrary] = () => {}
	return stub
}

export type MockQueryCall = {
	text: string
	params: Array<{ name: string; value: unknown }>
	valuesRows: unknown[]
	executeRows: unknown[]
}

export function createMockQueryFunction(executeRows: unknown[], valuesRows = executeRows) {
	let calls: MockQueryCall[] = []

	let ql = ((text: string) => {
		let call: MockQueryCall = {
			text,
			params: [],
			executeRows,
			valuesRows,
		}
		calls.push(call)

		let queryObject: {
			parameter(name: string, value: unknown): typeof queryObject
			values(): Promise<unknown[][]>
			then<TResult1 = unknown[][], TResult2 = never>(
				onfulfilled?: ((value: unknown[][]) => TResult1 | PromiseLike<TResult1>) | null,
				onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
			): Promise<TResult1 | TResult2>
		} = {
			parameter(name: string, value: unknown) {
				call.params.push({ name, value })
				return queryObject
			},
			async values() {
				return [call.valuesRows as unknown[]]
			},
			then(onfulfilled, onrejected) {
				return Promise.resolve([call.executeRows as unknown[]]).then(
					onfulfilled,
					onrejected
				)
			},
		}

		return queryObject
	}) as any

	return { ql, calls }
}
