# Agent Instructions for YDB JavaScript SDK

**Purpose:** This file contains rules and conventions for AI agents, IDE assistants, and developers working with this codebase. It defines how code should be written, tested, and maintained.

## Our Principles

**Maintainability first** - This code will be maintained by others after you. Write for the next person, not for yourself. LLMs and AI agents will work with this code - keep it simple and clear.

**Simple over clever** - Choose elegant, straightforward solutions. Avoid deep nesting and excessive abstractions. If a concept is hard to explain, the implementation is probably wrong.

**Readability over micro-optimizations** - Code that's easy to understand is easier to extend and debug. Prioritize clarity over marginal performance gains.

**Explicit over implicit** - Type annotations in public APIs, clear variable names, meaningful comments that explain WHY. No magic, no surprises.

**Consistency over convenience** - Strict style rules (tabs, `let`, no semicolons) make code predictable. Consistency reduces cognitive load.

## Core Values

- **Easy to maintain:** Flat structure, clear naming, minimal abstractions. Future developers should grasp concepts quickly.
- **Easy to extend:** Adding features shouldn't require rewriting existing code. Modular design with explicit boundaries.
- **Reliable:** Every public API has tests. Type safety is non-negotiable. Errors are caught early, not at runtime.
- **Performant:** This is a database driver - efficiency matters. But not at the cost of code clarity.
- **Secure:** Never log credentials or tokens. Validate external inputs. Handle sensitive data carefully.

---

## Repository Structure

**Type:** npm workspaces monorepo
**Package Manager:** npm >= 10
**Runtime:** Node >= 20.19
**Build Tool:** Turbo
**Test Framework:** Vitest

### Package Architecture

```
@ydbjs/core
  └── depends on: api, auth, error, retry
      Core connection and driver functionality

@ydbjs/query
  └── depends on: core, value, error
      YQL query execution and transactions

@ydbjs/topic
  └── depends on: core, value, error
      Topic API (producers, consumers)

@ydbjs/value
  └── depends on: api
      YDB type system and values

@ydbjs/auth
  └── depends on: (minimal)
      Authentication (tokens, anonymous, metadata)

@ydbjs/retry
  └── depends on: error
      Retry policies and backoff strategies

@ydbjs/error
  └── depends on: api
      YDB error types and handling

@ydbjs/debug
  └── standalone (no internal deps)
      Centralized logging for all packages

@ydbjs/api
  └── standalone
      gRPC/Protobuf service definitions
```

**Important:** Breaking changes require coordination across dependent packages. Examples in `examples/` consume published packages, not local workspace versions

---

## Code Style Rules

### Formatting

- **Indentation:** Tabs (width: 4), always
- **Quotes:** Single quotes for strings
- **Semicolons:** None (semi: false)
- **Line length:** 120 characters max

**Exception:** Markdown and YAML files use 2 spaces

### Variable Declarations

```typescript
// DO: Always use let, even if never reassigned
let count = 0
let config = { timeout: 1000 }

// DON'T: Never use const
const value = 42 // ❌
```

### TypeScript

- Use `#` prefix for private fields
- Prefer explicit types in public APIs
- Enable strict mode

### Comments

- Write in English, always
- Explain WHY, not WHAT
- Avoid obvious comments

```typescript
// DON'T: Obvious
let retries = 3 // Set retries to 3

// DO: Explains decision
let retries = 3 // AWS Lambda timeout is 3s, match retry window
```

---

## Testing Rules

### Structure

**CRITICAL:** Tests must be flat, never nested.

```typescript
// DO: Flat structure with test()
import { test, expect } from 'vitest'

test('processes string template', () => {
  let result = process('hello')
  expect(result).toBe('HELLO')
})

test('handles empty input', () => {
  let result = process('')
  expect(result).toBe('')
})

// DON'T: Nested describe/it blocks
describe('MyClass', () => {
  // ❌
  describe('method', () => {
    // ❌
    it('should work', () => {
      // ❌
      // ...
    })
  })
})
```

### Rules

- Use `test()` function only, never `it()`
- One test per `test()` call
- Import: `import { test, expect } from 'vitest'`

### Naming

- Be specific about scenario
- Use action verbs when helpful: `processes`, `handles`, `expects`, `creates`, `accepts`
- Never use "should" in test names
- No redundant context (don't repeat function name)

```typescript
// DO
test('processes string template')
test('handles single issue')
test('creates commit error')
test('stops when limit exceeded')

// DON'T
test('should process correctly') // ❌ "should" + vague
test('validates input properly') // ❌ vague adverb
test('function with custom parameter') // ❌ redundant prefix
```

### Test Types

- **Unit tests** (`npm run test:uni`) - fast, no external dependencies, always run
- **Integration tests** (`npm run test:int`) - require Docker + local YDB, run for core/driver changes
- **E2E tests** (`npm run test:e2e`) - full system tests, run for breaking changes

---

## Debug Logging

**Package:** `@ydbjs/debug` (centralized logging for all packages)

### Usage Pattern

```typescript
import { loggers } from '@ydbjs/debug'

// Create scoped logger
let dbg = loggers.topic.extend('writer')

// Log messages (use .log() method)
dbg.log('creating writer with producer: %s', producerId)
dbg.log('error during %s: %O', operation, error)
```

### Available Loggers

Main categories: `api`, `auth`, `grpc`, `driver`, `query`, `topic`, `tx`, `retry`, `error`, `perf`

### Formatting

- `%s` for strings
- `%d` for numbers
- `%O` for objects/errors

### Rules

- Always import `loggers` directly: `import { loggers } from '@ydbjs/debug'`
- Create scoped loggers: `loggers.category.extend('subcategory')`
- Use `dbg.log()` method, not `dbg()` directly
- Use present tense for ongoing actions, past tense for completed
- Never log sensitive data (tokens, passwords, user data)
- Conditional logging for expensive operations: `if (dbg.enabled) { ... }`

---

## Development Workflow

### Essential Commands

```bash
npm run build           # Build all packages (Turbo)
npm run test:uni        # Unit tests (fast, no Docker)
npm run test:int        # Integration tests (requires Docker + YDB)
npm run test:all        # All tests (uni + int + e2e)
npm run lint            # Run oxlint
```

### Before Committing (Required)

- ✅ Build passes: `npm run build`
- ✅ Tests pass: `npm run test:uni` (minimum)
- ✅ Lint clean: `npm run lint`
- ✅ Add/update tests for changes
- ✅ Update package README if public API changed

**No shortcuts. No "fix later".**

---

## Agent Workflow

### Command Execution Rules

**CRITICAL:** Never use interactive commands that require user input or interaction.

**Rules:**

- Always use non-interactive flags or parameters for all commands
- Never open editors or interactive prompts that require user input
- Prefer file-based input over interactive prompts
- Use appropriate flags (`--yes`, `--no-interaction`, `--force`) to avoid prompts
- Provide all required parameters directly via command-line arguments or input files

**General principle:** If a command might open an editor, prompt for confirmation, or wait for user input, it must be made non-interactive using appropriate flags or alternative methods.

### Development Process

**Order of operations** (priority: functionality → correctness → style):

1. **Write code** - implement the required functionality
2. **Write tests** - add tests alongside code changes
3. **Verify functionality** - run tests to ensure code works
4. **Check types & build** - verify type safety and successful compilation
5. **Check style** - lint and format (least critical, done last)

### Step-by-Step

**1. Implement changes:**

```bash
# Write code in relevant package(s)
# Write/update tests in the same commit
```

**2. Verify functionality works:**

```bash
npm run test:uni              # Always run unit tests first
npm run test:int              # If core/driver/connection changes
```

**3. Check types and build:**

```bash
npm run build                 # Verify TypeScript compilation and types
```

**4. Check style (last):**

```bash
npm run lint                  # Fix formatting and style issues
```

**5. Add changeset (only when feature complete):**

```bash
npx changeset                 # After all functionality is ready, before/after PR
```

### Cross-Package Changes

When changes affect package dependencies:

**If you modify `@ydbjs/core`:**

- Must test `@ydbjs/query` and `@ydbjs/topic` (they depend on core)
- Run `test:uni` for all affected packages
- Run `test:int` if connection/driver logic changed

**If you modify `@ydbjs/value`:**

- Must test `@ydbjs/query` and `@ydbjs/topic` (they depend on value)
- Especially critical if public types changed

**If you modify `@ydbjs/api`:**

- Rebuild ALL packages (api is foundational)
- Test dependent packages thoroughly

**If you modify public API in any package:**

- Update package README
- Test all packages that import from this package
- Consider if this is breaking change (major version bump)

### Handling Errors

**Test failures** (highest priority):

- Fix immediately - broken functionality
- If test expectations changed, update with clear reason in commit

**Type errors** (high priority):

- Must fix - indicates API contract violation
- Check if dependent packages are affected

**Build failures** (high priority):

- Check circular dependencies
- Verify all imports resolve
- Run from root: `npm run build`

**Lint failures** (lowest priority):

- Fix formatting issues last
- Most are auto-fixable

### Completion Checklist

Before considering changes complete:

- [ ] Code written and tests added in same commit
- [ ] Tests pass: `npm run test:uni` (minimum)
- [ ] Build succeeds: `npm run build`
- [ ] Lint clean: `npm run lint`
- [ ] If public API changed → README updated
- [ ] If dependent packages → tested together
- [ ] If all functionality complete → changeset added
- [ ] No credentials/tokens in logs

**Important:** Changeset is added LAST, when you're confident all required functionality is implemented and tested.

---

## Commits & Pull Requests

### Commit Messages

**Format:**

```
Short summary (50 chars max)

- Bullet point describing what was added/changed
- Another bullet point with details
- Focus on WHAT and WHY, not HOW

Optional: Additional context or reasoning
```

**Rules:**

- First line: action verb + what changed (e.g., "Add", "Fix", "Update", "Refactor")
- Focus on the main goal, not implementation details
- If multiple files changed, describe the feature/fix, not individual files
- Use present tense: "Add feature" not "Added feature"

**Good examples:**

```
Add retry backoff strategy for transient errors

- Implement exponential backoff with jitter
- Add tests for retry behavior
- Update documentation
```

```
Fix memory leak in connection pool

- Close idle connections after timeout
- Add connection lifecycle tests
```

**Bad examples:**

```
Remove old file                          # ❌ What was added? Focus on main goal
Update files                             # ❌ Too vague
Fixed bug                                # ❌ What bug? Where?
```

### Pull Request Descriptions

GitHub automatically loads `.github/pull_request_template.md` when creating a PR.

**IMPORTANT:** Pull request descriptions must be written in English.

**Key points:**

- **What** - describe what the PR does (focus on main goal)
- **Why** - explain the problem being solved
- **Changes** - list main changes, mention breaking changes
- **Testing** - what tests were added/updated
- **Checklist** - changeset (if package changes), README (if public API changed)

### When to Commit

**Commit when:**

- Logical unit of work is complete
- Tests pass for that unit
- Code compiles without errors

**Don't commit:**

- Broken code that doesn't compile
- Failing tests (unless explicitly testing failure)
- Work in progress without clear boundary

**Multiple commits vs single commit:**

- Related changes in same package → single commit
- Independent features → separate commits
- Bug fix + refactor → separate commits (easier to review/revert)

---

## Versioning & Changesets

**We use [Changesets](https://github.com/changesets/changesets) for version management.**

When your changes affect published packages, add a changeset:

```bash
npx changeset
```

Select affected packages, choose bump type (major/minor/patch), write user-facing description.

**Semantic Versioning:**

- **MAJOR:** Breaking API changes
- **MINOR:** Backwards-compatible features
- **PATCH:** Bug fixes, docs, typings

**Important Rules:**

- **DO NOT create CHANGELOG.md files manually** - Changesets automatically generates them from changeset files in `.changeset/` directory
- **Do not add packages to the `fixed` array in `.changeset/config.json`** - we publish packages independently; only introduce fixed groups if we explicitly decide to lock versions again
- Third-parties packages (`third-parties/`) are NOT included in `fixed` array - they version independently

See `RELEASING.md` and `VERSIONING.md` for full release process

---

**Last Updated:** November 2025
**Questions?** Open an issue or see CONTRIBUTING.md
