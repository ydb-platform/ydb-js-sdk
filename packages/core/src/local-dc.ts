import type { EndpointInfo } from '@ydbjs/api/discovery'
import { loggers } from '@ydbjs/debug'
import { measureFastest } from './rtt.js'

let dbg = loggers.driver.extend('local-dc')

const MAX_ENDPOINTS_PER_LOCATION = 5

/**
 * Group endpoints by location (DC)
 */
function groupByLocation(
	endpoints: EndpointInfo[]
): Map<string, EndpointInfo[]> {
	let groups = new Map<string, EndpointInfo[]>()

	for (let endpoint of endpoints) {
		let location = endpoint.location
		let group = groups.get(location) ?? []
		group.push(endpoint)
		groups.set(location, group)
	}

	return groups
}

/**
 * Shuffle array in place
 */
function shuffle<T>(array: T[]): T[] {
	for (let i = array.length - 1; i > 0; --i) {
		let j = Math.floor(Math.random() * (i + 1))
		let tmp = array[i]!
		array[i] = array[j]!
		array[j] = tmp
	}
	return array
}

/**
 * Get random sample of endpoints
 */
function sampleEndpoints(
	endpoints: EndpointInfo[],
	count: number
): EndpointInfo[] {
	if (endpoints.length <= count) {
		return endpoints
	}

	return shuffle([...endpoints]).slice(0, count)
}

/**
 * Detect local DC by measuring RTT to endpoints
 *
 * Algorithm:
 * 1. Group endpoints by location
 * 2. If only 1 location → return it
 * 3. Sample up to 5 endpoints per location
 * 4. Race TCP connections to all sampled endpoints
 * 5. Return location of fastest endpoint
 *
 * @param endpoints - List of YDB endpoints
 * @param timeoutMs - Connection timeout in milliseconds
 * @returns Promise with detected local DC location or null
 *
 * @example
 * ```typescript
 * let localDC = await detectLocalDC(endpoints, 5000)
 * if (localDC) {
 *     console.log(`Local DC: ${localDC}`)
 * }
 * ```
 */
export async function detectLocalDC(
	endpoints: EndpointInfo[],
	timeoutMs: number = 5000
): Promise<string | null> {
	if (endpoints.length === 0) {
		dbg.log('no endpoints to detect local DC')
		return null
	}

	let groups = groupByLocation(endpoints)

	dbg.log(
		'grouped endpoints by location: %O',
		Array.from(groups.entries()).map(
			([loc, eps]) => `${loc}: ${eps.length} endpoints`
		)
	)

	if (groups.size === 1) {
		let location = Array.from(groups.keys())[0]!
		dbg.log('only one location found: %s', location)
		return location
	}

	let sampled: EndpointInfo[] = []
	for (let [location, locationEndpoints] of groups) {
		let sample = sampleEndpoints(
			locationEndpoints,
			MAX_ENDPOINTS_PER_LOCATION
		)
		dbg.log('sampled %d endpoints from %s', sample.length, location)
		sampled.push(...sample)
	}

	dbg.log('measuring RTT to %d endpoints', sampled.length)

	try {
		let fastest = await measureFastest(sampled, timeoutMs)
		let localDC = fastest.location

		dbg.log(
			'detected local DC: %s (fastest endpoint: %s:%d)',
			localDC,
			fastest.address,
			fastest.port
		)

		return localDC
	} catch (error) {
		dbg.log('failed to detect local DC: %O', error)
		return null
	}
}
