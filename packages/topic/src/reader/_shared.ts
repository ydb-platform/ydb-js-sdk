import { setInterval } from "node:timers/promises"
import { loggers } from "@ydbjs/debug"
import { type RetryConfig } from "@ydbjs/retry"
import { backoff, combine, jitter } from "@ydbjs/retry/strategy"
import type { CodecMap } from "../codec.js"
import { _send_update_token_request } from "./_update_token.js"
import type { AsyncPriorityQueue } from "../queue.js"
import type { StreamReadMessage_FromClient } from "@ydbjs/api/topic"
import type { Driver } from "@ydbjs/core"

let dbg = loggers.topic.extend('reader')

/**
 * Initialize custom codecs if provided in options
 */
export function _initialize_codecs(
	codecs: CodecMap,
	codecMap?: CodecMap
): void {
	if (codecMap) {
		for (let [key, codec] of codecMap) {
			codecs.set(key, codec)
		}
	}
}

/**
 * Start background token refresher
 */
export async function _start_background_token_refresher(
	driver: Driver,
	outgoingQueue: AsyncPriorityQueue<StreamReadMessage_FromClient>,
	updateTokenIntervalMs: number,
	signal: AbortSignal
): Promise<void> {
	try {
		for await (let _ of setInterval(updateTokenIntervalMs, void 0, { signal })) {
			_send_update_token_request({
				queue: outgoingQueue,
				token: await driver.token,
			})
		}
	} catch (error) {
		// Handle abort signal or other errors silently during disposal
		if (!signal.aborted) {
			dbg.log('background token refresher error: %O', error)
		}
	}
}

/**
 * Create standard retry configuration for stream consumption
 */
export function _create_retry_config(signal: AbortSignal): RetryConfig {
	return {
		signal,
		budget: Infinity,
		strategy: combine(jitter(50), backoff(50, 5000)),
		retry(error) {
			dbg.log('retrying stream read due to %O', error);
			return true;
		},
	}
}

/**
 * Create disposal functions for readers
 */
export function _create_disposal_functions<T extends { close(): Promise<void>, destroy(reason?: Error): void }>(
	reader: T,
	readerType: string
): {
	[Symbol.dispose](): void
	[Symbol.asyncDispose](): Promise<void>
} {
	return {
		[Symbol.dispose]() {
			reader.destroy()
		},
		async [Symbol.asyncDispose]() {
			// Graceful async disposal: wait for existing messages to be sent
			try {
				await reader.close() // Use graceful close
			} catch (error) {
				dbg.log('error during async dispose close: %O', error)
			}

			reader.destroy(new Error(`${readerType} async disposed`))
		},
	}
}
