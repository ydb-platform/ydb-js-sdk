import { Socket } from 'node:net'
import type { EndpointInfo } from '@ydbjs/api/discovery'
import { loggers } from '@ydbjs/debug'

let dbg = loggers.driver.extend('rtt')

export interface RTTResult {
	endpoint: EndpointInfo
	rtt: number
	error?: Error
}

/**
 * Measure TCP connection time (RTT) to an endpoint
 *
 * @param endpoint - YDB endpoint to measure
 * @param timeoutMs - Connection timeout in milliseconds
 * @param signal - AbortSignal to cancel the measurement
 * @returns Promise with RTT result
 *
 * @example
 * ```typescript
 * let result = await measureTCPRTT(endpoint, 5000)
 * if (!result.error) {
 *     console.log(`RTT: ${result.rtt}ms`)
 * }
 * ```
 */
export function measureTCPRTT(
	endpoint: EndpointInfo,
	timeoutMs: number = 5000,
	signal?: AbortSignal
): Promise<RTTResult> {
	return new Promise((resolve) => {
		let start = performance.now()
		let socket = new Socket()

		let done = (result: RTTResult) => {
			signal?.removeEventListener('abort', onAbort)
			socket.destroy()
			resolve(result)
		}

		let onAbort = () => {
			dbg.log(
				'aborted connection to %s:%d',
				endpoint.address,
				endpoint.port
			)
			done({
				endpoint,
				rtt: Infinity,
				error: new Error('Aborted'),
			})
		}

		if (signal?.aborted) {
			return onAbort()
		}

		socket.once('connect', () => {
			let rtt = performance.now() - start
			dbg.log(
				'connected to %s:%d in %dms',
				endpoint.address,
				endpoint.port,
				rtt.toFixed(2)
			)
			done({ endpoint, rtt })
		})

		socket.once('error', (err) => {
			dbg.log(
				'error connecting to %s:%d: %O',
				endpoint.address,
				endpoint.port,
				err
			)
			done({ endpoint, rtt: Infinity, error: err as Error })
		})

		socket.setTimeout(timeoutMs)
		socket.once('timeout', () => {
			dbg.log(
				'timeout connecting to %s:%d',
				endpoint.address,
				endpoint.port
			)
			done({
				endpoint,
				rtt: Infinity,
				error: new Error('Connection timeout'),
			})
		})

		signal?.addEventListener('abort', onAbort, { once: true })

		dbg.log('measuring RTT to %s:%d', endpoint.address, endpoint.port)

		socket.connect(endpoint.port, endpoint.address)
	})
}

/**
 * Race TCP connections to multiple endpoints and return the fastest
 *
 * @param endpoints - List of YDB endpoints to test
 * @param timeoutMs - Connection timeout in milliseconds
 * @returns Promise with the fastest endpoint
 *
 * @example
 * ```typescript
 * let fastest = await measureFastest(endpoints, 5000)
 * console.log(`Fastest: ${fastest.address}:${fastest.port}`)
 * ```
 */
export async function measureFastest(
	endpoints: EndpointInfo[],
	timeoutMs: number = 5000
): Promise<EndpointInfo> {
	if (endpoints.length === 0) {
		throw new Error('No endpoints to measure')
	}

	dbg.log('racing %d endpoints', endpoints.length)

	let controller = new AbortController()

	let promises = endpoints.map(async (endpoint) => {
		let result = await measureTCPRTT(endpoint, timeoutMs, controller.signal)

		if (!result.error && result.rtt < Infinity) {
			controller.abort()
			return result
		}

		throw result.error || new Error('Failed to measure RTT')
	})

	try {
		let fastest = await Promise.any(promises)
		dbg.log(
			'fastest endpoint: %s:%d (RTT: %dms)',
			fastest.endpoint.address,
			fastest.endpoint.port,
			fastest.rtt.toFixed(2)
		)
		return fastest.endpoint
	} catch (error) {
		dbg.log('all endpoints failed: %O', error)
		throw new Error('Failed to connect to any endpoint', { cause: error })
	}
}
