[![CI](https://github.com/fesalfayed/hermes-projects-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/fesalfayed/hermes-projects-sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node ≥22](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](./package.json)
[![@notionhq/workers](https://img.shields.io/npm/v/%40notionhq%2Fworkers?label=%40notionhq%2Fworkers&color=000)](https://www.npmjs.com/package/@notionhq/workers)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

# hermes-projects-sync

> Bidirectional Discord ↔ Notion sync built on [@notionhq/workers](https://www.npmjs.com/package/@notionhq/workers).

A reference [@notionhq/workers](https://www.npmjs.com/package/@notionhq/workers) project that mirrors a Discord-channel-based kanban into Notion databases (`projects` + `kanban_tasks`). It ships **three syncs**, **seven tools**, and **one webhook** — all wired through a thin orchestrator — and is designed to be cloned and adapted to any Discord-driven workflow that needs a Notion source of truth.

## ⚡ Quickstart (≈ 3 minutes)

```bash
git clone https://github.com/fesalfayed/hermes-projects-sync.git
cd hermes-projects-sync
npm run onboard           # interactive: checks Node ≥22, installs deps,
                          # prompts for NOTION_API_TOKEN, writes .env, builds
ntn workers exec sayHello -d '{"name":"world"}' --local   # smoke test
ntn workers deploy                                        # ship it
```

No token yet? `npm run onboard` opens <https://www.notion.so/profile/integrations/internal> for you.

## What you get

**Syncs (3):**

- `projectsFromDiscord` — mirrors Discord channels under the `PROJECTS` / `ARCHIVE` categories into the `projects` Notion DB. Mark-and-sweep deletes channels that disappear from Discord. **Mode:** replace · **Schedule:** 5m.
- `tasksBackfill` — replace-mode drain of the full kanban gist snapshot into the `kanban_tasks` DB. **Mode:** replace · **Schedule:** manual. Run to recover from drift or backfill new properties.
- `tasksDelta` — incremental task sync from the kanban gist; tombstones rows absent from the latest snapshot (scoped by `board_slug` for multi-board safety). **Mode:** incremental · **Schedule:** 1m.

**Tools (7):**

- `renameProjectChannel` — rename a project's Discord channel to match a Notion rename.
- `archiveProject` — move a Discord channel from `PROJECTS` → `ARCHIVE`.
- `unarchiveProject` — move a Discord channel from `ARCHIVE` → `PROJECTS`.
- `rebindByChannelId` — re-sync a Notion project row with the current Discord channel name / topic / category.
- `bindProjectToBoard` — set `kanban_board_slug` on a project row and relink every task in that board via the `project` relation.
- `upsertTask` — manual override: create or update a row in `kanban_tasks` directly via `context.notion`, bypassing the gist pipeline.
- `tombstoneTask` — manual override: archive a task in `kanban_tasks` directly via `context.notion`.

**Webhook (1):**

- `kanbanEvent` — HMAC-signed real-time bridge from the local kanban hook into `kanban_tasks`. Signature header: `x-kanban-signature-256` (`sha256=<hex>` over the raw body, keyed by `KANBAN_WEBHOOK_SECRET`). Payload shapes: `upsert`, `tombstone`, `bulk_upsert`. The platform auto-disables the webhook after 5 consecutive failures. End-to-end latency target: **<10 s**.

## Architecture

Discord is the kanban UI (one channel per project). A local hook publishes the kanban state to a GitHub Gist and POSTs an HMAC-signed event to the worker's `kanbanEvent` webhook. The worker writes to two managed Notion databases — `projects` (from Discord channels) and `kanban_tasks` (from the gist + webhook). The gist acts as both a durable snapshot for backfill/delta syncs and a fallback for missed webhook events.

```
Discord channels ──► local hook ──► GitHub Gist ──► tasksBackfill / tasksDelta ──► Notion (kanban_tasks)
                            │
                            └─► HMAC POST ──► kanbanEvent webhook ──► Notion (kanban_tasks)

Discord channels ──► projectsFromDiscord (5m) ──► Notion (projects)
```

Full diagram and rationale (why the gist hop, why webhook + delta both, how tombstones are scoped): see [docs/architecture.md](docs/architecture.md).

## Configuration

**Minimum:**

- `NOTION_API_TOKEN` — required for all syncs and the webhook. Tools invoked from a Custom Agent receive a pre-authenticated `context.notion` automatically.

**Optional but recommended:**

- `DISCORD_BOT_TOKEN` — required for `projectsFromDiscord` and the channel-management tools (`renameProjectChannel`, `archiveProject`, `unarchiveProject`, `rebindByChannelId`).
- `GITHUB_TOKEN` (or `GIST_TOKEN`) + `KANBAN_TASKS_GIST_ID` — required for `tasksDelta` and `tasksBackfill`.
- `KANBAN_WEBHOOK_SECRET` — required for `kanbanEvent` HMAC verification.
- `AGENTIC_GUILD_ID` — your Discord guild ID (replaces the hardcoded default in `scripts/seed-board-map.ts`).

Full table with provenance and scope: [docs/configuration/env.md](docs/configuration/env.md).

## Project layout

```
hermes-projects-sync/
├── src/                     # @notionhq/workers source
│   ├── index.ts             # thin orchestrator (~67 LOC)
│   ├── databases.ts         # projects + kanban_tasks DB declarations
│   ├── pacers.ts            # discord + github rate limiters
│   ├── syncs/               # projectsFromDiscord, tasksBackfill, tasksDelta
│   ├── tools/               # 7 capability tools
│   ├── webhooks/            # kanbanEvent
│   ├── lib/                 # hmac, notionHelpers
│   └── boardChannelMap.ts   # YAML config loader
├── scripts/                 # onboard.sh, seed-board-map.ts
├── docs/                    # architecture, capabilities, configuration, history
├── .github/                 # CI + issue/PR templates
├── board_channel_map.yaml   # kanban-board ↔ Discord-channel registry
├── package.json
└── tsconfig.json
```

## Documentation

- [Architecture](docs/architecture.md)
- Capabilities
  - [Syncs](docs/capabilities/syncs.md)
  - [Tools](docs/capabilities/tools.md)
  - [Webhooks](docs/capabilities/webhooks.md)
- Configuration
  - [Environment variables](docs/configuration/env.md)
  - [`board_channel_map.yaml` schema](docs/configuration/board-channel-map.md)
- [Development](docs/development.md)
- [Deployment](docs/deployment.md)
- [Changelog](CHANGELOG.md)
- [Internal phase retrospectives](docs/history/) — historical context

Upstream Notion docs: <https://developers.notion.com/>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All contributors agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md). For security issues (especially anything touching webhook HMAC handling or token storage), see [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
