import type { StreamReadMessage_FromClient } from "@ydbjs/api/topic"
import type { Driver } from "@ydbjs/core"
import { loggers } from "@ydbjs/debug"

import { AsyncPriorityQueue } from "../queue.js"
import { defaultCodecMap } from "../codec.js"

import type { TopicReader, TopicReaderOptions, TopicReaderState, TopicTxReader, TopicTxReaderOptions, TopicTxReaderState } from "./types.js"
import { _send_update_token_request } from "./_update_token.js"
import { _parse_topics_read_settings } from "./_topics_config.js"
import { _consume_stream } from "./_consume_stream.js"
import { _consume_stream_tx } from "./_consume_stream_tx.js"
import { _read } from "./_read.js"
import { _commit } from "./_commit.js"
import { _update_offsets_in_transaction } from "./_update_offsets_in_transaction.js"
import { _create_disposal_functions, _initialize_codecs, _start_background_token_refresher } from "./_shared.js"
import type { TX } from "../tx.js"

let dbg = loggers.topic.extend('reader')

// Timeout for graceful shutdown waiting for pending commits
let GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000

export const createTopicReader = function createTopicReader(driver: Driver, options: TopicReaderOptions): TopicReader {
	options.updateTokenIntervalMs ??= 60_000 // Default is 60 seconds.

	let state: TopicReaderState = {
		driver,
		options,
		topicsReadSettings: _parse_topics_read_settings(options.topic),

		// Control
		controller: new AbortController(),
		disposed: false,

		// Data structures
		outgoingQueue: new AsyncPriorityQueue<StreamReadMessage_FromClient>(),
		buffer: [],
		partitionSessions: new Map(),
		pendingCommits: new Map(),
		codecs: new Map(defaultCodecMap),

		// Buffer management
		maxBufferSize: options.maxBufferBytes ?? 4n * 1024n * 1024n, // Reduced to 4MB for faster parsing
		freeBufferSize: options.maxBufferBytes ?? 4n * 1024n * 1024n, // Reduced to 4MB for faster parsing
	}
	// Initialize custom codecs if provided
	_initialize_codecs(state.codecs, options.codecMap)

	// Start consuming the stream immediately.
	void (async function stream() {
		try {
			await _consume_stream(state)
		} catch (error) {
			if (!state.controller.signal.aborted) {
				dbg.log('error occurred while streaming: %O', error)
			}
		} finally {
			dbg.log('stream closed')
			destroy(new Error('Stream closed'))
		}
	})()

	// Update the token periodically to ensure that the reader has a valid token.
	// This is useful to avoid token expiration and to ensure that the reader can continue to read messages from the topic.
	// The update token interval is configurable and defaults to 60 seconds.
	_start_background_token_refresher(
		state.driver,
		state.outgoingQueue,
		options.updateTokenIntervalMs,
		state.controller.signal
	)

	async function close() {
		if (state.disposed) return

		// Stop accepting new messages and requests
		state.outgoingQueue.close()

		// Wait for all pending commits to resolve with a timeout
		let pendingCommitPromises: Promise<void>[] = []
		for (let commits of state.pendingCommits.values()) {
			for (let commit of commits) {
				pendingCommitPromises.push(
					new Promise<void>((resolve) => {
						let originalResolve = commit.resolve
						let originalReject = commit.reject

						commit.resolve = () => {
							originalResolve()
							resolve()
						}

						commit.reject = (reason) => {
							originalReject(reason)
							resolve() // Still resolve our promise even if commit was rejected
						}
					})
				)
			}
		}

		if (pendingCommitPromises.length > 0) {
			try {
				// Wait for all pending commits or timeout after 30 seconds
				await Promise.race([
					Promise.all(pendingCommitPromises),
					new Promise<void>((resolve) => setTimeout(resolve, GRACEFUL_SHUTDOWN_TIMEOUT_MS))
				])
			} catch (err) {
				dbg.log('error during close: %O', err)
				throw err
			}
		}

		dbg.log('reader closed gracefully')

		// Now safely dispose - this will stop the token refresher via AbortSignal
		destroy(new Error('TopicReader closed'))
	}

	function destroy(reason: unknown) {
		if (state.disposed) return

		// Immediate shutdown - reject all pending commits
		for (let commits of state.pendingCommits.values()) {
			for (let commit of commits) {
				commit.reject(reason || new Error('TopicReader destroyed'))
			}
		}

		state.disposed = true
		state.outgoingQueue.close()
		state.pendingCommits.clear()
		state.controller.abort(reason)
	}

	return {
		read(options = {}) {
			return _read({
				disposed: state.disposed,
				controller: state.controller,
				buffer: state.buffer,
				partitionSessions: state.partitionSessions,
				codecs: state.codecs,
				outgoingQueue: state.outgoingQueue,
				maxBufferSize: state.maxBufferSize,
				freeBufferSize: state.freeBufferSize,
				updateFreeBufferSize: (releasedBytes: bigint) => {
					state.freeBufferSize += releasedBytes
				},
			}, options)
		},

		commit(input) {
			return _commit(state, input)
		},

		close,
		destroy,
		..._create_disposal_functions({ close, destroy }, 'TopicReader'),
	}
}

// Re-export types for compatibility
export type { TopicReaderOptions, TopicReader, TopicTxReaderOptions, TopicTxReader } from "./types.js"

export const createTopicTxReader = function createTopicTxReader(tx: TX, driver: Driver, options: Omit<TopicTxReaderOptions, 'tx'>): TopicTxReader {
	options.updateTokenIntervalMs ??= 60_000 // Default is 60 seconds.

	let state: TopicTxReaderState = {
		driver,
		options: Object.assign(options, { tx }),
		topicsReadSettings: _parse_topics_read_settings(options.topic),

		// Control
		controller: new AbortController(),
		disposed: false,

		// Data structures
		outgoingQueue: new AsyncPriorityQueue<StreamReadMessage_FromClient>(),
		buffer: [],
		partitionSessions: new Map(),
		codecs: new Map(defaultCodecMap),

		// Buffer management
		maxBufferSize: options.maxBufferBytes ?? 4n * 1024n * 1024n, // Reduced to 4MB for faster parsing
		freeBufferSize: options.maxBufferBytes ?? 4n * 1024n * 1024n, // Reduced to 4MB for faster parsing

		// Transaction support - track read offsets for commit hook
		readOffsets: new Map(),
	}

	// Initialize custom codecs if provided
	_initialize_codecs(state.codecs, options.codecMap)

	// Register precommit hook to send updateOffsetsInTransaction
	tx.onCommit(async () => {
		// Send updateOffsetsInTransaction for all read offsets
		let updates = []

		for (let [partitionSessionId, offsetRange] of state.readOffsets) {
			let partitionSession = state.partitionSessions.get(partitionSessionId)
			if (partitionSession) {
				updates.push({
					partitionSession,
					offsetRange
				})
			}
		}

		dbg.log('Updating offsets in transaction for %d partitions', updates.length)

		if (updates.length > 0) {
			await _update_offsets_in_transaction(
				tx,
				state.driver,
				state.options.consumer,
				updates
			)
		}
	})

	// Start consuming the stream immediately.
	void (async function stream() {
		try {
			await _consume_stream_tx(state)
		} catch (error) {
			if (!state.controller.signal.aborted) {
				dbg.log('error occurred while streaming: %O', error)
			}
		} finally {
			dbg.log('tx stream closed')
			destroy(new Error('Stream closed'))
		}
	})()

	// Update the token periodically to ensure that the reader has a valid token.
	_start_background_token_refresher(
		state.driver,
		state.outgoingQueue,
		options.updateTokenIntervalMs,
		state.controller.signal
	)

	async function close() {
		if (state.disposed) return

		// Stop accepting new messages and requests
		state.outgoingQueue.close()

		// Send updateOffsetsInTransaction for all read offsets before closing
		let updates = []
		for (let [partitionSessionId, offsetRange] of state.readOffsets) {
			let partitionSession = state.partitionSessions.get(partitionSessionId)
			if (partitionSession) {
				updates.push({
					partitionSession,
					offsetRange
				})
			}
		}

		dbg.log('Updating offsets in transaction during close for %d partitions', updates.length)

		if (updates.length > 0) {
			try {
				await _update_offsets_in_transaction(
					tx,
					state.driver,
					state.options.consumer,
					updates
				)
			} catch (error) {
				dbg.log('error updating offsets during close: %O', error)
				// Don't throw, continue with cleanup
			}
		}

		dbg.log('tx reader closed gracefully')

		// Now safely dispose - this will stop the token refresher via AbortSignal
		destroy(new Error('TopicTxReader closed'))
	}

	function destroy(reason: unknown) {
		if (state.disposed) return

		state.disposed = true
		state.outgoingQueue.close()
		state.readOffsets.clear()
		state.controller.abort(reason)
	}

	return {
		read(readOptions = {}) {
			return _read({
				disposed: state.disposed,
				controller: state.controller,
				buffer: state.buffer,
				partitionSessions: state.partitionSessions,
				codecs: state.codecs,
				outgoingQueue: state.outgoingQueue,
				maxBufferSize: state.maxBufferSize,
				freeBufferSize: state.freeBufferSize,
				readOffsets: state.readOffsets,
				updateFreeBufferSize: (releasedBytes: bigint) => {
					state.freeBufferSize += releasedBytes
				},
			}, readOptions)
		},

		close,
		destroy,
	}
}
