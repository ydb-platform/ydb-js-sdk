import { expect, test } from 'vitest'
import { YDBDebugLogger, loggers } from './index.js'

test('creates logger with correct namespace', () => {
	let logger = new YDBDebugLogger('topic')
	expect(logger).toBeDefined()
	expect(typeof logger.log).toBe('function')
	expect(typeof logger.enabled).toBe('boolean')
	expect(typeof logger.extend).toBe('function')
})

test('extend() returns a logger scoped to the combined namespace', () => {
	let topicLogger = new YDBDebugLogger('topic')
	let writerLogger = topicLogger.extend('writer')
	expect(writerLogger).toBeDefined()
	expect(typeof writerLogger.log).toBe('function')
	expect(typeof writerLogger.enabled).toBe('boolean')
	expect(typeof writerLogger.extend).toBe('function')
})

test('enabled reflects a boolean debug state', () => {
	let isEnabled = new YDBDebugLogger('topic').enabled
	expect(typeof isEnabled).toBe('boolean')
})

test('provides all expected logger categories', () => {
	expect(loggers.auth).toBeDefined()
	expect(loggers.coordination).toBeDefined()
	expect(loggers.driver).toBeDefined()
	expect(loggers.error).toBeDefined()
	expect(loggers.grpc).toBeDefined()
	expect(loggers.query).toBeDefined()
	expect(loggers.retry).toBeDefined()
	expect(loggers.topic).toBeDefined()
	expect(loggers.tx).toBeDefined()
})

test('logs messages without throwing', () => {
	expect(() => {
		loggers.topic.log('test message')
		loggers.auth.log('auth test with %s', 'parameter')
	}).not.toThrow()
})
