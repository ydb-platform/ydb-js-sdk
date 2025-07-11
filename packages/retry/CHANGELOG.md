# @ydbjs/retry

## 6.0.1-alpha.32

### Patch Changes

- Small refactoring and TopicWriter2 (ot top of xstate)
- Updated dependencies
  - @ydbjs/abortable@6.0.1-alpha.32
  - @ydbjs/debug@6.0.1-alpha.32
  - @ydbjs/error@6.0.1-alpha.32
  - @ydbjs/api@6.0.1-alpha.32

## 6.0.1-alpha.31

### Patch Changes

- Updated dependencies
  - @ydbjs/api@6.0.1-alpha.31
  - @ydbjs/error@6.0.1-alpha.31
  - @ydbjs/abortable@6.0.1-alpha.31
  - @ydbjs/debug@6.0.1-alpha.31

## 6.0.1-alpha.30

### Patch Changes

- Introduce Table-Topic Transactions
- Updated dependencies
  - @ydbjs/abortable@6.0.1-alpha.30
  - @ydbjs/api@6.0.1-alpha.30
  - @ydbjs/debug@6.0.1-alpha.30
  - @ydbjs/error@6.0.1-alpha.30

## 6.0.0-alpha.29

### Patch Changes

- Add better debug logging
- Updated dependencies
  - @ydbjs/abortable@6.0.0-alpha.29
  - @ydbjs/api@6.0.0-alpha.29
  - @ydbjs/debug@6.0.0-alpha.29
  - @ydbjs/error@6.0.0-alpha.29

## 6.0.0-alpha.28

### Patch Changes

- Define engines for packages
- Updated dependencies
  - @ydbjs/api@6.0.0-alpha.28
  - @ydbjs/error@6.0.0-alpha.28

## 6.0.0-alpha.27

### Major Changes

- Migrate to ESM-only package

### Patch Changes

- Updated dependencies
  - @ydbjs/error@6.0.0-alpha.27
  - @ydbjs/api@6.0.0-alpha.27

## 6.0.0-alpha.13

### Patch Changes

- Updated dependencies
  - @ydbjs/error@6.0.0-alpha.9

## 6.0.0-alpha.12

### Patch Changes

- Fix build cjs issues
- Updated dependencies
  - @ydbjs/error@6.0.0-alpha.8
  - @ydbjs/api@6.0.0-alpha.8

## 6.0.0-alpha.10

### Patch Changes

- Return original error when budget exceeded

## 6.0.0-alpha.9

### Patch Changes

- Update packages description
- Updated dependencies
  - @ydbjs/error@6.0.0-alpha.7
  - @ydbjs/api@6.0.0-alpha.7

## 6.0.0-alpha.8

### Patch Changes

- Consolidated and clarified README files across all packages.
- Updated dependencies
  - @ydbjs/api@6.0.0-alpha.6
  - @ydbjs/error@6.0.0-alpha.6

## 6.0.0-alpha.7

### Patch Changes

- Refined retry logic: now throws the original AbortError, supports AbortSignal, and adds onRetry hook.
- Expanded configuration options and documentation.
- Improved test coverage for retry scenarios.

## 6.0.0-alpha.6

### Patch Changes

- Add transaction support
- Updated dependencies
  - @ydbjs/api@6.0.0-alpha.5
  - @ydbjs/error@6.0.0-alpha.5

## 6.0.0-alpha.5

### Patch Changes

- Ensure function execution in retry is awaited for proper error handling

## 6.0.0-alpha.4

### Patch Changes

- Added support to ignore the `.turbo` folder for better compatibility and cleaner workflows.
- Updated dependencies
  - @ydbjs/api@6.0.0-alpha.4
  - @ydbjs/error@6.0.0-alpha.4

## 6.0.0-alpha.3

### Patch Changes

- Update usage examples
- Updated dependencies
  - @ydbjs/api@6.0.0-alpha.3
  - @ydbjs/error@6.0.0-alpha.3
