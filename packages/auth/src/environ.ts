import * as fs from 'node:fs'
import * as tls from 'node:tls'

import { loggers } from '@ydbjs/debug'

import { AccessTokenCredentialsProvider } from './access-token.js'
import { AnonymousCredentialsProvider } from './anonymous.js'
import { CredentialsProvider } from './index.js'
import { MetadataCredentialsProvider } from './metadata.js'
import { StaticCredentialsProvider } from './static.js'

let debug = loggers.auth.extend('environ')

/**
 * Reads TLS/SSL configuration from environment variables.
 *
 * Supported variables:
 * - CA: `YDB_SSL_ROOT_CERTIFICATES_FILE` (file path) or `NODE_EXTRA_CA_CERTS` (file path)
 *       or `YDB_SSL_ROOT_CERTIFICATES` (PEM string)
 * - Client cert: `YDB_SSL_CERTIFICATE_FILE` (file path) or `YDB_SSL_CERTIFICATE` (PEM string)
 * - Client key: `YDB_SSL_PRIVATE_KEY_FILE` (file path) or `YDB_SSL_PRIVATE_KEY` (PEM string)
 *
 * File variants take priority over string variants.
 *
 * @returns `tls.SecureContextOptions` if any TLS env vars are set, `undefined` otherwise.
 */
export function getSecureOptionsFromEnviron(): tls.SecureContextOptions | undefined {
	let caFile = process.env.YDB_SSL_ROOT_CERTIFICATES_FILE ?? process.env.NODE_EXTRA_CA_CERTS
	let crtFile = process.env.YDB_SSL_CERTIFICATE_FILE
	let keyFile = process.env.YDB_SSL_PRIVATE_KEY_FILE

	let caString = process.env.YDB_SSL_ROOT_CERTIFICATES
	let crtString = process.env.YDB_SSL_CERTIFICATE
	let keyString = process.env.YDB_SSL_PRIVATE_KEY

	if (!caFile && !crtFile && !keyFile && !caString && !crtString && !keyString) {
		return undefined
	}

	if (caFile && caString) {
		throw new Error(
			'Ambiguous CA configuration: both YDB_SSL_ROOT_CERTIFICATES_FILE (or NODE_EXTRA_CA_CERTS) and YDB_SSL_ROOT_CERTIFICATES are set. Use only one.'
		)
	}

	if (crtFile && crtString) {
		throw new Error(
			'Ambiguous client certificate configuration: both YDB_SSL_CERTIFICATE_FILE and YDB_SSL_CERTIFICATE are set. Use only one.'
		)
	}

	if (keyFile && keyString) {
		throw new Error(
			'Ambiguous private key configuration: both YDB_SSL_PRIVATE_KEY_FILE and YDB_SSL_PRIVATE_KEY are set. Use only one.'
		)
	}

	let options: tls.SecureContextOptions = {}

	if (caFile) {
		debug.log('reading CA certificate from %s', caFile)
		options.ca = fs.readFileSync(caFile)
	} else if (caString) {
		debug.log('using CA certificate from env string')
		options.ca = caString
	}

	if (crtFile) {
		debug.log('reading client certificate from %s', crtFile)
		options.cert = fs.readFileSync(crtFile)
	} else if (crtString) {
		debug.log('using client certificate from env string')
		options.cert = crtString
	}

	if (keyFile) {
		debug.log('reading client private key from %s', keyFile)
		options.key = fs.readFileSync(keyFile)
	} else if (keyString) {
		debug.log('using client private key from env string')
		options.key = keyString
	}

	return options
}

/**
 * A credentials provider that auto-detects the authentication method
 * from environment variables, following the official YDB SDK conventions.
 *
 * Detection priority (first match wins):
 * 1. `YDB_ANONYMOUS_CREDENTIALS=1` → Anonymous
 * 2. `YDB_METADATA_CREDENTIALS=1` → Metadata
 *    - `YDB_METADATA_CREDENTIALS_ENDPOINT` — custom metadata endpoint
 *    - `YDB_METADATA_CREDENTIALS_FLAVOR` — custom metadata flavor (e.g. `Google`)
 * 3. `YDB_ACCESS_TOKEN_CREDENTIALS` → Access Token
 * 4. `YDB_STATIC_CREDENTIALS_USER` → Static (username/password)
 * 5. None → Anonymous
 *
 * TLS/SSL is auto-detected from environment variables and exposed via `secureOptions`:
 * - `YDB_SSL_ROOT_CERTIFICATES_FILE` / `NODE_EXTRA_CA_CERTS` (file) or `YDB_SSL_ROOT_CERTIFICATES` (PEM string)
 * - `YDB_SSL_CERTIFICATE_FILE` (file) or `YDB_SSL_CERTIFICATE` (PEM string)
 * - `YDB_SSL_PRIVATE_KEY_FILE` (file) or `YDB_SSL_PRIVATE_KEY` (PEM string)
 *
 * @example
 * ```ts
 * import { EnvironCredentialsProvider } from '@ydbjs/auth/environ'
 *
 * let creds = new EnvironCredentialsProvider(connectionString)
 * let driver = new Driver(connectionString, {
 *   credentialsProvider: creds,
 *   secureOptions: creds.secureOptions,
 * })
 * ```
 */
export class EnvironCredentialsProvider extends CredentialsProvider {
	#inner: CredentialsProvider

	/**
	 * TLS/SSL options detected from environment variables.
	 * Pass this to `Driver` as `secureOptions`.
	 */
	readonly secureOptions: tls.SecureContextOptions | undefined

	constructor(connectionString?: string) {
		super()

		this.secureOptions = getSecureOptionsFromEnviron()
		this.#inner = this.#detect(connectionString)

		debug.log(
			'detected credentials provider: %s, secureOptions: %s',
			this.#inner.constructor.name,
			this.secureOptions ? 'yes' : 'no'
		)
	}

	async getToken(force?: boolean, signal?: AbortSignal): Promise<string> {
		return this.#inner.getToken(force, signal)
	}

	#detect(connectionString?: string): CredentialsProvider {
		if (process.env.YDB_ANONYMOUS_CREDENTIALS === '1') {
			debug.log('YDB_ANONYMOUS_CREDENTIALS=1, using anonymous auth')
			return new AnonymousCredentialsProvider()
		}

		if (process.env.YDB_METADATA_CREDENTIALS === '1') {
			let endpoint = process.env.YDB_METADATA_CREDENTIALS_ENDPOINT
			let flavor = process.env.YDB_METADATA_CREDENTIALS_FLAVOR

			debug.log(
				'YDB_METADATA_CREDENTIALS=1, using metadata auth (endpoint: %s, flavor: %s)',
				endpoint ?? 'default',
				flavor ?? 'default'
			)

			return new MetadataCredentialsProvider({
				...(endpoint && { endpoint }),
				...(flavor && { flavor }),
			})
		}

		if (process.env.YDB_ACCESS_TOKEN_CREDENTIALS) {
			debug.log('YDB_ACCESS_TOKEN_CREDENTIALS is set, using access token auth')
			return new AccessTokenCredentialsProvider({
				token: process.env.YDB_ACCESS_TOKEN_CREDENTIALS,
			})
		}

		if (process.env.YDB_STATIC_CREDENTIALS_USER) {
			let username = process.env.YDB_STATIC_CREDENTIALS_USER
			let password = process.env.YDB_STATIC_CREDENTIALS_PASSWORD ?? ''

			let endpoint = process.env.YDB_STATIC_CREDENTIALS_ENDPOINT
			if (!endpoint) {
				if (!connectionString) {
					throw new Error(
						'YDB_STATIC_CREDENTIALS_ENDPOINT is not set and no connection string was provided. ' +
							'Either set YDB_STATIC_CREDENTIALS_ENDPOINT or pass the connection string to EnvironCredentialsProvider.'
					)
				}

				endpoint = new URL('/', connectionString).href
			}

			debug.log(
				'YDB_STATIC_CREDENTIALS_USER is set, using static credentials for user: %s, endpoint: %s',
				username,
				endpoint
			)

			return new StaticCredentialsProvider(
				{ username, password },
				endpoint,
				this.secureOptions
			)
		}

		debug.log('no credentials env vars detected, using anonymous auth')
		return new AnonymousCredentialsProvider()
	}
}
