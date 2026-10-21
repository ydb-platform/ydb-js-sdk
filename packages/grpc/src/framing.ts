import { Transform } from 'node:stream'
import { gunzip, inflate } from 'node:zlib'

import { MessageSizeError, RpcError, Status } from './error.js'

export interface Frame {
	data: Buffer
	compressed: boolean
}

export class FrameDecoder {
	#limit: number
	#direction: 'request' | 'response'
	#header = Buffer.allocUnsafe(5)
	#headerBytes = 0
	#length = 0
	#compressed = false
	#body: Buffer | undefined
	#bodyBytes = 0

	constructor(limit: number, direction: 'request' | 'response' = 'response') {
		this.#limit = limit
		this.#direction = direction
	}

	push(chunk: Buffer, frames: Frame[] = []): Frame[] {
		let offset = 0
		while (offset < chunk.length) {
			if (this.#headerBytes < 5) {
				let header: Buffer
				if (this.#headerBytes === 0 && chunk.length - offset >= 5) {
					header = chunk.subarray(offset, offset + 5)
					offset += 5
					this.#headerBytes = 5
				} else {
					let size = Math.min(5 - this.#headerBytes, chunk.length - offset)
					chunk.copy(this.#header, this.#headerBytes, offset, offset + size)
					this.#headerBytes += size
					offset += size
					if (this.#headerBytes < 5) {
						continue
					}
					header = this.#header
				}
				if (header[0] !== 0 && header[0] !== 1) {
					throw new RpcError(Status.INTERNAL, 'Invalid gRPC compression flag')
				}
				this.#compressed = header[0] === 1
				this.#length = header.readUInt32BE(1)
				if (this.#length > this.#limit) {
					throw new MessageSizeError(this.#direction, this.#limit)
				}
				if (this.#length === 0) {
					frames.push({ data: Buffer.alloc(0), compressed: this.#compressed })
					this.#headerBytes = 0
					continue
				}
			}

			let remaining = this.#length - this.#bodyBytes
			if (!this.#body && chunk.length - offset >= remaining) {
				frames.push({
					data: chunk.subarray(offset, offset + remaining),
					compressed: this.#compressed,
				})
				offset += remaining
				this.#headerBytes = 0
				continue
			}
			this.#body ??= Buffer.allocUnsafe(this.#length)
			let size = Math.min(remaining, chunk.length - offset)
			chunk.copy(this.#body, this.#bodyBytes, offset, offset + size)
			this.#bodyBytes += size
			offset += size
			if (this.#bodyBytes === this.#length) {
				frames.push({ data: this.#body, compressed: this.#compressed })
				this.#body = undefined
				this.#bodyBytes = 0
				this.#headerBytes = 0
			}
		}
		return frames
	}

	finish(): void {
		if (this.#headerBytes !== 0 || this.#bodyBytes !== 0) {
			throw new RpcError(Status.INTERNAL, 'Truncated gRPC message')
		}
	}
}

export function createFrameStream(
	limit: number,
	direction: 'request' | 'response' = 'response'
): Transform {
	let decoder = new FrameDecoder(limit, direction)
	return new Transform({
		readableObjectMode: true,
		// Do not parse the next chunk while the consumer retains the current frame batch.
		readableHighWaterMark: 0,
		transform(chunk: Buffer, _encoding, callback) {
			let frames: Frame[] = []
			try {
				decoder.push(chunk, frames)
				callback(null, frames.length ? frames : undefined)
			} catch (error) {
				if (frames.length === 0) {
					callback(error as Error)
					return
				}
				// Keep completed frames readable before failing, and hold subsequent
				// input until the consumer finishes or abandons this batch.
				this.push(
					(function* () {
						try {
							yield* frames
						} finally {
							callback(error as Error)
						}
					})()
				)
			}
		},
		flush(callback) {
			try {
				decoder.finish()
				callback()
			} catch (error) {
				callback(error as Error)
			}
		},
	})
}

export async function decompress(
	frame: Frame,
	encoding: string,
	limit: number,
	direction: 'request' | 'response' = 'response'
): Promise<Buffer> {
	if (!frame.compressed) {
		return frame.data
	}
	let decode = encoding === 'gzip' ? gunzip : encoding === 'deflate' ? inflate : undefined
	if (!decode) {
		throw new RpcError(
			encoding === 'identity' ? Status.INTERNAL : Status.UNIMPLEMENTED,
			`Unsupported compressed message encoding: ${encoding}`
		)
	}
	return new Promise((resolve, reject) => {
		decode(frame.data, { maxOutputLength: Math.max(1, limit) }, (error, data) => {
			if (error) {
				if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
					reject(new MessageSizeError(direction, limit, { cause: error }))
					return
				}
				reject(
					new RpcError(
						Status.INTERNAL,
						'Failed to decompress gRPC message',
						{},
						{ cause: error }
					)
				)
				return
			}
			if (data.length > limit) {
				reject(new MessageSizeError(direction, limit))
				return
			}
			resolve(data)
		})
	})
}
