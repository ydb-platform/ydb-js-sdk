# Versioning

We use Semantic Versioning for all `@ydbjs/*` packages.

- MAJOR: breaking API changes
- MINOR: backwards-compatible features
- PATCH: bug fixes and docs/typings improvements

## Coordinated Releases

Where possible, packages share the same major/minor to reduce friction:

- @ydbjs/core, @ydbjs/query, @ydbjs/value, @ydbjs/api, @ydbjs/error, @ydbjs/retry, @ydbjs/auth

Internal APIs may evolve without public guarantees. Public APIs are documented in each package README and types.

## Pre-releases

- Pre-releases use the `alpha` tag and semver pre-release identifiers (e.g., 7.0.0-alpha.33)
- Stable releases use the `latest` tag

