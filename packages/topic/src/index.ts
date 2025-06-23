import { Driver } from "@ydbjs/core";

import { TopicReader, type TopicReaderOptions } from "./reader.js";
import { type TopicWriter, type TopicWriterOptions, createTopicTxWriter, createTopicWriter } from "./writer/index.js";
import type { TX } from "./writer/tx.js";

export interface TopicClient {
	createReader(options: TopicReaderOptions): TopicReader;
	createWriter(options: TopicWriterOptions): TopicWriter;
	createTxWriter(tx: TX, options: TopicWriterOptions): TopicWriter;
}

export function topic(driver: Driver): TopicClient {
	return {
		createReader(options) {
			return new TopicReader(driver, options);
		},
		createWriter(options: TopicWriterOptions) {
			return createTopicWriter(driver, options);
		},
		createTxWriter(tx: TX, options: TopicWriterOptions) {
			return createTopicTxWriter(driver, tx, options);
		},
	} as TopicClient
}
