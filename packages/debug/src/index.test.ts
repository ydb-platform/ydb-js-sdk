import { expect, test } from 'vitest'
import { YDBDebugLogger, loggers } from './index.js'

test('creates logger with correct namespace', () => {
	let logger = new YDBDebugLogger('topic')
	expect(logger).toBeDefined()
	expect(typeof logger.log).toBe('function')
	expect(typeof logger.enabled).toBe('boolean')
	expect(typeof logger.extend).toBe('function')
})

test('extends logger correctly', () => {
	let topicLogger = new YDBDebugLogger('topic')
	let writerLogger = topicLogger.extend('writer')
	expect(writerLogger).toBeDefined()
})

test('handles enabled state correctly', () => {
	let isEnabled = new YDBDebugLogger('topic').enabled
	expect(typeof isEnabled).toBe('boolean')
})

test('provides all expected logger categories', () => {
	expect(loggers.auth).toBeDefined()
	expect(loggers.grpc).toBeDefined()
	expect(loggers.driver).toBeDefined()
	expect(loggers.query).toBeDefined()
	expect(loggers.topic).toBeDefined()
	expect(loggers.tx).toBeDefined()
	expect(loggers.retry).toBeDefined()
	expect(loggers.error).toBeDefined()
})

test('logs messages without throwing', () => {
	expect(() => {
		loggers.topic.log('test message')
		loggers.auth.log('auth test with %s', 'parameter')
	}).not.toThrow()
})
