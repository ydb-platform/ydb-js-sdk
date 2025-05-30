import { Driver } from "@ydbjs/core";

import { TopicReader, type TopicReaderOptions } from "./reader.js";

export interface TopicClient extends AsyncDisposable {
	createReader<Payload = Uint8Array>(options: TopicReaderOptions<Payload>): TopicReader<Payload>;
}

export function topic(driver: Driver): TopicClient {
	return {
		createReader(options) {
			return new TopicReader(driver, options);
		},
	} as TopicClient
}
