import { importPKCS8, SignJWT, type CryptoKey } from 'jose'
import { CredentialsProvider } from './index.js'

export type AuthorizedKeyCredentials = {
	// TODO: support read from file
	// source: 'file' | 'inline'
	token: string
}

/**
 * Provides access by generating IAM tokens via Authorization Key for YandexCloud Services accounts.
 * @class AuthorizedKeyCredentialsProvider
 * @extends CredentialsProvider
 */
export class AuthorizedKeyCredentialsProvider extends CredentialsProvider {
	private token: string

	private expiresAt = 0
	private privateKey: CryptoKey | null = null
	private endpoint = 'https://iam.api.cloud.yandex.net/iam/v1/tokens'

	constructor(credentials: AuthorizedKeyCredentials) {
		super()
		this.token = credentials.token
	}

	/**
	 * Returns the token from the credentials.
	 * @param force - ignored
	 * @param signal - ignored
	 * @returns the token
	 */
	async getToken(force?: boolean): Promise<string> {
		const now = Date.now() / 1000

		if (this.token && now < this.expiresAt && !force) {
			return this.token
		}

		// Load SA key from env (assume it's a JSON string)
		const saKeyJson = process.env.YDB_SA_KEY_JSON

		if (!saKeyJson) {
			throw new Error('YDB_SA_KEY_JSON not set in environment')
		}

		const saKey: {
			service_account_id: string
			id: string
			private_key: string
		} = JSON.parse(saKeyJson)

		const { service_account_id: serviceAccountId, id: keyId } = saKey

		let privateKey = saKey.private_key

		/* Yandex Cloud generates private private key which contains text with service account id.
		 * When trying to use importPKCS8 with this line, we get the error */

		privateKey = privateKey.replace(/^PLEASE DO NOT REMOVE THIS LINE! Yandex\.Cloud SA Key ID .*\n?/, '')

		if (!this.privateKey) {
			this.privateKey = await importPKCS8(privateKey, 'PS256')
		}

		const jwtPayload = {
			aud: this.endpoint,
			iss: serviceAccountId,
			iat: now,
			exp: now + 3600, // 1 hour
		}

		const signedJwt = await new SignJWT(jwtPayload)
			.setProtectedHeader({ alg: 'PS256', kid: keyId })
			.sign(this.privateKey)

		// Exchange JWT for IAM token
		const response = await fetch(this.endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jwt: signedJwt }),
		})

		if (!response.ok) {
			throw new Error(`Failed to get IAM token: ${response.statusText}`)
		}

		const responseData = (await response.json()) as {
			iamToken: string
			expiresAt: string
		}

		const { iamToken, expiresAt: tokenExpiresAt } = responseData

		this.token = iamToken
		this.expiresAt = new Date(tokenExpiresAt).getTime() / 1000

		return iamToken
	}
}
