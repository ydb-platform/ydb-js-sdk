import * as assert from 'node:assert/strict'

import { create, fromBinary } from '@bufbuild/protobuf'
import {
	AlterNodeRequestSchema,
	type Config,
	ConfigSchema,
	ConsistencyMode,
	CoordinationServiceDefinition,
	CreateNodeRequestSchema,
	DescribeNodeRequestSchema,
	DescribeNodeResultSchema,
	DropNodeRequestSchema,
	RateLimiterCountersMode,
} from '@ydbjs/api/coordination'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import type { Entry } from '@ydbjs/api/scheme'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'
import type { Client } from 'nice-grpc'

let dbg = loggers.coordination.extend('node')

export interface CoordinationNodeConfig {
	selfCheckPeriod?: number
	sessionGracePeriod?: number

	readConsistencyMode?: ConsistencyMode
	attachConsistencyMode?: ConsistencyMode
	rateLimiterCountersMode?: RateLimiterCountersMode
}

export interface CoordinationNodeDescription {
	self?: Entry
	config: CoordinationNodeConfig
}

export class CoordinationNodeRuntime {
	#client: Client<typeof CoordinationServiceDefinition>

	constructor(driver: Driver) {
		this.#client = driver.createClient(CoordinationServiceDefinition)
	}

	async describe(path: string, signal?: AbortSignal): Promise<CoordinationNodeDescription> {
		dbg.log('reading configuration of coordination node at %s', path)
		let request = create(DescribeNodeRequestSchema, { path })
		let response = signal
			? await this.#client.describeNode(request, { signal })
			: await this.#client.describeNode(request)

		assert.ok(response.operation, 'Missing operation in coordination response')
		assert.ok(response.operation.ready, 'Coordination operation is not ready')
		assert.strictEqual(
			response.operation.status,
			StatusIds_StatusCode.SUCCESS,
			new YDBError(response.operation.status, response.operation.issues)
		)

		assert.ok(response.operation.result, 'Missing result in coordination response')

		let describeResult = fromBinary(DescribeNodeResultSchema, response.operation.result.value)

		assert.ok(describeResult.config, 'Missing config in coordination node description')

		let description: CoordinationNodeDescription = {
			config: fromNodeConfigMessage(describeResult.config),
		}

		if (describeResult.self) {
			description.self = describeResult.self
		}

		return description
	}

	async create(path: string, cfg: CoordinationNodeConfig, signal?: AbortSignal): Promise<void> {
		dbg.log('creating coordination node at %s', path)
		let request = create(CreateNodeRequestSchema, { path, config: toNodeConfigMessage(cfg) })
		let response = signal
			? await this.#client.createNode(request, { signal })
			: await this.#client.createNode(request)

		assert.ok(response.operation, 'Missing operation in coordination response')
		assert.ok(response.operation.ready, 'Coordination operation is not ready')

		assert.strictEqual(
			response.operation.status,
			StatusIds_StatusCode.SUCCESS,
			new YDBError(response.operation.status, response.operation.issues)
		)
	}

	async alter(path: string, cfg: CoordinationNodeConfig, signal?: AbortSignal): Promise<void> {
		dbg.log('updating configuration of coordination node at %s', path)
		let request = create(AlterNodeRequestSchema, { path, config: toNodeConfigMessage(cfg) })
		let response = signal
			? await this.#client.alterNode(request, { signal })
			: await this.#client.alterNode(request)

		assert.ok(response.operation, 'Missing operation in coordination response')
		assert.ok(response.operation.ready, 'Coordination operation is not ready')

		assert.strictEqual(
			response.operation.status,
			StatusIds_StatusCode.SUCCESS,
			new YDBError(response.operation.status, response.operation.issues)
		)
	}

	async drop(path: string, signal?: AbortSignal): Promise<void> {
		dbg.log('dropping coordination node at %s', path)
		let request = create(DropNodeRequestSchema, { path })
		let response = signal
			? await this.#client.dropNode(request, { signal })
			: await this.#client.dropNode(request)

		assert.ok(response.operation, 'Missing operation in coordination response')
		assert.ok(response.operation.ready, 'Coordination operation is not ready')

		assert.strictEqual(
			response.operation.status,
			StatusIds_StatusCode.SUCCESS,
			new YDBError(response.operation.status, response.operation.issues)
		)
	}
}

let toNodeConfigMessage = function toNodeConfigMessage(config: CoordinationNodeConfig) {
	let configMessage = create(ConfigSchema, {
		selfCheckPeriodMillis: config.selfCheckPeriod ?? 0,
		sessionGracePeriodMillis: config.sessionGracePeriod ?? 0,
		readConsistencyMode: config.readConsistencyMode ?? ConsistencyMode.UNSET,
		attachConsistencyMode: config.attachConsistencyMode ?? ConsistencyMode.UNSET,
		rateLimiterCountersMode: config.rateLimiterCountersMode ?? RateLimiterCountersMode.UNSET,
	})

	return configMessage
}

let fromNodeConfigMessage = function fromNodeConfigMessage(config: Config): CoordinationNodeConfig {
	let nodeConfig: CoordinationNodeConfig = {
		selfCheckPeriod: config.selfCheckPeriodMillis ?? undefined,
		sessionGracePeriod: config.sessionGracePeriodMillis ?? undefined,
		readConsistencyMode: config.readConsistencyMode ?? ConsistencyMode.UNSET,
		attachConsistencyMode: config.attachConsistencyMode ?? ConsistencyMode.UNSET,
		rateLimiterCountersMode: config.rateLimiterCountersMode ?? RateLimiterCountersMode.UNSET,
	}

	return nodeConfig
}
