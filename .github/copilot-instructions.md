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
- Use concise and clear test names that reflect the behavior being tested
- Add descriptive verbs when helpful for clarity (e.g., 'expects', 'treats', 'handles', 'applies', 'accepts', 'respects')
- Be specific about the scenario being tested
- Avoid redundant context in test names (e.g., don't repeat the function name being tested)
- Use consistent terminology throughout the codebase

## Test Naming Examples

**Good examples:**

- `'processes string template'` - clear action and subject
- `'handles single issue'` - what it handles
- `'creates commit error'` - what it creates
- `'expects error is retryable'` - what it expects
- `'accepts custom configuration'` - what it accepts
- `'stops when limit exceeded'` - specific condition and behavior

**Avoid:**

- `'function with custom parameter'` - redundant function name prefix
- `'test that method works'` - vague and obvious
- `'should process correctly'` - unnecessary "should" word
- `'validates input properly'` - vague adverb
