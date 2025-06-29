# Coding Style Guidelines

## Comments

- Use comments to explain why certain decisions were made in the code
- Avoid obvious comments that state what the code is doing
- Write comments in English, always.

## Variable Declarations

- Always use `let` instead of `const` for variable declarations, even if the variable is not reassigned
- This applies to all JavaScript and TypeScript code

## Code Formatting

- Use tabs for indentation (tabWidth: 4)
- Use single quotes for strings
- No semicolons at the end of statements (semi: false)
- Maximum line length: 120 characters
- Use trailing comma in ES5 style
- Include spaces inside curly braces (bracketSpacing: true)

## TypeScript Preferences

- Use `#` prefix for private fields
- Prefer explicit types when possible

## JSON Preferences

- Use double quotes for keys and string values
- No trailing commas
- Always include whitespace after colons

# Testing Guidelines

- Write tests for all new features and bug fixes
- Use a vitest testing framework
- Aim for high test coverage, but prioritize critical paths
- Include both unit tests and integration tests

## Test Structure

- **Never use nested `describe` blocks** - keep tests flat
- **Use `test()` function only** - never use `it()`
- **One test per `test()` call** - no grouping or nesting
- **Import pattern**: `import { test, expect } from 'vitest'`
- **Use tabs for indentation** - same as all other code in the project

```typescript
// Good - flat structure with tabs
import { test, expect } from 'vitest'

test('processes string template', () => {
  // test implementation
})

test('handles single issue', () => {
  // test implementation
})

// Bad - nested structure
describe('MyClass', () => {
  describe('method', () => {
    it('should work', () => {
      // NO - don't use this pattern
    })
  })
})
```

## Test Naming

- Use concise and clear test names that reflect the behavior being tested
- Add descriptive verbs when helpful for clarity (e.g., 'expects', 'treats', 'handles', 'applies', 'accepts', 'respects')
- Be specific about the scenario being tested
- Avoid redundant context in test names (e.g., don't repeat the function name being tested)
- Use consistent terminology throughout the codebase
- **Never use "should" in test names** - state what the test does directly

## Test Naming Examples

**Good examples:**

- `'processes string template'` - clear action and subject
- `'handles single issue'` - what it handles
- `'creates commit error'` - what it creates
- `'expects error is retryable'` - what it expects
- `'accepts custom configuration'` - what it accepts
- `'stops when limit exceeded'` - specific condition and behavior

**Avoid:**

- `'should process correctly'` - unnecessary "should" word and vague adverb
- `'validates input properly'` - vague adverb "properly"
- `'function with custom parameter'` - redundant function name prefix
- `'test that method works'` - vague and obvious
- `'MyClass > method > should work'` - nested naming from describe/it structure

# Debug Logging Guidelines

## Overview

Use the centralized `@ydbjs/debug` package for all logging. Import `loggers` directly from `@ydbjs/debug`.

## Basic Usage

```typescript
import { loggers } from '@ydbjs/debug'

// Create scoped logger for specific component
let dbg = loggers.topic.extend('writer')

// Log messages (note: use .log() method)
dbg.log('creating writer with producer: %s', producerId)
dbg.log('error during %s: %O', operation, error)
```

## Available Categories

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

## Message Patterns

### Lifecycle

```typescript
dbg.log('creating %s with producer: %s', componentName, producerId)
dbg.log('%s closed gracefully', componentName)
dbg.log('%s destroyed, reason: %O', componentName, reason)
```

### Network Operations

```typescript
dbg.log('connecting to %s', endpoint)
dbg.log('received server message: %s, status: %d', messageType, status)
dbg.log('%s %s', method, status) // 'POST OK'
```

### Error Handling

```typescript
dbg.log('error during %s: %O', operation, error)
dbg.log('retrying %s, attempt %d, error: %O', operation, attempt, error)
```

### Performance

```typescript
dbg.log('waiting for inflight messages, inflight: %d, buffer: %d', inflightCount, bufferCount)
dbg.log('processed %d messages in %dms', count, duration)
```

## Rules

- Always import `loggers` directly: `import { loggers } from '@ydbjs/debug'`
- Create scoped loggers: `let dbg = loggers.category.extend('subcategory')`
- Always use `dbg.log()` method, not `dbg()` directly
- Use `%s` for strings, `%d` for numbers, `%O` for objects/errors
- Include context (IDs, counts, durations) in messages
- Use present tense for ongoing actions, past tense for completed
- Never log sensitive data (tokens, passwords, user data)
- Use conditional logging for expensive operations: `if (dbg.enabled) { ... }`

# Writing LLM Instructions

When adding new guidelines to this file:

## Structure Requirements

- **Headers**: Use clear, specific section names
- **Examples**: Always include code examples for complex concepts
- **Rules**: Make rules actionable with specific do/don't statements
- **Context**: Explain why the rule exists when not obvious

## Writing Style

- **Be concise**: One rule per bullet point
- **Be specific**: Avoid vague terms like "properly", "correctly", "good"
- **Use examples**: Show good vs bad patterns with code
- **Use imperatives**: "Use X instead of Y", not "You should use X"
- **Include negative examples**: Show what NOT to do with explicit "Bad" examples

## Content Guidelines

- **Focus on automation**: Write rules that LLMs can follow consistently
- **Avoid subjective rules**: Preferences that can't be checked automatically
- **Group related concepts**: Keep similar rules in the same section
- **Update examples**: Keep code examples current with latest patterns
- **Be explicit about structure**: Don't assume LLMs will infer patterns from context

## Critical Rule for LLMs

**ALWAYS follow ALL guidelines in this file when writing code.** This includes:

- Code formatting rules (tabs for indentation, single quotes, no semicolons)
- Variable declaration patterns (`let` instead of `const`)
- Test structure (flat `test()` calls, no `describe`/`it`)
- Debug logging patterns (import from `@ydbjs/debug`)
- Naming conventions for tests and variables
- **Indentation: ALWAYS use tabs, never spaces** - this applies to ALL code including tests

**When in doubt, refer back to the specific section** - don't make assumptions about acceptable alternatives.

## Example Structure

````markdown
# Section Name

## Overview

Brief explanation of what this section covers.

## Basic Usage

```typescript
// Simple, clear example
```
````

## Rules

- Specific, actionable rule with example
- Another rule with code snippet

## Examples

```typescript
// Good example
let goodCode = 'clear and follows rules'

// Bad example
let badCode = 'unclear or breaks rules'
```

```

This ensures instructions are:
- **Actionable** - LLMs can follow them precisely
- **Consistent** - Same format across all sections
- **Complete** - Include context, examples, and rationale
- **Maintainable** - Easy to update as patterns evolve
```
