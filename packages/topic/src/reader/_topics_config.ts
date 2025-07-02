import { create, protoInt64 } from "@bufbuild/protobuf";
import { type Duration, DurationSchema, type Timestamp, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { type StreamReadMessage_InitRequest_TopicReadSettings, StreamReadMessage_InitRequest_TopicReadSettingsSchema } from "@ydbjs/api/topic";
import type { StringValue } from "ms";
import ms from "ms";
import type { TopicReaderSource } from "./types.js";

export let _parse_topics_read_settings = function parse_topics_read_settings(
	topic: string | TopicReaderSource | TopicReaderSource[]
): StreamReadMessage_InitRequest_TopicReadSettings[] {
	let settings: StreamReadMessage_InitRequest_TopicReadSettings[] = []

	let parseDuration = function parseDuration(duration: number | StringValue | Duration): Duration {
		if (typeof duration === 'string') {
			duration = ms(duration);
		}

		if (typeof duration === 'number') {
			let seconds = Math.floor(duration / 1000);

			return create(DurationSchema, {
				seconds: protoInt64.parse(seconds),
				nanos: (duration - seconds * 1000) * 1_000_000,
			})
		}

		return duration;
	}

	let parseTimestamp = function parseTimestamp(timestamp: number | Date | Timestamp): Timestamp {
		if (typeof timestamp === 'number') {
			timestamp = new Date(timestamp);
		}

		if (timestamp instanceof Date) {
			timestamp = timestampFromDate(timestamp);
		}

		return timestamp;
	}

	if (typeof topic === "string") {
		settings.push(
			create(StreamReadMessage_InitRequest_TopicReadSettingsSchema, {
				path: topic
			})
		)
	} else if (!Array.isArray(topic)) {
		topic = [topic]
	}

	if (Array.isArray(topic)) {
		for (let topicSource of topic) {
			settings.push(
				create(StreamReadMessage_InitRequest_TopicReadSettingsSchema, {
					path: topicSource.path,
					...(topicSource.maxLag && { maxLag: parseDuration(topicSource.maxLag) }),
					...(topicSource.readFrom && { readFrom: parseTimestamp(topicSource.readFrom) }),
					...(topicSource.partitionIds && { partitionIds: topicSource.partitionIds }),
				})
			)
		}
	}

	return settings;
}
