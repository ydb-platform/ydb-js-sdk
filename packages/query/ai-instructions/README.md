# AI Assistant Instructions for YDB Query Package

This directory contains example configuration files to help AI assistants generate secure YQL code when using @ydbjs/query.

## Available Files

### `.cursorrules.example`

Configuration for **Cursor AI** editor. Copy to your project root as `.cursorrules` to enable AI-generated code that follows YDB security patterns.

### `.instructions.example.md`

General AI assistant instructions. Compatible with most AI coding assistants. Copy to your project root as `.instructions.md`.

### `.ai-instructions.example.md`

Alternative format for general AI assistants. Copy to your project root as `.ai-instructions.md`.

### `.copilot-instructions.example.md`

Specific instructions for **GitHub Copilot**. Copy to your project root as `.copilot-instructions.md`.

## Quick Setup

Choose the appropriate file for your AI assistant:

```bash
# For Cursor AI
cp node_modules/@ydbjs/query/ai-instructions/.cursorrules.example .cursorrules

# For GitHub Copilot
cp node_modules/@ydbjs/query/ai-instructions/.copilot-instructions.example.md .copilot-instructions.md

# For general AI assistants
cp node_modules/@ydbjs/query/ai-instructions/.instructions.example.md .instructions.md
# OR
cp node_modules/@ydbjs/query/ai-instructions/.ai-instructions.example.md .ai-instructions.md
```

## What These Files Do

These configuration files ensure that AI assistants:

- ✅ **Always use template literals** for YQL queries
- ✅ **Never concatenate user input** into query strings
- ✅ **Use proper TypeScript types** from @ydbjs/value
- ✅ **Validate user inputs** before passing to queries
- ✅ **Handle null/undefined values** safely
- ✅ **Use identifier()** for dynamic table/column names
- ✅ **Use unsafe()** only in trusted contexts

This prevents SQL injection vulnerabilities and ensures type safety.

## For More Information

See the complete security guidelines in `../SECURITY.md`.
