// Generates a unique producer id when the caller does not supply one. The
// producer id + seqNo form the server-side dedup key, so it must be stable for
// the lifetime of one writer but distinct across writers.
export const generateProducerId = function generateProducerId(): string {
	let processId = process.pid
	let currentTime = new Date().getTime()
	let randomSuffix = Math.floor(Math.random() * 1_000_000)
	return `producer-${processId}-${currentTime}-${randomSuffix}`
}
