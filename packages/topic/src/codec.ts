import * as zlib from 'node:zlib'
import { Codec } from '@ydbjs/api/topic'

export interface CompressionCodec {
	codec: Codec | number
	compress(payload: Uint8Array): Uint8Array
	decompress(payload: Uint8Array): Uint8Array
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

export const defaultCodecMap: CodecMap = new Map([
	[Codec.RAW, getCodec(Codec.RAW)],
	[Codec.GZIP, getCodec(Codec.GZIP)],
	[Codec.ZSTD, getCodec(Codec.ZSTD)],
])

export const RAW_CODEC: CompressionCodec = getCodec(Codec.RAW)
export const GZIP_CODEC: CompressionCodec = getCodec(Codec.GZIP)
export const ZSTD_CODEC: CompressionCodec = getCodec(Codec.ZSTD)
