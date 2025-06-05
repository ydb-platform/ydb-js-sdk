import { Driver } from "@ydbjs/core";

import { TopicReader, type TopicReaderOptions } from "./reader.js";
import { type TopicWriter, type TopicWriterOptions, createTopicWriter } from "./writer/index.ts";

export interface TopicClient {
	createReader<Payload = Uint8Array>(options: TopicReaderOptions<Payload>): TopicReader<Payload>;
	createWriter<Payload = Uint8Array>(options: TopicWriterOptions<Payload>): TopicWriter<Payload>;
}

export function topic(driver: Driver): TopicClient {
	return {
		createReader(options) {
			return new TopicReader(driver, options);
		},
		createWriter<Payload>(options: TopicWriterOptions<Payload>) {
			return createTopicWriter(driver, options);
		},
	} as TopicClient
}
