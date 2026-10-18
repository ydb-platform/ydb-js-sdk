import { execFile, spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

import {
	type DescMessage,
	type MessageInitShape,
	create,
	fromBinary,
	toBinary,
} from '@bufbuild/protobuf'
import { abortable } from '@ydbjs/abortable'

import { Client } from '../src/client.js'
import { createServiceClient } from '../src/service.js'
import {
	EmptySchema,
	SimpleRequestSchema,
	SimpleResponseSchema,
	StreamingInputCallRequestSchema,
	StreamingInputCallResponseSchema,
	StreamingOutputCallRequestSchema,
	StreamingOutputCallResponseSchema,
} from './interop_pb.js'

function method<
	Request extends DescMessage,
	Response extends DescMessage,
	RequestStream extends boolean,
	ResponseStream extends boolean,
>(
	name: string,
	request: Request,
	response: Response,
	requestStream: RequestStream,
	responseStream: ResponseStream
) {
	return {
		path: `/grpc.testing.TestService/${name}`,
		requestStream,
		responseStream,
		requestSerialize: (value: MessageInitShape<Request>) =>
			toBinary(request, create(request, value)),
		responseDeserialize: (bytes: Uint8Array) => fromBinary(response, bytes),
		requestDeserialize: (bytes: Uint8Array) => fromBinary(request, bytes),
		responseSerialize: (value: MessageInitShape<Response>) =>
			toBinary(response, create(response, value)),
	}
}

export let definition = {
	empty: method('EmptyCall', EmptySchema, EmptySchema, false, false),
	unary: method('UnaryCall', SimpleRequestSchema, SimpleResponseSchema, false, false),
	server: method(
		'StreamingOutputCall',
		StreamingOutputCallRequestSchema,
		StreamingOutputCallResponseSchema,
		false,
		true
	),
	client: method(
		'StreamingInputCall',
		StreamingInputCallRequestSchema,
		StreamingInputCallResponseSchema,
		true,
		false
	),
	bidi: method(
		'FullDuplexCall',
		StreamingOutputCallRequestSchema,
		StreamingOutputCallResponseSchema,
		true,
		true
	),
}

function goBinary(): string {
	let binary = process.env.GRPC_TEST_GO_SERVER
	if (!binary || !isAbsolute(binary)) {
		throw new Error(
			'GRPC_TEST_GO_SERVER must name the absolute path to the built Go interop peer'
		)
	}
	return binary
}

export async function goClient(
	address: string,
	scenario: string,
	signal: AbortSignal,
	ca?: string
): Promise<void> {
	let args = ['-target', address, '-case', scenario]
	if (ca) args.push('-ca', ca)
	await promisify(execFile)(goBinary(), args, { signal })
}

export async function goPeer(signal: AbortSignal, gzip = false) {
	let child = spawn(goBinary(), gzip ? ['-gzip'] : [], { stdio: ['ignore', 'pipe', 'pipe'] })
	let ready = Promise.withResolvers<string>()
	let exited = Promise.withResolvers<{ code: number | null; signal: string | null }>()
	let stderr = ''
	let output = createInterface({ input: child.stdout })
	let failure: Error | undefined
	child.stderr.setEncoding('utf8')
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk
	})
	output.once('line', (address) => {
		if (!/^127\.0\.0\.1:\d+$/.test(address)) {
			failure = new Error(`Unexpected Go interop address: ${address}`)
			ready.reject(failure)
			return
		}
		ready.resolve(address)
	})
	child.once('error', (error) => {
		failure = error
		ready.reject(error)
	})
	child.once('close', (code, exitSignal) => {
		exited.resolve({ code, signal: exitSignal })
		ready.reject(new Error(`Go interop server exited before readiness: ${stderr}`))
	})
	let disposed = false
	let stop = async () => {
		if (disposed) return
		disposed = true
		child.kill('SIGTERM')
		let timeout = setTimeout(() => child.kill('SIGKILL'), 1000).unref()
		try {
			let status = await exited.promise
			if (failure) throw failure
			if (status.code !== 0 || status.signal !== null) {
				throw new Error(
					`Go interop server did not exit cleanly: ${JSON.stringify(status)} ${stderr}`
				)
			}
		} finally {
			clearTimeout(timeout)
			output.close()
		}
	}
	try {
		let address = await abortable(signal, ready.promise)
		let transport = new Client(`http://${address}`)
		return {
			client: createServiceClient(definition, transport),
			transport,
			async [Symbol.asyncDispose]() {
				transport.close()
				await stop()
			},
		}
	} catch (error) {
		await stop()
		throw error
	}
}
