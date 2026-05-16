# Architecture

This worker mirrors two domains into Notion:

1. **Discord channels** under the `PROJECTS` / `ARCHIVE` categories → the `projects` Notion database.
2. **Kanban tasks** owned by a local kanban CLI → the `tasks` Notion database.

Both databases are declared as `worker.database({ type: "managed" })` — they are written exclusively by syncs and the `kanbanEvent` webhook. See [`src/databases.ts`](../src/databases.ts).

## Data flow

```
┌───────────────┐   5m       ┌────────────────────────┐
│ Discord guild │ ─────────▶ │ projectsFromDiscord    │ ──▶ projects DB
│ (channels)    │  replace   │ (src/syncs/...)        │
└───────────────┘            └────────────────────────┘

┌───────────────┐ post-write  ┌────────────────┐  HTTPS  ┌────────────────────┐
│ Kanban CLI    │ ──────────▶ │ local hook     │ ──────▶ │ kanbanEvent        │
│ (host)        │             │ (signs + POSTs)│  HMAC   │ webhook (<5s)      │ ──▶ tasks DB
└───────┬───────┘             └────────┬───────┘         └────────────────────┘
        │ publish                       │
        │ snapshot                      │ also writes
        ▼                               ▼
┌───────────────┐  pull       ┌────────────────────────┐
│ private gist  │ ─────────▶  │ tasksDelta   (1m)      │ ──▶ tasks DB
│ (snapshot.json│  HTTPS      │ tasksBackfill (manual) │
└───────────────┘             └────────────────────────┘
```

## The gist hop

The kanban CLI runs on the operator's host; the worker runs in Notion's sandbox. Direct host-to-worker egress is blocked. The compromise:

- The local hook publishes a full snapshot to a **private GitHub gist** on every kanban write (`KANBAN_TASKS_GIST_ID`).
- The worker pulls that gist on a 1-minute `tasksDelta` schedule and on demand from `tasksBackfill`.
- The same hook also POSTs an HMAC-signed event to the `kanbanEvent` webhook for sub-5-second propagation. The gist exists as fallback / drift correction when the webhook misses (network blip, signature reject, worker restart).

Result: webhook gives latency; gist gives durability. Either path alone is insufficient.

## Mark-and-sweep

Replace-mode syncs (`projectsFromDiscord`, `tasksBackfill`) overwrite the database in full each cycle. Rows whose primary key is absent from the return set are deleted by the platform. Two safeguards:

- `projectsFromDiscord` aborts if Discord returns `<1` channels (avoids wiping the projects DB on a transient API outage).
- `tasksBackfill` aborts if the gist returns `0` tasks (avoids a mass delete when the publisher hasn't run yet).

`tasksDelta` runs in `incremental` mode and performs an **explicit tombstone pass** (`buildTombstoneChanges` in `src/lib/notionHelpers.ts`): it queries the Notion tasks DS for all non-archived rows on the snapshot's `board_slug`, diffs against the snapshot's task ids, and emits `status: archived` writes for orphans. Single-board scope keeps multi-board safety.

## HMAC webhook path

`kanbanEvent` accepts three event types: `upsert`, `tombstone`, `bulk_upsert`. Each event:

1. **Signature verify** — `x-kanban-signature-256: sha256=<hex>` where the hex is `HMAC-SHA256(KANBAN_WEBHOOK_SECRET, rawBody)`. Compared with `crypto.timingSafeEqual` against the rendered expected value. Bad / missing signatures throw `WebhookVerificationError`, which the platform translates to a 401 and counts toward the auto-disable budget.
2. **Direct Notion write** — uses `context.notion` (a `@notionhq/client` instance). Resolves the parent project page via `PROJECTS_DATA_SOURCE_ID`, then either `pages.update` (existing row) or `pages.create` (new row). Tombstone uses `pages.update({ archived: true })` because the managed-DB schema rejects direct property writes from non-sync writers.
3. **Auto-disable** — the Workers platform disables a webhook after 5 consecutive failures. Re-enable from the Notion worker UI after fixing the root cause.

## Boot-time validation

`src/index.ts` loads `board_channel_map.yaml` and, if `DISCORD_BOT_TOKEN` is present, calls `validateBoardChannelMap` to GET every `channel_id` against the Discord API. Entries with `required: true` cause boot to throw on failure. Other entries warn. Skipped entirely when `DISCORD_BOT_TOKEN` is unset (CI / build-only contexts).

See [`docs/capabilities/`](./capabilities/) for per-capability detail and [`docs/configuration/`](./configuration/) for env / YAML schemas.
