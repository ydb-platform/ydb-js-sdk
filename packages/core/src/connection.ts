import { checkServerIdentity } from "node:tls";

import type { Interceptor, Transport } from "@connectrpc/connect";
import { createGrpcTransport, type GrpcTransportOptions } from "@connectrpc/connect-node";
import { headerGrpcStatus } from "@connectrpc/connect/protocol-grpc";
import type { EndpointInfo } from "@ydbjs/api/discovery";

import { nodeIdKey } from "./context.js";
import { dbg } from "./dbg.js";
import { withHooks } from "./interceptors/with-hooks.js";

export interface Connection {
    readonly endpoint: EndpointInfo;
    readonly transport: Transport;
    pessimizedUntil?: number;
}

export class LazyConnection implements Connection {
    #options: GrpcTransportOptions;
    #transport: Transport | null = null;

    endpoint: EndpointInfo;
    pessimizedUntil: number = 0;

    constructor(endpoint: EndpointInfo, options: Omit<GrpcTransportOptions, 'baseUrl'>) {
        this.endpoint = endpoint;

        this.#options = {
            ...options,
            baseUrl: this.endpoint.ssl ? `https://${endpoint.address}:${endpoint.port}` : `http://${endpoint.address}:${endpoint.port}`,
            nodeOptions: {
                ...options.nodeOptions,
                checkServerIdentity(hostname, cert) {
                    return checkServerIdentity(endpoint.sslTargetNameOverride || hostname, cert);
                },
            },
            interceptors: [...options.interceptors || []]
        };

        this.#options.interceptors!.unshift(this.#debug)
        this.#options.interceptors!.unshift(this.#markNodeId)
    }

    get transport(): Transport {
        if (this.#transport === null) {
            dbg.extend("conn")('create transport to node id=%d address=%s:%d', this.endpoint.nodeId, this.endpoint.address, this.endpoint.port);

            this.#transport = createGrpcTransport(this.#options);
        }

        return this.#transport;
    };

    #markNodeId: Interceptor = (next) => {
        return async (req) => {
            req.contextValues.set(nodeIdKey, this.endpoint.nodeId);
            return next(req);
        }
    }

    #debug: Interceptor = (next) => {
        return async (req) => {
            let res = await next(req);

            if (!res.stream) {
                dbg.extend("grpc")('%s/%s', req.service.typeName, req.method.name, res.trailer.get(headerGrpcStatus));

                return res;
            }

            return {
                ...res,
                message: withHooks(res, {
                    onTailer: (trailer) => {
                        dbg.extend("grpc")('%s/%s', req.service.typeName, req.method.name, trailer.get(headerGrpcStatus));
                    }
                })
            }
        }
    }
}
