import type { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { ClientError, Status } from 'nice-grpc'

import { formatTraceparent } from './traceparent.js'

export { formatTraceparent }

export let DB_SYSTEM = 'ydb'

export let SPAN_NAMES = {
	DriverInit: 'ydb.DriverInit',
	Discovery: 'ydb.Discovery',
	AcquireSession: 'ydb.AcquireSession',
	CreateSession: 'ydb.CreateSession',
	ExecuteQuery: 'ydb.ExecuteQuery',
	Commit: 'ydb.Commit',
	Rollback: 'ydb.Rollback',
	Transaction: 'ydb.Transaction',
	RunWithRetry: 'ydb.RunWithRetry',
	Try: 'ydb.Try',
	TokenFetch: 'ydb.TokenFetch',
} as const

export type SpanBaseAttributes = {
	'server.address': string
	'server.port': number
	'network.peer.address': string
	'network.peer.port': number
	'db.namespace'?: string
	'ydb.node.id'?: number
	'ydb.node.dc'?: string
}

export type GetBaseAttributesOptions = {
	dbNamespace?: string
	peerAddress?: string
	peerPort?: number
	nodeId?: number
	nodeDc?: string
}

export function parseEndpoint(endpoint: string): {
	serverAddress: string
	serverPort: number
	database: string | undefined
} {
	let url = new URL(
		endpoint.replace(/^grpcs?:\/\//, (m) => (m.endsWith('s://') ? 'https://' : 'http://'))
	)
	let serverAddress = url.hostname
	let serverPort = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 2135
	let database = url.pathname && url.pathname !== '/' ? url.pathname : undefined
	return { serverAddress, serverPort, database }
}

export function getBaseAttributes(
	serverAddress: string,
	serverPort: number,
	options?: string | GetBaseAttributesOptions
): SpanBaseAttributes & { 'db.system.name': string } {
	let dbNamespace: string | undefined
	let peerAddress = serverAddress
	let peerPort = serverPort
	let nodeId: number | undefined
	let nodeDc: string | undefined
	if (options !== undefined) {
		if (typeof options === 'string') {
			dbNamespace = options
		} else {
			dbNamespace = options.dbNamespace
			if (options.peerAddress !== undefined) peerAddress = options.peerAddress
			if (options.peerPort !== undefined) peerPort = options.peerPort
			nodeId = options.nodeId
			nodeDc = options.nodeDc
		}
	}
	let attrs: SpanBaseAttributes & { 'db.system.name': string } = {
		'db.system.name': DB_SYSTEM,
		'server.address': serverAddress,
		'server.port': serverPort,
		'network.peer.address': peerAddress,
		'network.peer.port': peerPort,
	}
	if (dbNamespace) {
		attrs['db.namespace'] = dbNamespace
	}
	if (nodeId !== undefined) {
		attrs['ydb.node.id'] = nodeId
	}
	if (nodeDc !== undefined) {
		attrs['ydb.node.dc'] = nodeDc
	}
	return attrs
}

/**
 * Extracts db.response.status_code and error.type from an error for span attributes.
 * Normalizes all errors (including gRPC/transport like PROTOCOL_ERROR) to stable low-cardinality values.
 * @see https://opentelemetry.io/docs/specs/semconv/db/database-spans/#errorstype
 */
export function recordErrorAttributes(error: unknown): {
	'db.response.status_code': string
	'error.type': string
} {
	if (error instanceof YDBError) {
		let statusCode = YDBError.codes[error.code as StatusIds_StatusCode]
		return {
			'db.response.status_code': statusCode ?? 'UNKNOWN',
			'error.type': statusCode ?? 'UNKNOWN',
		}
	}

	// gRPC/transport errors (ClientError from nice-grpc): map code to stable error.type
	if (error instanceof ClientError) {
		let codeName = (Status as Record<number, string>)[error.code] ?? 'UNKNOWN'
		return {
			'db.response.status_code': codeName,
			'error.type': codeName,
		}
	}

	if (error instanceof Error && 'name' in error) {
		let name = error.name
		if (name === 'AbortError' || name.includes('Abort')) {
			return {
				'db.response.status_code': 'CANCELLED',
				'error.type': 'CANCELLED',
			}
		}
		if (name === 'TimeoutError' || name.includes('Timeout')) {
			return {
				'db.response.status_code': 'TIMEOUT',
				'error.type': 'TIMEOUT',
			}
		}
		if (name === 'ClientError') {
			return {
				'db.response.status_code': 'TRANSPORT_ERROR',
				'error.type': 'TRANSPORT_ERROR',
			}
		}
		let msg = String((error as Error).message ?? '')
		if (/PROTOCOL_ERROR|TRANSPORT|UNAVAILABLE|DEADLINE|CANCELLED/i.test(msg)) {
			let type = /PROTOCOL/i.test(msg)
				? 'TRANSPORT_ERROR'
				: /UNAVAILABLE/i.test(msg)
					? 'UNAVAILABLE'
					: /DEADLINE|TIMEOUT/i.test(msg)
						? 'TIMEOUT'
						: /CANCELLED/i.test(msg)
							? 'CANCELLED'
							: 'TRANSPORT_ERROR'
			return {
				'db.response.status_code': type,
				'error.type': type,
			}
		}
	}

	return {
		'db.response.status_code': 'UNKNOWN',
		'error.type': 'UNKNOWN',
	}
}
