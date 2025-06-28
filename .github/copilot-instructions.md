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
