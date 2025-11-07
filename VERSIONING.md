# Versioning

We use Semantic Versioning for all `@ydbjs/*` packages.

- MAJOR: breaking API changes
- MINOR: backwards-compatible features
- PATCH: bug fixes and docs/typings improvements

## Independent Releases

Packages publish versions independently. Bump only the packages affected by a changeset and keep dependency ranges broad enough (typically `^major.minor.0`) for consumers to pick up compatible updates.

When a change requires updates in dependent packages, include changesets for each affected package so they release together, but do not force unrelated packages to bump.

## Pre-releases

- Pre-releases use the `alpha` tag and semver pre-release identifiers (e.g., 7.0.0-alpha.33)
- Stable releases use the `latest` tag
