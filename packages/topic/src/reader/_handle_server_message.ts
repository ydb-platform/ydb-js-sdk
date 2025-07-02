import * as assert from "node:assert";
import { once } from "node:events";
import type { StreamReadMessage_FromServer } from "@ydbjs/api/topic";
import { loggers } from "@ydbjs/debug";

import { TopicPartitionSession } from "../partition-session.js";
import { _send_start_partition_session_response } from "./_start_partition_session_response.js";
import { _send_stop_partition_session_response } from "./_stop_partition_session_response.js";
import type { TopicReaderOptions, TopicCommitPromise } from "./types.js";

let dbg = loggers.topic.extend('reader')

export let _handle_server_message = async function handle_server_message(
	message: StreamReadMessage_FromServer,
	ctx: {
		readonly options: TopicReaderOptions,
		readonly outgoingQueue: import("../queue.js").AsyncPriorityQueue<import("@ydbjs/api/topic").StreamReadMessage_FromClient>,
		readonly buffer: import("@ydbjs/api/topic").StreamReadMessage_ReadResponse[],
		readonly partitionSessions: Map<bigint, TopicPartitionSession>,
		readonly pendingCommits: Map<bigint, TopicCommitPromise[]>,
		disposed: boolean,
		readMore: (bytes: bigint) => void,
		onError?: (error: unknown) => void
	}
): Promise<void> {
	if (ctx.disposed) {
		dbg.log('error: receive "%s" after dispose', message.serverMessage.value?.$typeName)
		return
	}

	if (message.serverMessage.case === 'initResponse') {
		dbg.log('read session identifier: %s', message.serverMessage.value.sessionId)
		// This will be handled by the caller via readMore callback
		return
	}

	if (message.serverMessage.case === 'startPartitionSessionRequest') {
		assert.ok(message.serverMessage.value.partitionSession, 'startPartitionSessionRequest must have partitionSession');
		assert.ok(message.serverMessage.value.partitionOffsets, 'startPartitionSessionRequest must have partitionOffsets');

		dbg.log('receive partition with id %s', message.serverMessage.value.partitionSession.partitionId);

		// Create a new partition session.
		let partitionSession: TopicPartitionSession = new TopicPartitionSession(
			message.serverMessage.value.partitionSession.partitionSessionId,
			message.serverMessage.value.partitionSession.partitionId,
			message.serverMessage.value.partitionSession.path
		);

		// save partition session.
		ctx.partitionSessions.set(partitionSession.partitionSessionId, partitionSession);

		// Initialize offsets.
		let readOffset = message.serverMessage.value.partitionOffsets.start;
		let commitOffset = message.serverMessage.value.committedOffset;

		// Call onPartitionSessionStart callback if it is defined.
		if (ctx.options.onPartitionSessionStart) {
			let committedOffset = message.serverMessage.value.committedOffset;
			let partitionOffsets = message.serverMessage.value.partitionOffsets;

			let response = await ctx.options.onPartitionSessionStart(partitionSession, committedOffset, partitionOffsets).catch((error) => {
				dbg.log('error: onPartitionSessionStart error: %O', error);
				ctx.onError?.(error);
				return undefined;
			});

			if (response) {
				readOffset = response.readOffset || 0n;
				commitOffset = response.commitOffset || 0n;
			}
		}

		_send_start_partition_session_response({
			queue: ctx.outgoingQueue,
			partitionSessionId: partitionSession.partitionSessionId,
			readOffset,
			commitOffset
		});
	}

	if (message.serverMessage.case === 'stopPartitionSessionRequest') {
		assert.ok(message.serverMessage.value.partitionSessionId, 'stopPartitionSessionRequest must have partitionSessionId');

		let partitionSession = ctx.partitionSessions.get(message.serverMessage.value.partitionSessionId);
		if (!partitionSession) {
			dbg.log('error: stopPartitionSessionRequest for unknown partitionSessionId=%s', message.serverMessage.value.partitionSessionId);
			return;
		}

		if (ctx.options.onPartitionSessionStop) {
			let committedOffset = message.serverMessage.value.committedOffset || 0n;

			await ctx.options.onPartitionSessionStop(partitionSession, committedOffset).catch((err) => {
				dbg.log('error: onPartitionSessionStop error: %O', err);
				ctx.onError?.(err);
			});
		}

		// If graceful stop is not requested, we can stop the partition session immediately.
		if (!message.serverMessage.value.graceful) {
			dbg.log('stop partition session %s without graceful stop', partitionSession.partitionSessionId);
			partitionSession.stop();

			// Remove all messages from the buffer that belong to this partition session.
			for (let part of ctx.buffer) {
				let i = 0;
				while (i < part.partitionData.length) {
					if (part.partitionData[i]!.partitionSessionId === partitionSession.partitionSessionId) {
						part.partitionData.splice(i, 1);
					} else {
						i++;
					}
				}
			}

			let pendingCommits = ctx.pendingCommits.get(partitionSession.partitionSessionId);
			if (pendingCommits) {
				// If there are pending commits for this partition session, reject them.
				for (let commit of pendingCommits) {
					commit.reject('Partition session stopped without graceful stop');
				}

				ctx.pendingCommits.delete(partitionSession.partitionSessionId);
			}

			ctx.partitionSessions.delete(partitionSession.partitionSessionId);
			partitionSession = undefined;

			return;
		}

		if (ctx.pendingCommits.has(partitionSession.partitionSessionId)) {
			await Promise.race([
				Promise.all(ctx.pendingCommits.get(partitionSession.partitionSessionId)!),
				once(AbortSignal.timeout(30_000), 'abort'),
			])
		}

		if (ctx.disposed) {
			return;
		}

		if (ctx.pendingCommits.has(partitionSession.partitionSessionId)) {
			// If there are pending commits for this partition session, reject them.
			for (let commit of ctx.pendingCommits.get(partitionSession.partitionSessionId)!) {
				commit.reject('Partition session stopped after timeout during graceful stop');
			}

			ctx.pendingCommits.delete(partitionSession.partitionSessionId);
		}

		_send_stop_partition_session_response({
			queue: ctx.outgoingQueue,
			partitionSessionId: partitionSession.partitionSessionId
		});
	}

	if (message.serverMessage.case === 'endPartitionSession') {
		assert.ok(message.serverMessage.value.partitionSessionId, 'endPartitionSession must have partitionSessionId');

		let partitionSession = ctx.partitionSessions.get(message.serverMessage.value.partitionSessionId);
		if (!partitionSession) {
			dbg.log('error: endPartitionSession for unknown partitionSessionId=%s', message.serverMessage.value.partitionSessionId);
			return;
		}

		partitionSession.end();
	}

	if (message.serverMessage.case === 'commitOffsetResponse') {
		assert.ok(message.serverMessage.value.partitionsCommittedOffsets, 'commitOffsetResponse must have partitionsCommittedOffsets');

		if (ctx.options.onCommittedOffset) {
			for (let part of message.serverMessage.value.partitionsCommittedOffsets) {
				let partitionSession = ctx.partitionSessions.get(part.partitionSessionId);
				if (!partitionSession) {
					dbg.log('error: commitOffsetResponse for unknown partitionSessionId=%s', part.partitionSessionId);
					continue;
				}

				ctx.options.onCommittedOffset(partitionSession, part.committedOffset)
			}
		}

		// Resolve all pending commits for the partition sessions.
		for (let part of message.serverMessage.value.partitionsCommittedOffsets) {
			let partitionSessionId = part.partitionSessionId;
			let committedOffset = part.committedOffset;

			// Resolve all pending commits for this partition session.
			let pendingCommits = ctx.pendingCommits.get(partitionSessionId);
			if (pendingCommits) {
				let i = 0;
				while (i < pendingCommits.length) {
					let commit = pendingCommits[i]!;
					if (commit.offset <= committedOffset) {
						// If the commit offset is less than or equal to the committed offset, resolve it.
						commit.resolve();
						pendingCommits.splice(i, 1); // Remove from pending commits
					} else {
						i++;
					}
				}
			}

			// If there are no pending commits for this partition session, remove it from the map.
			if (pendingCommits && pendingCommits.length === 0) {
				ctx.pendingCommits.delete(partitionSessionId);
			}
		}
	}
}
