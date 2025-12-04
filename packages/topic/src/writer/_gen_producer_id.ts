export const _get_producer_id = function get_producer_id() {
	let processId = process.pid
	let currentTime = new Date().getTime()
	let randomSuffix = Math.floor(Math.random() * 1_000_000)
	return `producer-${processId}-${currentTime}-${randomSuffix}`
}
