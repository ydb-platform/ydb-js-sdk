import { Driver } from "@ydbjs/core";

import { TopicReader, type TopicReaderOptions } from "./reader.js";
import { type TopicWriter, type TopicWriterOptions, createTopicWriter } from "./writer/index.ts";

export interface TopicClient {
	createReader(options: TopicReaderOptions): TopicReader;
	createWriter(options: TopicWriterOptions): TopicWriter;
}

export function topic(driver: Driver): TopicClient {
	return {
		createReader(options) {
			return new TopicReader(driver, options);
		},
		createWriter(options: TopicWriterOptions) {
			return createTopicWriter(driver, options);
		},
	} as TopicClient
}
