import { Driver } from '@ydbjs/core'

import {
	type TopicReader,
	type TopicReaderOptions,
	type TopicTxReader,
	createTopicReader,
	createTopicTxReader,
} from './reader/index.js'
import type { TX } from './tx.js'
import {
	type TopicTxWriter,
	type TopicWriter,
	type TopicWriterOptions,
	createTopicTxWriter,
	createTopicWriter,
} from './writer/index.js'

export interface TopicClient {
	createReader(options: TopicReaderOptions): TopicReader
	createTxReader(tx: TX, options: TopicReaderOptions): TopicTxReader
	createWriter(options: TopicWriterOptions): TopicWriter
	createTxWriter(tx: TX, options: TopicWriterOptions): TopicTxWriter
}

export function topic(driver: Driver): TopicClient {
	return {
		createReader(options) {
			return createTopicReader(driver, options)
		},
		createTxReader(tx: TX, options: TopicReaderOptions) {
			return createTopicTxReader(tx, driver, options)
		},
		createWriter(options: TopicWriterOptions) {
			return createTopicWriter(driver, options)
		},
		createTxWriter(tx: TX, options: Omit<TopicWriterOptions, 'tx'>) {
			return createTopicTxWriter(tx, driver, options)
		},
	} as TopicClient
}

export type { TopicTxReader } from './reader/index.js'
export type { TopicTxWriter } from './writer/index.js'
