# hermes-projects-sync

> Bidirectional Discord ↔ Notion sync for **projects** and **tasks**, built on the
> [`@notionhq/workers`](https://developers.notion.com) SDK and operated by the
> Hermes multi-agent council.

A Notion Worker that mirrors the AGENTIC-OS Discord guild into two managed Notion
databases (`Hermes Projects`, `Hermes Tasks`), plus a local cron pipeline that
publishes the kanban board as a private GitHub Gist for the tasks syncs to consume.

**Status:** Phase 1 ✅ closed · Phase 2 ✅ closed · Phase 3 🔵 scoped
**Worker ID:** `019e2a23-71c0-70e4-b04e-0e15659ba93a` (workspace `e013cb0d-…`)

---

## Table of contents

- [Architecture](#architecture)
- [Capabilities](#capabilities)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Environment variables](#environment-variables)
- [Build & deploy](#build--deploy)
- [Local development loop](#local-development-loop)
- [Local cron infrastructure](#local-cron-infrastructure)
- [Operations](#operations)
- [Schema reference](#schema-reference)
- [Verification & testing](#verification--testing)
- [Troubleshooting](#troubleshooting)
- [Roadmap (Phase 3)](#roadmap-phase-3)
- [Project history](#project-history)
- [Documentation index](#documentation-index)

---

## Architecture

```
                   ┌─────────────────────────────┐
                   │   Discord (AGENTIC-OS)      │
                   │   PROJECTS / ARCHIVE cats   │
                   └──────────────┬──────────────┘
                                  │ poll 5m
                   ┌──────────────▼──────────────┐
                   │   projectsFromDiscord       │ ← replace sync, 5m
                   │   (Notion Worker)           │   writes: Name, topic,
                   └──────────────┬──────────────┘   category, archived,
                                  │                  status, last_edit
                   ┌──────────────▼──────────────┐
                   │  Notion: Hermes Projects DB │ DS 08a4c553…
                   │  (managed, 10 props)        │
                   └──────────────┬──────────────┘
                                  │ dual_property relation
                                  │   parent_project ↔ kanban_tasks
                   ┌──────────────▼──────────────┐
                   │  Notion: Hermes Tasks DB    │ DS c951d64c…
                   │  (managed, dual_property)   │
                   └──────────────▲──────────────┘
                                  │ tasksDelta (1m)  + tasksBackfill (manual)
                                  │
                   ┌──────────────┴──────────────┐
                   │  Private GitHub Gist        │ 9dd38de637358d11…
                   │  kanban_snapshot.json       │ (15-min refresh)
                   └──────────────▲──────────────┘
                                  │ publish
                   ┌──────────────┴──────────────┐
                   │  publish_kanban_gist.py     │ ← local cron
                   │  (no_agent, */15 * * * *)   │
                   └──────────────▲──────────────┘
                                  │ read
                   ┌──────────────┴──────────────┐
                   │  kanban.db                  │
                   │  (board: hermes-projects-   │
                   │  sync, owned by orchestrator│
                   └─────────────────────────────┘
```

**Why a gist hop?** The worker runs in Notion's cloud and cannot reach the
operator's local kanban SQLite directly. A small cron job snapshots the board to
a private gist; `tasksBackfill` / `tasksDelta` fetch from that gist URL with a
GitHub pacer. This keeps the worker stateless, makes the sync transparently
auditable (every state visible in gist history), and avoids exposing the local
machine.

---

## Capabilities

The worker (`src/index.ts`) declares the following capabilities via the
`@notionhq/workers` SDK:

### Syncs (3)

| Name | Mode | Schedule | Target DB | Upstream |
|---|---|---|---|---|
| `projectsFromDiscord` | replace | `5m` | `projects` | Discord REST API |
| `tasksBackfill`       | replace | `manual` | `tasks` | GitHub Gist |
| `tasksDelta`          | incremental | `1m` | `tasks` | GitHub Gist |

### Tools (5) — invokable via `ntn workers exec <name>` or Notion Custom Agents

| Name | Purpose |
|---|---|
| `renameProjectChannel` | Rename a Discord channel (e.g. project renames in Notion) |
| `archiveProject`       | Move channel from PROJECTS → ARCHIVE category |
| `unarchiveProject`     | Move channel from ARCHIVE → PROJECTS category |
| `rebindByChannelId`    | Re-pull a single channel's state Discord → Notion |
| `bindProjectToBoard`   | Populate `kanban_board_slug` + auto-relate that board's tasks |

### Managed databases (2)

| Handle | Data-source ID | Primary key |
|---|---|---|
| `projects` | `08a4c553-3df9-4b34-8943-97717ace176a` | `discord_channel_id` |
| `tasks`    | `c951d64c-43bd-4904-a593-21d8c59db225` | `task_id` |

### Pacers (2)

| Name | Budget | Used by |
|---|---|---|
| `discord` | 50 req/s | `projectsFromDiscord` + all 5 tools |
| `github`  | 30 req/min | `tasksBackfill`, `tasksDelta` |

---

## Repository layout

```
hermes-projects-sync/
├── src/
│   ├── index.ts                  # Worker entry — all syncs, tools, databases
│   └── boardChannelMap.ts        # YAML loader/validator for board↔channel binding
├── scripts/
│   └── seed-board-map.ts         # One-shot discovery → emits board_channel_map.yaml
├── local/
│   ├── scripts/
│   │   ├── publish_kanban_gist.py        # Cron: kanban.db → private gist (15m)
│   │   └── drift_watchdog.py             # Cron: alert on count drift (15m)
│   ├── hooks/
│   │   └── kanban_to_notion.py           # (deprecated — Tier-A cleanup)
│   └── state/                            # Cursor, retry queue, DLQ, debounce files
├── docs/
│   └── CHECKPOINT.md             # Phase-2 closeout snapshot — read first
├── verification/                 # Per-card evidence artifacts (Phase 1.0 → 2.8)
├── _archive/                     # Pre-gist DLQ/retry-queue snapshots (audit trail)
├── board_channel_map.yaml        # Kanban board ↔ Discord channel registry
├── workers.json                  # `ntn` CLI config (workspaceId, workerId) — committed
├── package.json
├── tsconfig.json
├── AGENTS.md / CLAUDE.md         # Agent contribution guide (Notion Workers SDK ref)
└── README.md                     # ← you are here
```

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 22.0.0 | enforced in `package.json` engines |
| npm     | ≥ 10.9.2 | enforced in `package.json` engines |
| `ntn`   | latest   | Notion Workers CLI — `npm i -g @notionhq/cli` |
| Python  | ≥ 3.11   | for `local/scripts/*` (no extra deps) |
| `gh` or `curl` | any | gist publishing uses raw GitHub REST |

A **Notion internal integration token** is required (https://www.notion.so/profile/integrations/internal),
shared with both managed DBs. A **Discord bot token** is required, scoped to the
AGENTIC-OS guild with channel-manage + read-history permissions.

---

## Quick start

```bash
git clone git@github.com:fesalfayed/hermes-projects-sync.git
cd hermes-projects-sync
npm install
cp .env.example .env          # fill in tokens — see "Environment variables"
npm run build                 # tsc → dist/
ntn workers exec sayHello -d '{"name":"world"}' --local   # smoke test
ntn workers deploy            # push to Notion cloud
```

---

## Configuration

### `board_channel_map.yaml`

Source of truth for kanban-board ↔ Discord-channel binding. Edit, rebuild,
deploy. To discover bindings programmatically:

```bash
npx tsx scripts/seed-board-map.ts > board_channel_map.yaml
```

### `workers.json`

Created on first `ntn workers deploy`. Pins the worker to a Notion workspace
and worker record. Committed to source — it has no secrets.

---

## Environment variables

| Variable | Required | Used by | Purpose |
|---|---|---|---|
| `NOTION_API_TOKEN` | ✅ | all syncs/tools that hit Notion | Internal integration token |
| `DISCORD_BOT_TOKEN` | ✅ | `projectsFromDiscord` + 4 tools | Discord REST auth |
| `NOTION_PROJECTS_DATABASE_ID` | ✅ | `rebindByChannelId`, `bindProjectToBoard` | Projects data-source ID |
| `NOTION_TASKS_DATABASE_ID` | ✅ | `bindProjectToBoard` | Tasks data-source ID |
| `KANBAN_GIST_URL` | ✅ | `tasksBackfill`, `tasksDelta` | Raw URL of kanban snapshot gist |
| `GITHUB_TOKEN` | ✅ | `tasksBackfill`, `tasksDelta`, gist publisher | Gist read/write |
| `NOTION_WORKSPACE_ID` | optional | CLI | Skips workspace selection prompt |
| `NOTION_KEYRING` | optional | CLI | Set to `0` for file-based auth (sandbox / Docker) |

**For local dev:** put values in `.env`.
**For deployed worker:** `ntn workers env set KEY=VALUE` then `ntn workers deploy`.
**Never commit `.env`** — it's gitignored.

---

## Build & deploy

```bash
npm run check        # tsc --noEmit (type-check only)
npm run build        # tsc → dist/
ntn workers deploy   # bundle + upload; updates existing worker on subsequent runs
```

First deploy creates the worker record and writes `workspaceId` + `workerId`
into `workers.json`. All subsequent deploys update in place.

**Sandbox pitfall:** `ntn workers deploy` triggers an OAuth dance that writes to
`~/.config/notion/auth.json`. If you're running under a sandboxed agent HOME
(`~/.hermes/profiles/*`), run the deploy from a normal shell, or override
`HOME=/Users/<you>` for that one command. See `notion-pmo` skill for details.

---

## Local development loop

```bash
# Run any capability locally via tsx — no deploy needed
ntn workers exec renameProjectChannel \
    -d '{"channel_id":"000000000000000014","new_name":"notion-infra"}' \
    --local

# Run against deployed worker (omit --local)
ntn workers exec renameProjectChannel \
    -d '{"channel_id":"000000000000000014","new_name":"notion-infra"}'

# Trigger a sync manually
ntn workers sync trigger tasksBackfill

# Tail run logs
ntn workers runs list --limit 10
ntn workers runs get <run-id>
```

---

## Local cron infrastructure

Operated under the **operator_dev** Hermes profile (separate from the worker
itself). Status check: `hermes cron list`.

| Cron name | Schedule | Script | What it does |
|---|---|---|---|
| `kanban-gist-publisher` | `*/15 * * * *` | `local/scripts/publish_kanban_gist.py` | Snapshots `kanban.db` (board=`hermes-projects-sync`) → private gist; debounced |
| `hermes-sync-drift-watchdog` | `*/15 * * * *` | `local/scripts/drift_watchdog.py` | Compares kanban row count vs Notion task count; alerts on drift |
| `hermes-projects-sync-watcher` | `*/5 * * * *` | (orchestrator profile) | Watches sync health, posts to infra-journal |

All three are `no_agent: true` — pure script execution, no LLM cost.

---

## Operations

### Triggering a full re-sync

```bash
ntn workers sync trigger projectsFromDiscord   # Discord → Notion projects
ntn workers sync trigger tasksBackfill         # Gist → Notion tasks (replace)
```

### Health check (one-liner)

```bash
ntn workers runs list --limit 5 \
  && wc -l local/state/kanban_to_notion_retry_queue.jsonl \
            local/state/kanban_to_notion_dlq.jsonl
```

### Manual gist refresh

```bash
python3 local/scripts/publish_kanban_gist.py
```

---

## Schema reference

### Projects DB — 10 properties

| Property | Type | Ownership |
|---|---|---|
| Name | title | Discord (sync writes) |
| discord_channel_id | rich_text | Discord (PK, immutable) |
| discord_topic | rich_text | Discord (sync writes) |
| discord_category_id | rich_text | Discord (sync writes) |
| discord_archived | checkbox | Discord (derived from category) |
| last_discord_edit | date | Discord (sync writes) |
| kanban_board_slug | rich_text | Kanban + orchestrator-verified |
| kanban_task_ids | rich_text | Kanban + orchestrator-verified |
| status | select | Kanban-derived (archived→Cancelled, has-board→In progress, else→Backlog) |
| notes | rich_text | Notion-owned (sync skips on upsert) |

Auto-created back-relation: `kanban_tasks` → tasks DS.

### Tasks DB

| Property | Type | Notes |
|---|---|---|
| (Title) | title | Task name |
| task_id | rich_text | Primary key (`t_…`) |
| board_slug | rich_text | Originating kanban board |
| status | select | `todo` · `running` · `blocked` · `done` · `cancelled` · `archived` |
| assignee | rich_text | Hermes profile name |
| body | rich_text | Task description |
| parents / children | rich_text | DAG references |
| created_at / updated_at | date | Kanban timestamps |
| latest_summary | rich_text | Most recent agent summary |
| parent_project | relation | dual_property → projects DS (canonical) |

> **Cosmetic debris:** A legacy `project` forward relation and `Tasks 1`
> back-relation linger from Phase-2 rename iterations. Functionally harmless;
> queued for Phase-3 Tier-A cleanup.

---

## Verification & testing

Every Phase-2 card shipped with verification artifacts under `verification/`:

```
verification/
├── 1.0_*           # Scaffold + sayHello
├── 1.1_*           # Projects DB deploy
├── 1.3_*           # projectsFromDiscord sync
├── 1.5_*           # rebindByChannelId tool
├── 2.0_*           # Tasks DB schema
├── 2.1_*           # upsertTask (now superseded by gist pipeline)
├── 2.5_*           # tasksReconciliation
└── 2.6_*           # Gist publisher
```

Re-run any phase's evidence with `bash verification/<card>/run.sh` where present.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ntn workers deploy` hangs on OAuth | Sandboxed HOME (Hermes worker profile) | Run from real shell or `HOME=/Users/<you> ntn workers deploy` |
| Tasks DB has 0 back-relations after sync | Notion server-side dual-relation lag | Wait one sync cycle; if persistent, trigger `tasksBackfill` |
| Drift watchdog alerts non-zero | Gist stale or delta cursor wedged | `python3 local/scripts/publish_kanban_gist.py`; inspect `local/state/kanban_to_notion_cursor.txt` |
| Discord 50007 / 50001 errors | Bot missing channel perms or removed from guild | Re-invite bot with `Manage Channels` + `Read Message History` |
| `tasksDelta` skips deletes | Known limitation — only backfill catches deletes | Run `tasksBackfill` manually; tombstone path is Phase-3 Tier-A item 3 |

---

## Roadmap (Phase 3)

### Tier A — Phase-2 debris cleanup
1. Drop legacy `project` + `Tasks 1` properties (cosmetic).
2. Remove deprecated `local/hooks/kanban_to_notion.py` + drain script, or repurpose as event-driven gist trigger (latency: 16 min → ~1 min).
3. Add tombstone emission to `tasksDelta` so kanban deletes propagate without a full backfill.

### Tier B — new capability
4. Generalize `BOARD_TO_CHANNEL` registry → multi-board mapping (unblocks `notion-pmo`, `imsg-triage`, future boards).
5. Wire remaining `notion-pmo` DBs: Areas (`20f2e89c-…`), Sprints (`f76ea8ab-…`).
6. Notion → kanban write-back via `sync_dirty` checkbox, with conflict arbitration (kanban wins on status, Notion on description/due).

### Tier C — architectural
7. Webhook-driven sync — replace 15-min gist + 1-min delta with event push. Latency → seconds.
8. Notion Custom Agent wiring for the 5 tools ("rename project X to Y" via Notion AI).
9. Drift watchdog → row-level diffs into a digest channel instead of count summaries.

**Recommended Phase 3.0:** Tier A (items 1+2+3) — clean exit from Phase-2 debris.
**Recommended Phase 3.1:** Tier B item 4 — biggest unlock.

---

## Project history

| Phase | Scope | Status | Journal thread |
|---|---|---|---|
| 1 | Projects sync (Discord ↔ Notion managed DB, 4 tools) | ✅ Closed (2026-05-15) | Discord `000000000000000018` |
| 2 | Tasks sync via gist pipeline (backfill + delta) + drift watchdog | ✅ Closed (2026-05-15) | Discord `000000000000000019` |
| 3 | Cleanup + multi-board generalization | 🔵 Scoped | — |

Full closeout snapshot: [`docs/CHECKPOINT.md`](docs/CHECKPOINT.md).

---

## Documentation index

### In-repo
- [`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md) — Notion Workers SDK reference + contribution guide for AI agents
- [`docs/CHECKPOINT.md`](docs/CHECKPOINT.md) — End-of-Phase-2 architectural snapshot
- [`board_channel_map.yaml`](board_channel_map.yaml) — Active kanban↔channel bindings
- `verification/` — Per-card test evidence

### Upstream specs (source of truth — 13 files)

```
/home/user/Desktop/Notion CLI Docs/
├── quickstart.md      ├── tools.md         ├── secrets.md
├── sdk.md             ├── webhooks.md      ├── file-uploads.md
├── commands.md        ├── api-client.md    └── data-sources.md
├── syncs.md           ├── api-requests.md
└── schema.md          └── oauth.md
```

Online index: https://developers.notion.com/llms.txt

### Related Hermes skills

- `notion-pmo` — canonical PMO IDs, schema, `ntn` recipes
- `notion-workers-deployment` — `@notionhq/workers` deploy recipes + pitfalls
- `kanban-orchestrator` — decomposition + routing playbook
- `infra-journal` — change-log discipline

---

## License

Unlicensed / private. Internal Hermes-agent infrastructure.

Maintained by the Hermes council (orchestrator + operator_dev) on behalf of `@fesalfayed`.
