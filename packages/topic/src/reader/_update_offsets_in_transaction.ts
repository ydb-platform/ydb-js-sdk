import { TopicServiceDefinition } from '@ydbjs/api/topic'
import {
	OffsetsRangeSchema,
	TransactionIdentitySchema,
	UpdateOffsetsInTransactionRequestSchema,
	UpdateOffsetsInTransactionRequest_TopicOffsetsSchema,
	UpdateOffsetsInTransactionRequest_TopicOffsets_PartitionOffsetsSchema,
} from '@ydbjs/api/topic'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { create } from '@bufbuild/protobuf'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import type { TX } from '../tx.js'
import type { TopicPartitionSession } from '../partition-session.js'

let dbg = loggers.topic.extend('reader')

export let _update_offsets_in_transaction =
	async function updateOffsetsInTransaction(
		tx: TX,
		driver: Driver,
		consumer: string,
		updates: Array<{
			partitionSession: TopicPartitionSession
			offsetRange: { firstOffset: bigint; lastOffset: bigint }
		}>
	): Promise<void> {
		if (updates.length === 0) {
			dbg.log('no offsets to update in transaction')
			return
		}

		// Group updates by topic path
		let topicMap = new Map<
			string,
			{
				path: string
				partitions: Array<{
					partitionId: bigint
					offsetRange: { firstOffset: bigint; lastOffset: bigint }
				}>
			}
		>()

		for (let update of updates) {
			let topicPath = update.partitionSession.topicPath
			let topicEntry = topicMap.get(topicPath)
			if (!topicEntry) {
				topicEntry = { path: topicPath, partitions: [] }
				topicMap.set(topicPath, topicEntry)
			}
			topicEntry.partitions.push({
				partitionId: update.partitionSession.partitionId,
				offsetRange: update.offsetRange,
			})
		}

		// Build the request
		let topics = Array.from(topicMap.values())
		let request = create(UpdateOffsetsInTransactionRequestSchema, {
			tx: create(TransactionIdentitySchema, {
				id: tx.transactionId,
				session: tx.sessionId,
			}),
			topics: topics.map((topic) =>
				create(UpdateOffsetsInTransactionRequest_TopicOffsetsSchema, {
					path: topic.path,
					partitions: topic.partitions.map((partition) =>
						create(
							UpdateOffsetsInTransactionRequest_TopicOffsets_PartitionOffsetsSchema,
							{
								partitionId: partition.partitionId,
								partitionOffsets: [
									create(OffsetsRangeSchema, {
										start: partition.offsetRange
											.firstOffset,
										end:
											partition.offsetRange.lastOffset +
											1n, // exclusive end
									}),
								],
							}
						)
					),
				})
			),
			consumer,
		})

		dbg.log(
			'sending updateOffsetsInTransaction request for %d topics, %d total partitions',
			topics.length,
			topics.reduce((sum, t) => sum + t.partitions.length, 0)
		)

		// Send the request
		let client = driver.createClient(TopicServiceDefinition)
		let response = await client.updateOffsetsInTransaction(request)

		if (response.operation?.ready === false) {
			throw new Error('UpdateOffsetsInTransaction operation is not ready')
		}

		if (response.operation?.status !== StatusIds_StatusCode.SUCCESS) {
			throw new Error(
				`UpdateOffsetsInTransaction failed: ${response.operation?.status}`
			)
		}

		dbg.log('updateOffsetsInTransaction completed successfully')
	}
