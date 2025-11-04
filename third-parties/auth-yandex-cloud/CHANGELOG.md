# @ydbjs/auth-yandex-cloud

## 0.1.0

### Minor Changes

- 701816e: Add Yandex Cloud Service Account authentication provider
  - New package `@ydbjs/auth-yandex-cloud` for authenticating with Yandex Cloud Service Account authorized keys
  - Supports JWT creation with PS256 algorithm
  - Automatic IAM token management with caching and background refresh
  - Built-in retry logic with exponential backoff for IAM API calls
  - Multiple initialization methods: from file, environment variable, or JSON object
