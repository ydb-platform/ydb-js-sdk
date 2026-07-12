import * as zlib from 'node:zlib'
import { Codec } from '@ydbjs/api/topic'

export interface CompressionCodec {
	codec: Codec | number
	compress(payload: Uint8Array): Uint8Array
	decompress(payload: Uint8Array): Uint8Array
}

// node:zlib gained zstd in Node.js 22.15 / 23.8; the package supports Node >= 20.19,
// so the built-in ZSTD codec is available only when the runtime provides it.
let hasZstd = typeof zlib.zstdCompressSync === 'function'

let zstdUnsupported = function zstdUnsupported(): Error {
	return new Error(
		'Built-in ZSTD codec requires node:zlib zstd support (Node.js 22.15+ / 23.8+) — on runtimes without it provide a custom CompressionCodec for Codec.ZSTD'
	)
}

export function getCodec(codec: Codec): CompressionCodec {
	switch (codec) {
		case Codec.RAW:
			return {
				codec: Codec.RAW,
				compress: (payload) => payload,
				decompress: (payload) => payload,
			}
		case Codec.GZIP:
			return {
				codec: Codec.GZIP,
				compress: (payload) => zlib.gzipSync(payload),
				decompress: (payload) => zlib.gunzipSync(payload),
			}
		case Codec.ZSTD:
			if (!hasZstd) {
				throw zstdUnsupported()
			}
			return {
				codec: Codec.ZSTD,
				compress: (payload) => zlib.zstdCompressSync(payload),
				decompress: (payload) => zlib.zstdDecompressSync(payload),
			}
		default:
			throw new Error(`Unsupported codec: ${codec}`)
	}
}

export type CodecMap = Map<Codec | number, CompressionCodec>

// ZSTD is present only when the runtime supports it — a reader on older Node that
// receives ZSTD data gets the actionable "register it in codecMap" decode error.
export const defaultCodecMap: CodecMap = new Map([
	[Codec.RAW, getCodec(Codec.RAW)],
	[Codec.GZIP, getCodec(Codec.GZIP)],
	...(hasZstd ? [[Codec.ZSTD, getCodec(Codec.ZSTD)] as const] : []),
])

export const RAW_CODEC: CompressionCodec = getCodec(Codec.RAW)
export const GZIP_CODEC: CompressionCodec = getCodec(Codec.GZIP)
// Import-safe on every supported Node version; throws with the Node-version hint
// at first use instead of a bare TypeError from the missing zlib function.
export const ZSTD_CODEC: CompressionCodec = hasZstd
	? getCodec(Codec.ZSTD)
	: {
			codec: Codec.ZSTD,
			compress: () => {
				throw zstdUnsupported()
			},
			decompress: () => {
				throw zstdUnsupported()
			},
		}
