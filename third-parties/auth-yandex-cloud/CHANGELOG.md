# @ydbjs/auth-yandex-cloud

## 0.1.1

### Patch Changes

- a48d01c: Fix Service Account provider: clean private key in constructor
  - Move private key cleaning from JWT creation to constructor for better performance
  - Remove unnecessary log about warning line detection
  - Add key ID to debug logs for better traceability
  - Directly modify key.private_key instead of creating new object

## 0.1.0

### Minor Changes

- 701816e: Add Yandex Cloud Service Account authentication provider
  - New package `@ydbjs/auth-yandex-cloud` for authenticating with Yandex Cloud Service Account authorized keys
  - Supports JWT creation with PS256 algorithm
  - Automatic IAM token management with caching and background refresh
  - Built-in retry logic with exponential backoff for IAM API calls
  - Multiple initialization methods: from file, environment variable, or JSON object
