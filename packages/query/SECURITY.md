# YQL Security Best Practices

## 🛡️ Input Validation & Safety

### Null/Undefined Protection

The `yql` function enforces strict validation to prevent common security vulnerabilities:

- **No null/undefined values**: JavaScript `null` and `undefined` are rejected with detailed error messages
- **Position tracking**: Errors include exact parameter position for quick debugging
- **Type safety**: Use YDB Optional types for nullable database values

### Secure Usage Patterns

#### ✅ Safe:

```typescript
import { query } from '@ydbjs/query'
import { Optional, Int32 } from '@ydbjs/value'

const sql = query(driver)

// Use Optional for nullable database values
let userId = userInput?.id ? new Int32(userInput.id) : Optional.int32()
await sql`SELECT * FROM users WHERE id = ${userId}`

// Validate and default user inputs
let limit = Math.min(userInput.limit ?? 10, 100) // Prevent large queries
await sql`SELECT * FROM posts LIMIT ${limit}`

// Use safe string handling
let searchTerm = (userInput.search || '').trim()
if (searchTerm.length > 0) {
  await sql`SELECT * FROM posts WHERE title LIKE ${searchTerm}`
}
```

#### ❌ Unsafe:

```typescript
// NEVER: Direct user input without validation
yql`SELECT * FROM users WHERE id = ${req.body.userId}` // May be null/undefined

// NEVER: String concatenation with user input
let userInput = '1; DROP TABLE users; --'
let dangerousQuery = `SELECT * FROM users WHERE id = ${userInput}`
yql(dangerousQuery) // ⚠️ VULNERABLE TO SQL INJECTION

// NEVER: Uncontrolled limits
yql`SELECT * FROM posts LIMIT ${userInput.limit}` // Potential DoS

// NEVER: Unvalidated parameters
let userId: number // undefined
yql`SELECT * FROM users WHERE id = ${userId}` // Runtime error
```

### SQL Injection Prevention

**Template literals provide automatic protection**: When using template strings, all interpolated values are automatically wrapped as YDB Value objects and passed as parameters, not concatenated directly into the query string. This eliminates SQL injection risks.

#### ✅ Safe - Template literals (recommended):

```typescript
import { query } from '@ydbjs/query'
const sql = query(driver)

// Values are automatically parameterized
let userId = 123
let status = "'; DROP TABLE users; --"
await sql`SELECT * FROM users WHERE id = ${userId} AND status = ${status}`
// Results in: SELECT * FROM users WHERE id = $p0 AND status = $p1
// With parameters: { $p0: Int32(123), $p1: Text("'; DROP TABLE users; --") }
```

#### ❌ Dangerous - String concatenation:

```typescript
// NEVER DO THIS - Direct string concatenation
let userId = '123; DROP TABLE users; --'
let dangerousQuery = `SELECT * FROM users WHERE id = ${userId}`
// yql(dangerousQuery) // (internal helper) ⚠️ VULNERABLE TO SQL INJECTION
// await sql(dangerousQuery as any) // also unsafe
```

#### Dynamic identifiers and special cases:

```typescript
import { identifier, unsafe } from '@ydbjs/query'

// For table/column names, use identifier()
let tableName = 'users'
let columnName = 'email'
await sql`SELECT ${identifier(columnName)} FROM ${identifier(tableName)} WHERE id = ${userId}`

// For migration scripts or trusted contexts, use unsafe()
let trustedSqlFragment = 'ORDER BY created_at DESC'
await sql`SELECT * FROM users ${unsafe(trustedSqlFragment)}`
```

**Key principles:**

- **Always use template literals** with `sql\`query\``syntax (returned by`query(driver)`)
- **Never concatenate user input** into query strings manually
- **Use identifier()** for dynamic table/column names
- **Use unsafe()** only for trusted, non-user-facing code (migrations, etc.)
- **Validate input types** before passing to `yql`

### TypeScript Security Configuration

Enable strict TypeScript settings to catch issues at compile time:

```json
{
  "compilerOptions": {
    "strict": true,
    "strictNullChecks": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

## 🚨 Security Checklist

- [ ] **Always use template literals**: `yql\`SELECT \* FROM users WHERE id = ${userId}\``
- [ ] **Never concatenate strings manually**: Avoid `yql(queryString)` with pre-built strings
- [ ] All user inputs validated before passing to `yql`
- [ ] No direct `null`/`undefined` values in queries
- [ ] TypeScript strict mode enabled
- [ ] Use `identifier()` for dynamic table/column names
- [ ] Use `unsafe()` only for trusted, non-user contexts
- [ ] Input size limits enforced to prevent DoS
- [ ] Error monitoring in place
- [ ] No sensitive data in logs

## 🤖 AI Assistant Configuration

To ensure AI code assistants (GitHub Copilot, Cursor, etc.) generate secure YQL code, use the example configuration files provided in the `ai-instructions/` directory:

### Available Example Files:

- **`ai-instructions/.cursorrules.example`** - For Cursor AI (legacy format, widely supported)
- **`ai-instructions/.instructions.example.md`** - General AI assistant guidelines
- **`ai-instructions/.ai-instructions.example.md`** - Alternative general format
- **`ai-instructions/.copilot-instructions.example.md`** - Specific for GitHub Copilot

### Quick Setup:

```bash
# For Cursor users
cp node_modules/@ydbjs/query/ai-instructions/.cursorrules.example .cursorrules

# For GitHub Copilot users
cp node_modules/@ydbjs/query/ai-instructions/.copilot-instructions.example.md .copilot-instructions.md

# For general AI assistants
cp node_modules/@ydbjs/query/ai-instructions/.instructions.example.md .instructions.md
# OR
cp node_modules/@ydbjs/query/ai-instructions/.ai-instructions.example.md .ai-instructions.md
```

### Modern Cursor Setup (recommended):

For the latest Cursor versions, consider using the new `.cursor/rules/` format instead of legacy `.cursorrules`.

This ensures AI assistants understand YQL security requirements and generate safe code patterns.

## Validating Dynamic Identifiers (Allow‑list Examples)

When using identifier() with dynamic values, validate or allow‑list inputs before passing them.

Example: strict allow‑list of table names

```ts
import { identifier } from '@ydbjs/query'

const allowedTables = new Set(['users', 'orders', 'invoices'])

function safeTable(name: string) {
  if (!allowedTables.has(name)) throw new Error('Unknown table')
  return identifier(name)
}

await sql`SELECT * FROM ${safeTable(userInput.table)}`
```

Example: validate column name by pattern

```ts
import { identifier } from '@ydbjs/query'

const columnRe = /^[A-Za-z_][A-Za-z0-9_]*$/

function safeColumn(name: string) {
  if (!columnRe.test(name)) throw new Error('Invalid column name')
  return identifier(name)
}

await sql`SELECT ${safeColumn(userInput.column)} FROM ${identifier('users')}`
```

Example: mapping external inputs to known internal identifiers

```ts
import { identifier } from '@ydbjs/query'

const sortMap: Record<string, string> = {
  newest: 'created_at',
  popular: 'views',
}

function sortColumn(key: string) {
  const col = sortMap[key]
  if (!col) throw new Error('Unsupported sort key')
  return identifier(col)
}

await sql`SELECT * FROM posts ORDER BY ${sortColumn(userInput.sort)} DESC`
```
