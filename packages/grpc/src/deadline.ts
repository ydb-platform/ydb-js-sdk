import { RpcError, Status } from './error.js'

export interface Deadline extends Disposable {
	readonly signal: AbortSignal
}

export function createDeadline(value?: number | Date): Deadline | undefined {
	let expiresAt = value === undefined ? Infinity : Number(value)
	if (Number.isNaN(expiresAt)) {
		throw new RangeError('Invalid RPC deadline')
	}
	if (expiresAt === Infinity) {
		return undefined
	}

	let controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	let check = () => {
		let remaining = expiresAt - Date.now()
		if (remaining <= 0) {
			controller.abort(new RpcError(Status.DEADLINE_EXCEEDED, 'Deadline exceeded'))
		} else {
			timer = setTimeout(check, Math.min(remaining, 2147483647)).unref()
		}
	}
	check()

	return {
		signal: controller.signal,
		[Symbol.dispose]() {
			clearTimeout(timer)
		},
	}
}
