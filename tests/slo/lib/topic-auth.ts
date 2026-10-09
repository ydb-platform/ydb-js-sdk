import { StatusIds_StatusCode } from '@ydbjs/api/operation'

import { StaticCredentialsProvider } from '@ydbjs/auth/static'
import { getSecureOptionsFromEnviron } from '@ydbjs/auth/environ'
import { type DriverOptions, addClientMiddleware } from '@ydbjs/core'

export class TokenRenewal {
	updates = 0
	changes = 0
	#lastToken: string | undefined
	#firstExpiry = Infinity
	#lastResponse = 0

	sent(token: string, now = Date.now()): void {
		let expiry: number
		try {
			expiry =
				Number(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).exp) *
				1000
		} catch {
			throw new Error('Token renewal requires a JWT with an expiry')
		}

		if (!Number.isFinite(expiry) || expiry <= now || expiry - now > 10 * 60_000) {
			throw new Error('Token renewal requires valid tokens with at most 10 minutes remaining')
		}

		this.#firstExpiry = Math.min(this.#firstExpiry, expiry)
		this.#lastToken ??= token
	}

	acknowledge(token: string, now = Date.now()): void {
		this.sent(token, now)
		this.updates++

		if (this.#lastToken !== undefined && this.#lastToken !== token) {
			this.changes++
		}

		this.#lastToken = token
	}

	observe(now = Date.now()): void {
		this.#lastResponse = now
	}

	qualified(): boolean {
		return this.changes > 0 && this.#lastResponse >= this.#firstExpiry
	}
}

export function createTopicAuth(connectionString: string, enabled: boolean) {
	let options: DriverOptions = {}
	let streams = new Set<TokenRenewal>()
	let completed = { streams: 0, renewed: 0, updates: 0, changes: 0 }
	let registration: Disposable | undefined

	if (enabled) {
		let secureOptions = /^grpcs:|^https:/.test(connectionString)
			? getSecureOptionsFromEnviron()
			: undefined
		options = {
			secureOptions,
			credentialsProvider: new StaticCredentialsProvider(
				{ username: 'root', password: '' },
				connectionString,
				secureOptions
			),
		}

		registration = addClientMiddleware(async function* (call, callOptions) {
			if (
				!call.requestStream ||
				!call.responseStream ||
				!/\/Stream(Read|Write)$/.test(call.method.path)
			) {
				return yield* call.next(call.request, callOptions)
			}

			let renewal = new TokenRenewal()
			streams.add(renewal)
			let input = call.request
			let pendingToken: string | undefined

			async function* requests() {
				for await (let request of input) {
					let frame = request as {
						clientMessage?: { case?: string; value?: { token?: string } }
					}
					if (frame.clientMessage?.case === 'updateTokenRequest') {
						pendingToken = frame.clientMessage.value?.token
						if (!pendingToken) {
							throw new Error('Token renewal requires a non-empty token')
						}
						renewal.sent(pendingToken)
					}
					yield request
				}
			}

			try {
				for await (let response of call.next(requests(), callOptions)) {
					let frame = response as { status?: number; serverMessage?: { case?: string } }
					if (
						frame.status === StatusIds_StatusCode.SUCCESS &&
						['readResponse', 'writeResponse'].includes(frame.serverMessage?.case ?? '')
					) {
						renewal.observe()
					}
					if (
						frame.status === StatusIds_StatusCode.SUCCESS &&
						frame.serverMessage?.case === 'updateTokenResponse'
					) {
						if (!pendingToken) {
							throw new Error('Token update acknowledged without a non-empty token')
						}
						renewal.acknowledge(pendingToken)
						pendingToken = undefined
					}
					yield response
				}
			} finally {
				completed.streams++
				completed.renewed += Number(renewal.qualified())
				completed.updates += renewal.updates
				completed.changes += renewal.changes
				streams.delete(renewal)
			}
		})
	}

	return {
		options,
		finish() {
			if (!enabled) {
				return undefined
			}

			let result = { ...completed }
			for (let stream of streams) {
				result.streams++
				result.renewed += Number(stream.qualified())
				result.updates += stream.updates
				result.changes += stream.changes
			}
			if (result.renewed === 0) {
				throw new Error(
					`No stream accepted a changed token and continued past the old token expiry: ${JSON.stringify(result)}`
				)
			}
			return result
		},
		[Symbol.dispose]() {
			registration?.[Symbol.dispose]()
		},
	}
}
