import { anyUnpack } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type Client, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AuthService, createAuthServiceClient, LoginResultSchema } from "@ydbjs/api/auth";
import { StatusIds_StatusCode } from "@ydbjs/api/operation";

import { CredentialsProvider } from "./index.ts";

export type StaticCredentialsToken = {
	value: string
	aud: string[]
	exp: number
	iat: number
	sub: string
}

export type StaticCredentials = {
	// TODO: support read from file
	// source: 'file' | 'inline'
	username: string
	password: string
}

export class StaticCredentialsProvider extends CredentialsProvider {
	#client: Client<typeof AuthService>
	#promise: Promise<string> | null = null

	#token: StaticCredentialsToken | null = null
	#username: string
	#password: string

	constructor(credentials: StaticCredentials, endpointOrTransport: string | Transport) {
		super();
		this.#username = credentials.username;
		this.#password = credentials.password;

		if (typeof endpointOrTransport === 'string') {
			let url = new URL(endpointOrTransport.replace(/^grpc/, 'http'));

			endpointOrTransport = createGrpcTransport({ baseUrl: url.origin })
		}

		this.#client = createAuthServiceClient(endpointOrTransport);
	}

	async getToken(force = false, signal?: AbortSignal): Promise<string> {
		if (!force && this.#token && this.#token.exp > Date.now() / 1000) {
			return this.#token.value;
		}

		if (this.#promise) {
			return this.#promise;
		}

		this.#promise = (async () => {
			let response = await this.#client.login({
				user: this.#username,
				password: this.#password
			}, { signal });

			if (!response.operation) {
				throw ConnectError.from('No operation in response', Code.DataLoss);
			}

			if (response.operation.status !== StatusIds_StatusCode.SUCCESS) {
				throw new Error(`(${response.operation.status}) ${JSON.stringify(response.operation.issues)}`);
			}

			let result = anyUnpack(response.operation.result!, LoginResultSchema);
			if (!result) {
				throw ConnectError.from('No result in operation', Code.DataLoss);
			}

			// Parse the JWT token to extract expiration time
			const [, payload] = result.token.split('.');
			const decodedPayload = JSON.parse(Buffer.from(payload, 'base64').toString());

			this.#token = {
				value: result.token,
				...decodedPayload
			};

			return this.#token!.value!;
		})().finally(() => {
			this.#promise = null;
		})

		return this.#promise;
	}
}
