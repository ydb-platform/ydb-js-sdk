import { loggers, ydbLogger } from '@ydbjs/debug'

// Example 1: Using predefined loggers
function basicUsage() {
    // Topic operations
    let topicLogger = loggers.topic.extend('writer')
    topicLogger.log('creating writer with producer: %s', 'my-producer')
    topicLogger.log('writer connected successfully')

    // Authentication
    let authLogger = loggers.auth.extend('metadata')
    authLogger.log('fetching token from metadata service')
    authLogger.log('token refreshed successfully')

    // gRPC operations
    loggers.grpc.log('POST /Ydb.Topic.StreamWrite OK')
    loggers.grpc.log('GET /Ydb.Auth.Login FAILED: %s', 'Invalid credentials')
}

// Example 2: Error handling patterns
function errorHandling() {
    let dbg = loggers.topic.extend('reader')

    try {
        // Some operation that might fail
        throw new Error('Connection failed')
    } catch (error) {
        dbg.log('error during stream read: %O', error)
        throw error
    }
}

// Example 3: Retry patterns
function retryPattern() {
    let dbg = loggers.retry.extend('connection')

    // Simulating retry logic
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            dbg.log('connection attempt #%d', attempt)
            // ... connection logic
            dbg.log('connected successfully on attempt #%d', attempt)
            break
        } catch (error) {
            dbg.log('retrying connection, attempt %d, error: %O', attempt, error)
        }
    }
}

// Example 4: Performance monitoring
function performanceMonitoring() {
    let dbg = loggers.perf.extend('query')

    let startTime = Date.now()
    // ... query execution
    let duration = Date.now() - startTime

    dbg.log('query executed in %dms', duration)
    dbg.log('processed %d rows', 1000)
}

// Example 5: Conditional logging for expensive operations
function conditionalLogging() {
    let dbg = loggers.driver.extend('discovery')

    if (dbg.enabled) {
        let expensiveData = computeExpensiveDebugInfo()
        dbg.log('discovery endpoints: %O', expensiveData)
    }
}

function computeExpensiveDebugInfo() {
    // Simulate expensive computation
    return { endpoints: ['localhost:2136'], status: 'healthy' }
}

// Example 6: Background task logging
async function backgroundTaskLogging() {
    let dbg = loggers.topic.extend('background')

    try {
        dbg.log('background token refresher started')

        // Simulate background task
        setInterval(() => {
            dbg.log('refreshing token')
        }, 60000)

    } catch (error) {
        dbg.log('background token refresher error: %O', error)
    }
}

// Example 7: Creating custom scoped loggers
function customScopedLoggers() {
    // Create a logger for a specific session
    let sessionLogger = ydbLogger.createLogger('session', 'abc123')
    sessionLogger.log('session created')
    sessionLogger.log('executing query: SELECT * FROM users')
    sessionLogger.log('session closed')

    // Create a logger for a specific transaction
    let txLogger = loggers.tx.extend('tx_456')
    txLogger.log('transaction started')
    txLogger.log('committing transaction')
    txLogger.log('transaction committed successfully')
}

// Example 8: Driver lifecycle logging
class Driver {
    private dbg = loggers.driver

    async connect() {
        this.dbg.log('connecting to YDB cluster')
        // ... connection logic
        this.dbg.log('connected successfully')
    }

    async discover() {
        let discoveryLogger = this.dbg.extend('discovery')
        discoveryLogger.log('starting endpoint discovery')
        // ... discovery logic
        discoveryLogger.log('discovered %d endpoints', 3)
    }

    destroy(reason?: Error) {
        this.dbg.log('driver destroyed, reason: %O', reason)
    }
}

export {
    basicUsage,
    errorHandling,
    retryPattern,
    performanceMonitoring,
    conditionalLogging,
    backgroundTaskLogging,
    customScopedLoggers,
    Driver
}
