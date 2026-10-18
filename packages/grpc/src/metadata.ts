import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http2'

import type { Metadata, MetadataValue } from './types.js'

let protocolHeaders = new Set([
	'content-type',
	'grpc-status',
	'grpc-message',
	'grpc-encoding',
	'grpc-accept-encoding',
])

export function requestHeaders(metadata: Metadata = {}): OutgoingHttpHeaders {
	let headers: OutgoingHttpHeaders = Object.create(null)
	for (let [original, values] of Object.entries(metadata)) {
		let key = original.toLowerCase()
		if (!/^[0-9a-z_.-]+$/.test(key)) {
			throw new TypeError(`Invalid metadata key: ${original}`)
		}
		let encoded = (Array.isArray(values) ? values : [values]).map((value: MetadataValue) => {
			if (key.endsWith('-bin')) {
				if (!(value instanceof Uint8Array)) {
					throw new TypeError(`Binary metadata ${key} requires Uint8Array`)
				}
				return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
					'base64'
				)
			}
			if (typeof value !== 'string' || !/^[\x20-\x7e]*$/.test(value)) {
				throw new TypeError(`Metadata ${key} requires an ASCII string`)
			}
			return value
		})
		let previous = headers[key]
		if (previous !== undefined) {
			encoded = [...(Array.isArray(previous) ? previous : [String(previous)]), ...encoded]
		}
		headers[key] = encoded.length === 1 ? encoded[0] : encoded
	}
	return headers
}

export function responseMetadata(headers: IncomingHttpHeaders, rawHeaders?: string[]): Metadata {
	if (rawHeaders) {
		headers = Object.create(null) as IncomingHttpHeaders
		for (let i = 0; i < rawHeaders.length; i += 2) {
			let key = rawHeaders[i]!.toLowerCase()
			let value = rawHeaders[i + 1]!
			let previous = headers[key]
			headers[key] =
				previous === undefined
					? value
					: [...(Array.isArray(previous) ? previous : [String(previous)]), value]
		}
	}
	let metadata: Record<string, MetadataValue | MetadataValue[]> = Object.create(null)
	for (let [key, value] of Object.entries(headers)) {
		if (key.startsWith(':') || protocolHeaders.has(key) || value === undefined) {
			continue
		}
		let values = Array.isArray(value) ? value : [String(value)]
		if (key.endsWith('-bin')) {
			let decoded = values
				.flatMap((part) => part.split(','))
				.map((part) => {
					let text = part.trim()
					if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) {
						throw new TypeError(`Invalid binary metadata ${key}`)
					}
					return Buffer.from(text, 'base64')
				})
			metadata[key] = decoded.length === 1 ? decoded[0]! : decoded
		} else {
			metadata[key] = values.length === 1 ? values[0]! : values
		}
	}
	return metadata
}
