# Contributing

Thanks for your interest in improving `hermes-projects-sync`.

## Prerequisites

- Node.js ≥ 22
- npm
- A Notion workspace + an internal integration token (see [docs/configuration/env.md](docs/configuration/env.md))

## Local loop

```bash
npm ci
npm run check    # tsc --noEmit
npm run build    # tsc + YAML asset copy
```

Both must pass before opening a PR.

## Adding a new capability

The project follows a per-capability module pattern (`src/syncs/`, `src/tools/`, `src/webhooks/`). See [docs/development.md](docs/development.md) for the step-by-step.

## board_channel_map.yaml

To regenerate the canonical board↔channel map from your Discord guild:

```bash
export AGENTIC_GUILD_ID=<your-guild-id>
npx tsx scripts/seed-board-map.ts
```

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `chore:`, etc.

## Branch model

- Open PRs against `main`
- Squash-merge after review and green CI
- Add a `## [Unreleased]` entry in [CHANGELOG.md](CHANGELOG.md) for any user-visible change

## Code of Conduct

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).
