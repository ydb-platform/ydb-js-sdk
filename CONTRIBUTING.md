# Contributing to YDB JavaScript SDK

Thanks for your interest in contributing! This monorepo contains multiple `@ydbjs/*` packages.

## Prerequisites

- Node >= 20.19, npm >= 10
- Docker (for integration/e2e tests using local YDB)

## Setup

```bash
git clone https://github.com/ydb-platform/ydb-js-sdk.git
cd ydb-js-sdk
npm ci
```

## Development

- Build all packages: `npm run build`
- Run unit tests: `npm run test:uni`
- Run integration tests (requires Docker): `npm run test:int`
- Run all tests: `npm run test:all`
- Lint: `npm run lint`

## Commit & PR Guidelines

- Keep changes scoped and minimal per PR
- Update relevant READMEs when changing public APIs
- Add/adjust tests alongside code changes
- For breaking changes, include migration notes in the PR description

## Release Process

We use Changesets to manage versions and changelogs.

- Add a changeset: `npx changeset`
- After merging to main, the Release workflow will create a release PR or publish (see .github/workflows/release.yml)

## Running Local YDB for Tests

Integration tests use a local YDB container. CI spins it automatically; locally you can set env vars to reuse your own instance, or rely on the test setup script.

Key envs:

- `YDB_CONNECTION_STRING`, `YDB_STATIC_CREDENTIALS_*`

See `vitest.setup.ydb.ts` for details.

## Code Style

- TypeScript strict mode
- Avoid one-letter variable names
- Prefer explicit types in public APIs

## Questions?

Open an issue or start a discussion in the repository.
