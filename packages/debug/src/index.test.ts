import { expect, test } from 'vitest'
import { loggers, ydbLogger } from './index.js'

test('creates logger with correct namespace', () => {
	let logger = ydbLogger.createLogger('topic', 'writer')
	expect(logger).toBeDefined()
	expect(typeof logger.log).toBe('function')
	expect(typeof logger.enabled).toBe('boolean')
	expect(typeof logger.extend).toBe('function')
})

test('extends logger correctly', () => {
	let topicLogger = ydbLogger.createLogger('topic')
	let writerLogger = topicLogger.extend('writer')
	expect(writerLogger).toBeDefined()
})

test('handles enabled state correctly', () => {
	let isEnabled = ydbLogger.isEnabled('topic')
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
