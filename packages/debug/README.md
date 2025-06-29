# @ydbjs/debug

Centralized debug logging for YDB JavaScript SDK, inspired by Playwright's debug architecture.

## Features

- **Centralized logging**: Single logger instance with category-based organization
- **Color-coded output**: Different colors for different categories
- **Scoped loggers**: Create focused loggers for specific components
- **Standard debug interface**: Compatible with the popular `debug` package
- **TypeScript support**: Full type safety for log categories

## Quick Start

### Installation

```bash
npm install @ydbjs/debug
```

### Basic Usage Example

```typescript
import { loggers } from '@ydbjs/debug'

// Create a topic writer with debug logging
class TopicWriter {
  private dbg = loggers.topic.extend('writer')

  constructor(producerId: string) {
    this.dbg.log('creating writer with producer: %s', producerId)
  }

  async connect() {
    this.dbg.log('connecting to topic service')
    try {
      // ... connection logic
      this.dbg.log('connected successfully')
    } catch (error) {
      this.dbg.log('error during connection: %O', error)
      throw error
    }
  }

  write(message: Uint8Array) {
    if (this.dbg.enabled) {
      this.dbg.log('writing message, size: %d bytes', message.length)
    }
    // ... write logic
  }

  destroy(reason?: Error) {
    this.dbg.log('writer destroyed, reason: %O', reason)
  }
}
```

### Running with Debug Output

```bash
# Enable all YDB debug output
DEBUG=ydbjs:* node app.js

# Enable only topic-related debugging
DEBUG=ydbjs:topic:* node app.js

# Enable specific writer debugging
DEBUG=ydbjs:topic:writer node app.js
```

### Sample Output

```
ydbjs:topic:writer creating writer with producer: my-producer +0ms
ydbjs:topic:writer connecting to topic service +2ms
ydbjs:topic:writer connected successfully +45ms
ydbjs:topic:writer writing message, size: 1024 bytes +1ms
ydbjs:topic:writer writer destroyed, reason: Error: shutdown +2s
```

## Usage

### Basic Usage

```typescript
import { loggers } from '@ydbjs/debug'

// Use predefined category loggers
loggers.topic.log('starting topic writer for producer %s', producerId)
loggers.auth.log('refreshing token')
loggers.grpc.log('%s %s', method, status)
```

### Creating Scoped Loggers

```typescript
import { ydbLogger } from '@ydbjs/debug'

// Create a logger for a specific category and subcategory
let writerLogger = ydbLogger.createLogger('topic', 'writer')
writerLogger.log('writer initialized with producer %s', producerId)

// Extend an existing logger
let authLogger = loggers.auth.extend('metadata')
authLogger.log('fetching token from metadata service')
```

### Available Categories

- `api` - API calls and responses
- `auth` - Authentication and token management
- `grpc` - gRPC client operations
- `driver` - Driver lifecycle and connection management
- `discovery` - Service discovery
- `session` - Session management
- `query` - Query execution
- `topic` - Topic operations
- `tx` - Transaction operations
- `retry` - Retry logic
- `error` - Error handling
- `perf` - Performance metrics
- `error` - Error handling
- `perf` - Performance metrics

## Environment Variables

Enable debug logging using the `DEBUG` environment variable:

```bash
# Enable all YDB logging
DEBUG=ydbjs:* node app.js

# Enable specific categories
DEBUG=ydbjs:topic:*,ydbjs:auth:* node app.js

# Enable specific subcategories
DEBUG=ydbjs:topic:writer node app.js
```

## Integration with YDB SDK

This package is designed specifically for the YDB JavaScript SDK and provides consistent logging across all SDK components:

```typescript
// Different components using consistent debug categories
loggers.auth.log('token refreshed successfully')
loggers.grpc.log('POST /Ydb.Topic.StreamWrite OK')
loggers.driver.log('driver initialized with %d endpoints', 3)
loggers.session.log('created new session, active: %d', 5)
```

## Architecture

The debug system follows Playwright's centralized approach:

- **Single logger instance** (`YDBDebugLogger`) manages all debug output
- **Category-based organization** with predefined categories
- **Color coding** for visual distinction in terminal output
- **Efficient caching** of debug instances to avoid recreation

This approach provides better performance and consistency compared to creating individual debug instances throughout the codebase.
