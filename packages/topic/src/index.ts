import { Driver } from "@ydbjs/core";

import { type TopicReader, type TopicReaderOptions, type TopicTxReader, type TopicTxReaderOptions, createTopicReader, createTopicTxReader } from "./reader/index.js";
import { type TopicWriter, type TopicWriterOptions, createTopicTxWriter, createTopicWriter } from "./writer/index.js";
import type { TX } from "./tx.js";

export interface TopicClient {
	createReader(options: TopicReaderOptions): TopicReader;
	createTxReader(options: TopicTxReaderOptions): TopicTxReader;
	createWriter(options: TopicWriterOptions): TopicWriter;
	createTxWriter(tx: TX, options: TopicWriterOptions): TopicWriter;
}

export function topic(driver: Driver): TopicClient {
	return {
		createReader(options) {
			return createTopicReader(driver, options);
		},
		createTxReader(options: TopicTxReaderOptions) {
			return createTopicTxReader(driver, options);
		},
		createWriter(options: TopicWriterOptions) {
			return createTopicWriter(driver, options);
		},
		createTxWriter(tx: TX, options: TopicWriterOptions) {
			return createTopicTxWriter(tx, driver, options);
		},
	} as TopicClient
}
