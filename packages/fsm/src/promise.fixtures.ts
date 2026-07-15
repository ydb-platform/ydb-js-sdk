// Observe a promise's settlement without consuming it: after pumping microtasks,
// `settled` reports whether it resolved or rejected while the caller still awaits
// the original promise for its value. Replaces the scattered
// `let flag = false; p.then(() => (flag = true))` probe idiom.
export type Settlement = { settled: boolean; rejected: boolean; reason?: unknown }

export let track = function track(promise: Promise<unknown>): Settlement {
	let state: Settlement = { settled: false, rejected: false }
	void (async () => {
		try {
			await promise
		} catch (reason) {
			state.rejected = true
			state.reason = reason
		} finally {
			state.settled = true
		}
	})()
	return state
}
