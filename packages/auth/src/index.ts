/** @typedef {HeadersInit} HeadersInit */

import type { Interceptor } from "@connectrpc/connect";

export abstract class CredentialsProvider {
    constructor() {
        this.interceptor = this.interceptor.bind(this);
    }

    abstract getToken(force?: boolean, signal?: AbortSignal): Promise<string>

    readonly interceptor: Interceptor = (next) => async (req) => {
        req.header.set('x-ydb-auth-ticket', await this.getToken(false, req.signal));

        return next(req);
    }
}
