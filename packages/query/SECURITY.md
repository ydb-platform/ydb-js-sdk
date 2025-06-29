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
import { Optional, Int32 } from '@ydbjs/value'

// Use Optional for nullable database values
let userId = userInput?.id ? new Int32(userInput.id) : Optional.int32()
yql`SELECT * FROM users WHERE id = ${userId}`

// Validate and default user inputs
let limit = Math.min(userInput.limit ?? 10, 100) // Prevent large queries
yql`SELECT * FROM posts LIMIT ${limit}`

// Use safe string handling
let searchTerm = (userInput.search || '').trim()
if (searchTerm.length > 0) {
  yql`SELECT * FROM posts WHERE title LIKE ${searchTerm}`
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
// Values are automatically parameterized
let userId = 123
let status = "'; DROP TABLE users; --"
yql`SELECT * FROM users WHERE id = ${userId} AND status = ${status}`
// Results in: SELECT * FROM users WHERE id = $p0 AND status = $p1
// With parameters: { $p0: Int32(123), $p1: Text("'; DROP TABLE users; --") }
```

#### ❌ Dangerous - String concatenation:

```typescript
// NEVER DO THIS - Direct string concatenation
let userId = '123; DROP TABLE users; --'
let dangerousQuery = `SELECT * FROM users WHERE id = ${userId}`
yql(dangerousQuery) // ⚠️ VULNERABLE TO SQL INJECTION
```

#### Dynamic identifiers and special cases:

```typescript
// For table/column names, use identifier()
let tableName = 'users'
let columnName = 'email'
yql`SELECT ${identifier(columnName)} FROM ${identifier(tableName)} WHERE id = ${userId}`

// For migration scripts or trusted contexts, use unsafe()
let trustedSqlFragment = 'ORDER BY created_at DESC'
yql`SELECT * FROM users ${unsafe(trustedSqlFragment)}`
```

**Key principles:**

- **Always use template literals** with `yql\`query\`` syntax
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
