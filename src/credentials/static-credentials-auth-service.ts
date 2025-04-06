import { Ydb } from "ydb-sdk-proto";
import AuthServiceResult = Ydb.Auth.LoginResult;
import { ISslCredentials } from "../utils/ssl-credentials";
import { GrpcService, withTimeout } from "../utils";
import { retryable } from "../retries_obsoleted";
import { getOperationPayload } from "../utils/process-ydb-operation-result";
import * as grpc from "@grpc/grpc-js";
import { addCredentialsToMetadata } from "./add-credentials-to-metadata";

import { IAuthService } from "./i-auth-service";
import { HasLogger } from "../logger/has-logger";
import { Logger } from "../logger/simple-logger";
import { getDefaultLogger } from "../logger/get-default-logger";

/**
 * Static credentials token.
 */
export type StaticCredentialsToken = {
    value: string
    aud: string[]
    exp: number
    iat: number
    sub: string
}

/**
 * Interface for options used in static credentials authentication.
 */
interface StaticCredentialsAuthOptions {
    /** Custom SSL certificates. If you use it in driver, you must use it here too */
    sslCredentials?: ISslCredentials;

    /**
     * Timeout for token request in milliseconds
     * @default 10 * 1000
     */
    tokenRequestTimeout?: number;

    /**
     * Expiration time for token in milliseconds
     * @deprecated Use tokenRefreshInterval instead
     * @default 6 * 60 * 60 * 1000
     */
    tokenExpirationTimeout?: number;

    /**
     * Time interval in milliseconds after which the token will be refreshed.
     * When specified, token refresh is based on this timer rather than the token's exp field.
     */
    tokenRefreshInterval?: number;
}

class StaticCredentialsGrpcService extends GrpcService<Ydb.Auth.V1.AuthService> implements HasLogger {
    constructor(endpoint: string, sslCredentials?: ISslCredentials, public readonly logger: Logger = getDefaultLogger()) {
        super(endpoint, 'Ydb.Auth.V1.AuthService', Ydb.Auth.V1.AuthService, sslCredentials);
    }

    @retryable()
    login(request: Ydb.Auth.ILoginRequest) {
        return this.api.login(request);
    }

    destroy() {
        this.api.end();
    }
}

export class StaticCredentialsAuthService implements IAuthService {
    private readonly tokenRequestTimeout = 10 * 1000;
    private readonly tokenRefreshInterval: number | null = null;

    private readonly user: string;
    private readonly password: string;
    private readonly endpoint: string;
    private readonly sslCredentials: ISslCredentials | undefined;

    public readonly logger: Logger;

    private token: StaticCredentialsToken | null = null;
    // Mutex
    private promise: Promise<grpc.Metadata> | null = null;

    constructor(
        user: string,
        password: string,
        endpoint: string,
        options?: StaticCredentialsAuthOptions
    );
    constructor(
        user: string,
        password: string,
        endpoint: string,
        loggerOrOptions: Logger | StaticCredentialsAuthOptions,
        options?: StaticCredentialsAuthOptions
    );
    constructor(
        user: string,
        password: string,
        endpoint: string,
        loggerOrOptions?: Logger | StaticCredentialsAuthOptions,
        options?: StaticCredentialsAuthOptions
    ) {
        this.user = user;
        this.password = password;
        this.endpoint = endpoint;
        this.sslCredentials = options?.sslCredentials;

        if (typeof loggerOrOptions === 'object' && loggerOrOptions !== null && 'error' in loggerOrOptions) {
            this.logger = loggerOrOptions as Logger;
        } else {
            options = loggerOrOptions;
            this.logger = getDefaultLogger();
        }

        if (options?.tokenRequestTimeout) this.tokenRequestTimeout = options.tokenRequestTimeout;
        if (options?.tokenExpirationTimeout) this.tokenRefreshInterval = options.tokenExpirationTimeout;
        if (options?.tokenRefreshInterval) this.tokenRefreshInterval = options.tokenRefreshInterval;

        if (this.tokenRefreshInterval) {
            let timer = setInterval(() => {
                if (this.promise) {
                    return
                }

                this.promise = this.updateToken()
                    .then(token => addCredentialsToMetadata(token.value))
                    .finally(() => {
                        this.promise = null;
                    })
            }, this.tokenRefreshInterval);

            timer.unref()
        }
    }

    private async sendTokenRequest(): Promise<AuthServiceResult> {
        let runtimeAuthService = new StaticCredentialsGrpcService(
            this.endpoint,
            this.sslCredentials,
            this.logger,
        );

        const tokenPromise = runtimeAuthService.login({
            user: this.user,
            password: this.password,
        });

        const response = await withTimeout(tokenPromise, this.tokenRequestTimeout);
        const result = AuthServiceResult.decode(getOperationPayload(response));
        runtimeAuthService.destroy();

        return result;
    }

    private async updateToken(): Promise<StaticCredentialsToken> {
        const { token } = await this.sendTokenRequest();
        if (!token) {
            throw new Error('Received empty token from static credentials!');
        }

        // Parse the JWT token to extract expiration time
        const [, payload] = token.split('.');
        const decodedPayload = JSON.parse(Buffer.from(payload, 'base64').toString());

        this.token = {
            value: token,
            ...decodedPayload
        };

        return this.token!
    }

    public async getAuthMetadata(): Promise<grpc.Metadata> {
        if (this.token && this.token.exp > Date.now() / 1000) {
            return addCredentialsToMetadata(this.token.value)
        }

        if (this.promise) {
            return this.promise;
        }

        this.promise = this.updateToken()
            .then(token => addCredentialsToMetadata(token.value))
            .finally(() => {
                this.promise = null;
            })

        return this.promise
    }
}
