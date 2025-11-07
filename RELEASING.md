# Releasing YDB JavaScript SDK

This document describes how we cut stable releases for all packages in this monorepo.

## Versioning Strategy

- Packages follow SemVer.
- Packages are versioned independently based on their own changesets.
- Pre-releases use the `alpha` tag; stable uses `latest`.

See VERSIONING.md for details.

## Preconditions

- Node >= 20.19, npm >= 10
- All tests green: `npm test:all`
- Lint clean: `npm run lint`
- Changelog entries prepared via Changesets in `.changeset/`
- No uncommitted files; CI green on main.

## Release Steps

1. Ensure workspace builds and tests pass

```bash
npm run build
npm test:all
```

2. Verify package entry points and exports with ATTW

```bash
npm run attw
```

3. Bump versions and generate changelogs (Changesets)

```bash
npx changeset version
```

4. Publish to npm (stable)

```bash
# Ensure you are authenticated: npm whoami
NPM_CONFIG_PROVENANCE=true npx changeset publish
```

5. Create GitHub Release

- Tag matches monorepo state (e.g., v7.0.0)
- Paste aggregated changelog highlights

6. Announce breaking changes and migration notes

- Link MIGRATION.md sections in release notes

## Alpha → Stable Transition

- Remove `publishConfig.tag: alpha` in packages slated for stable
- Verify dependencies across packages resolve to stable ranges
- Update documentation to remove “alpha” suffixes in install commands

## Smoke Verification

- Run example apps in `examples/`
- Install packages in a fresh project and run a simple query
