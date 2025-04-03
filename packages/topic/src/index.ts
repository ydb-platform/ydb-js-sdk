// @ts-ignore

import { type Writable } from "node:stream";
import { create } from "@bufbuild/protobuf";
import { createTopicClient, StreamReadMessage_FromClientSchema, StreamWriteMessage_FromClientSchema } from "@ydbjs/api/topic";
import { Driver } from "@ydbjs/core";
import type { Abortable, EventEmitter } from "node:events";

class Message {
	constructor(payload: Uint8Array) { }
}

export interface TopicReader<M extends Message = Message> extends Abortable, EventEmitter, AsyncIterable<M> {
	commit(): void | Promise<void>
	flush(): void | Promise<void>
}

export type TopicReaderOptions = {
	consumerId?: string,
	partitions?: bigint[],
	bytesSize?: bigint
}

export interface TopicWriter<M extends Message = Message> extends Writable {
	write(chunk: M, callback?: (error: Error | null | undefined) => void): boolean;
	write(chunk: M, encoding: BufferEncoding, callback?: (error: Error | null | undefined) => void): boolean;
	write(chunk: M): Promise<boolean>;
	write(chunk: M, encoding: BufferEncoding): Promise<boolean>;
}

export type TopicWriterOptions = {
	producerId?: string
	partitionId?: bigint
	generationId?: bigint
}

export interface TopicTxWriter<M extends Message = Message> extends Writable {
	write(chunk: M, callback?: (error: Error | null | undefined) => void): boolean;
	write(chunk: M, encoding: BufferEncoding, callback?: (error: Error | null | undefined) => void): boolean;

	write(chunk: M): Promise<boolean>;
	write(chunk: M, encoding: BufferEncoding): Promise<boolean>;
}

export interface TopicClient extends AsyncDisposable {
	reader(target: string, options: TopicReaderOptions): TopicReader
	reader(target: Array<{ path: string, partitions: bigint[] }>, options: TopicReaderOptions): TopicReader
	reader(target: string | Array<{ path: string, partitions: bigint[] }>, options: TopicReaderOptions): TopicReader
	writer(target: string, options: TopicWriterOptions): TopicWriter
	writerTx(tx: {}, writer: TopicTxWriter): TopicTxWriter
}

export function topic(db: Driver): TopicClient {
	let client = createTopicClient(db);

	return {
		reader(consumer: string, target, options = {}): TopicReader {
			let topicsReadSettings = [];

			if (typeof target === "string") {
				topicsReadSettings.push({ path: target })
			}

			if (Array.isArray(target)) {
				topicsReadSettings = target
			}

			let stream = client.streamRead({
				[Symbol.asyncIterator]: async function* () {
					yield create(StreamReadMessage_FromClientSchema, {
						clientMessage: {
							case: "initRequest",
							value: {
								consumer,
								topicsReadSettings,
							}
						}
					});

					let sessionId: string | undefined;
					for await (let message of stream) {
						switch (message.serverMessage.case) {
							case "initResponse":
								sessionId = message.serverMessage.value.sessionId

								yield create(StreamReadMessage_FromClientSchema, {
									clientMessage: {
										case: "readRequest",
										value: {
											bytesSize: options.bytesSize
										}
									}
								})

								break;
							case "readResponse":
								message.serverMessage.value.partitionData
								break;
							case "startPartitionSessionRequest":
								message.serverMessage.value.partitionSession?.partitionSessionId
								break;
						}
					}
				}
			})

			return {};
		},
		writer(producer, target, options): TopicWriter {
			let stream = client.streamWrite({
				[Symbol.asyncIterator]: async function* () {
					yield create(StreamWriteMessage_FromClientSchema, {
						clientMessage: {
							case: "initRequest",
							value: {
								path: "",
								producerId: "",
								partitioning: {
									case: "partitionId",
									value: 0n
								}
							}
						}
					});
				}
			})

			return {}
		},
		writerTx(tx, producer, target, options): TopicTxWriter {
			return {};
		},
		[Symbol.asyncDispose](): Promise<void> {
			return Promise.resolve();
		}
	};
}

let topicClient = topic(new Driver(""));

let reader = topicClient.reader("topicPath", { consumerId: "", bytesSize: 0n });
reader.addListener("data", (data) => { })

let writer = topicClient.writer("topicPath", { producerId: "" });
writer.write(new Message(new Uint8Array()))
await writer.write(new Message(new Uint8Array()))

let txWriter = topicClient.writerTx({}, "topicPath", { producerId: "" });
txWriter.write(new Message(new Uint8Array()))

await txWriter.write(new Message(new Uint8Array()))
