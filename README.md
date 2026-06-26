[![CI](https://github.com/fesalfayed/hermes-Notion-Worker-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/fesalfayed/hermes-Notion-Worker-sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node ≥22](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](./package.json)
[![@notionhq/workers](https://img.shields.io/npm/v/%40notionhq%2Fworkers?label=%40notionhq%2Fworkers&color=000)](https://www.npmjs.com/package/@notionhq/workers)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

# hermes-notion-worker-sync

Discord ↔ Notion sync on [@notionhq/workers](https://www.npmjs.com/package/@notionhq/workers).

One channel per project. Worker mirrors it into two managed Notion DBs — `projects` and `kanban_tasks` — via 3 syncs, 7 tools, 1 webhook. Thin orchestrator (~67 LOC). Clone it, point it at your guild, ship.

## Quickstart

```bash
git clone https://github.com/fesalfayed/hermes-Notion-Worker-sync.git
cd hermes-Notion-Worker-sync
npm run onboard          # checks Node ≥22, installs, prompts NOTION_API_TOKEN, writes .env, builds
ntn workers exec sayHello -d '{"name":"world"}' --local
ntn workers deploy
```

No token? `npm run onboard` opens <https://www.notion.so/profile/integrations/internal>.

## What this demonstrates

- Event-driven workflow sync across Discord and Notion.
- Managed database writes with `@notionhq/workers`.
- HMAC-verified webhook delivery plus durable gist replay.
- Thin orchestrator design: syncs and tools stay small, typed, and testable.

## Surface

**Syncs (3)** — `src/syncs/`

| Name | Mode | Cadence | Does |
|---|---|---|---|
| `projectsFromDiscord` | replace | 5m | Discord channels under `PROJECTS` / `ARCHIVE` → `projects` DB. Mark-and-sweep. Sets `status` per binding (bound → `In progress`, archive parent → `Cancelled`, else → `Backlog`). |
| `tasksDelta` | incremental | 1m | Reads kanban gist snapshot, upserts changed rows, tombstones rows missing from the latest snapshot (scoped by `board_slug` for multi-board safety). |
| `tasksBackfill` | replace | manual | Full drain of the gist into `kanban_tasks`. Use after schema changes or drift. |

**Tools (7)** — `src/tools/`

- `renameProjectChannel` — rename Discord channel to follow a Notion rename.
- `archiveProject` / `unarchiveProject` — move channel between `PROJECTS` ↔ `ARCHIVE`.
- `rebindByChannelId` — re-sync a project row against the live channel name/topic/category.
- `bindProjectToBoard` — set `kanban_board_slug` on a project row and relink every task in that board via the `project` relation.
- `upsertTask` / `tombstoneTask` — manual overrides on `kanban_tasks` via `context.notion`, bypass the gist.

Tools invoked from a Notion Custom Agent receive a pre-authenticated `context.notion`.

**Webhook (1)** — `src/webhooks/kanbanEvent.ts`

HMAC-signed real-time bridge from the local kanban hook into `kanban_tasks`.

- Header: `x-kanban-signature-256: sha256=<hex>`, keyed by `KANBAN_WEBHOOK_SECRET`, computed over the raw body.
- Payloads: `upsert`, `bulk_upsert`, `tombstone`.
- Latency target: <10s. Platform auto-disables after 5 consecutive failures.

## Architecture

Discord is the kanban UI. A local hook publishes board state to a GitHub gist and POSTs HMAC-signed events to `kanbanEvent`. The worker writes to two managed Notion DBs.

```
Discord channels ──► local hook ──► GitHub gist ──► tasksBackfill / tasksDelta ──► kanban_tasks
                            │
                            └─► HMAC POST ──► kanbanEvent ──► kanban_tasks

Discord channels ──► projectsFromDiscord (5m) ──► projects
```

Two ingestion paths on purpose:

- Webhook = fast path, <10s. First to land wins.
- Gist + delta = durable snapshot, replay, and fallback if a webhook is missed or the worker is mid-deploy.

Multi-board auto-discovery: at every `tasksDelta` / `tasksBackfill` run, `resolveBoardChannelMap()` starts with the bundled YAML, then queries the projects DS by `Name == board_slug` for any unknown slugs in the snapshot. Found IDs are cached for that run. Adding a board to YAML is optional — the runtime resolver picks it up. Log line: `board-resolver: auto-bound <slug> → <channel_id>`.

Full rationale (why the gist hop, why webhook + delta both, how tombstones are scoped per board_slug, the read-only-status wall on managed DBs): [docs/architecture.md](docs/architecture.md).

## Configuration

**Required**

- `NOTION_API_TOKEN` — every sync and the webhook. Tools called from a Custom Agent skip this.

**For full functionality**

- `DISCORD_BOT_TOKEN` — `projectsFromDiscord` + every channel-management tool.
- `DISCORD_GUILD_ID`, `DISCORD_PROJECTS_CATEGORY_ID`, `DISCORD_ARCHIVE_CATEGORY_ID` — guild + category scoping.
- `GITHUB_TOKEN` (or `GIST_TOKEN`) + `KANBAN_TASKS_GIST_ID` — `tasksDelta` + `tasksBackfill`.
- `KANBAN_WEBHOOK_SECRET` — `kanbanEvent` HMAC.

Full table with scope + provenance: [docs/configuration/env.md](docs/configuration/env.md). Never use the `NOTION_*` env prefix on the worker — reserved server-side, silently dropped at deploy.

## Project layout

```
hermes-notion-worker-sync/
├── src/
│   ├── index.ts             # orchestrator, registers all capabilities
│   ├── worker.ts            # worker singleton
│   ├── databases.ts         # projects + kanban_tasks declarations
│   ├── bindings.ts          # managed-DB bindings
│   ├── pacers.ts            # discord + github rate limiters
│   ├── constants.ts         # IDs, env-driven
│   ├── syncs/               # projectsFromDiscord, tasksBackfill, tasksDelta
│   ├── tools/               # 7 tools
│   ├── webhooks/            # kanbanEvent
│   ├── lib/                 # hmac, notionHelpers (incl. resolveBoardChannelMap)
│   └── boardChannelMap.ts   # YAML loader
├── scripts/                 # onboard.sh, seed-board-map.ts
├── examples/                # host-automation/ (optional companion cron)
├── docs/                    # architecture, capabilities, configuration, deployment
├── board_channel_map.yaml   # kanban-board ↔ Discord-channel registry (bundled into dist/)
├── package.json
└── tsconfig.json
```

## Build & deploy

- Node ≥22, npm ≥10.9.2.
- `npm run build` — `tsc` + copies `board_channel_map.yaml` into `dist/`.
- `npm run check` — type-check only.
- `ntn workers deploy` — ship. Needs a logged-in `ntn` session; on macOS pair with `HOME=/Users/<you>` and `NOTION_KEYRING=0` if keyring lookup misbehaves.
- `ntn workers exec <capability> --local` — run any sync, tool, or webhook locally against the deployed env.

## Docs

- [Architecture](docs/architecture.md)
- Capabilities — [syncs](docs/capabilities/syncs.md) · [tools](docs/capabilities/tools.md) · [webhooks](docs/capabilities/webhooks.md)
- Configuration — [env](docs/configuration/env.md) · [`board_channel_map.yaml`](docs/configuration/board-channel-map.md)
- [Development](docs/development.md) · [Deployment](docs/deployment.md)
- [Companion automation (host-side)](docs/companion-automation.md) — optional cron helpers in [`examples/host-automation/`](examples/host-automation/) that emit `tombstone` events for archived/cancelled tasks and auto-bind new Discord channels to `board_channel_map.yaml`. Out-of-the-box the worker auto-discovers new boards at runtime — these are for round-tripping back to git.
- [Changelog](CHANGELOG.md)

Upstream Notion docs: <https://developers.notion.com/>.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md). Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security (HMAC handling, token storage): [SECURITY.md](SECURITY.md).

## License

MIT — [LICENSE](LICENSE).
