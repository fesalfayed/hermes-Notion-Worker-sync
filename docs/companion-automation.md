# Companion automation (host-side)

The Notion worker in this repo is the source of truth for the Discord ↔ Notion sync, but it relies on **two webhook event types** (`upsert` and `tombstone`) being emitted by *something* on the kanban side. This document describes the optional host-side cron scripts that emit those events reliably — they are **not** part of the worker bundle, they live in the host's Hermes profile (`~/.hermes/profiles/orchestrator/scripts/`) and run under a local cron scheduler.

If you're forking this repo and don't use Hermes Kanban, you can ignore this doc and emit `kanbanEvent` webhooks however you like — the wire format is documented in [docs/capabilities/webhooks.md](capabilities/webhooks.md).

---

## Why companion automation exists

The Phase 4 worker decommissioned the 1-minute `tasksDelta` poll loop and now only ingests via the `kanbanEvent` webhook. That webhook was originally fired by an in-agent `post_tool_call` hook scoped to a single board, which created three failure modes:

1. **Terminal-created tasks never sync.** `hermes kanban create` from a shell, a script, or a cron-spawned no-agent job writes to the local kanban DB but never invokes the in-agent tool hook → no webhook → silent miss.
2. **Archive/cancel transitions never propagate.** `hermes kanban archive <id>` doesn't bump `updated_at`, so even a working delta detector can't see archived tasks as deltas. Without explicit `tombstone` events, archived tasks stay forever in Notion.
3. **New project channels stay at `Backlog`.** `projectsFromDiscord` only promotes a project row to `In progress` when the channel has a binding in `board_channel_map.yaml`. New channels created in Discord just sit at `Backlog` until somebody manually edits the YAML and redeploys.

The two scripts below close these loops.

---

## 1. `publish_kanban_gist.py` — universal kanban→Notion publisher

**Location:** `~/.hermes/profiles/orchestrator/scripts/publish_kanban_gist.py`
**Schedule:** `*/5 * * * *` (no_agent cron)
**Skill:** `hermes-publish-kanban-gist-webhook-push-patch`

### What it does

1. Globs every `~/.hermes/kanban/boards/*/kanban.db` and builds a v2 snapshot.
2. Publishes the snapshot to a private GitHub gist (legacy fallback for `tasksDelta`).
3. **Tombstone pass** — for every task whose `status ∈ {archived, cancelled}` and not yet in `webhook_tombstone_cursor.json`, POST a `tombstone` event to the worker webhook. Throttled at 200 ms/req, capped at 100/tick.
4. **Upsert pass** — for every task whose `updated_at` advanced since the last successful push (per-task cursor in `webhook_push_cursor.json`), POST a `bulk_upsert` event. Chunked at 50 tasks/POST.

Both cursors only advance on HTTP 2xx — a 429 leaves the task in the queue for the next cron tick.

### Why this layout

Making the publisher the single source of truth eliminates dependence on the in-agent hook. Any task that lands in any kanban DB — terminal, script, agent tool call, cron-spawned job — flows to Notion within ≤5 min. The in-agent hook is now nice-to-have for sub-5 s latency, no longer load-bearing.

### State files

| File | Purpose |
|---|---|
| `~/.hermes/profiles/orchestrator/cron/state/kanban_gist_id.txt` | Gist ID for the legacy fallback path |
| `~/.hermes/profiles/orchestrator/cron/state/webhook_push_cursor.json` | `{task_id: updated_at_iso}` of last successful upsert per task |
| `~/.hermes/profiles/orchestrator/cron/state/webhook_tombstone_cursor.json` | Sorted list of `task_id`s that have been tombstoned |

### Pitfalls

- The script reads `KANBAN_WEBHOOK_SECRET` from `~/hermes-projects-sync/.env` and the webhook URL from `~/hermes-projects-sync/local/state/kanban_webhook_url.txt`. The first is committed to the worker's env; the second is written by the deploy script.
- HTTP 202 from the worker does **not** guarantee ingestion — see [notion-ingestion-cap-investigation](../docs/architecture.md) in the worker docs. The cursor advances on 2xx anyway; drift watchdog catches silent drops.
- Cron schedulers ship a stripped `PATH` that often omits `/opt/homebrew/bin`. The script prepends `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin` defensively so `gh` (used by the gist fallback) is always findable.

---

## 2. `auto_create_kanban_boards.py` — new-channel auto-binding

**Location:** `~/.hermes/profiles/orchestrator/scripts/auto_create_kanban_boards.py`
**Schedule:** `*/5 * * * *` (no_agent cron)
**Skill:** `hermes-publish-kanban-gist-webhook-push-patch` (same skill, second file)

### What it does

For every Discord channel under `DISCORD_PROJECTS_CATEGORY_ID`:

1. **Create kanban board** — if `~/.hermes/kanban/boards/<channel-name>/` doesn't exist, run `hermes kanban boards create <name>`.
2. **Append YAML binding** — if `board_channel_map.yaml` doesn't list the channel, append a new entry (`<slug>: { channel_id, required: false }`). Idempotent — skips entries already present by slug *or* channel_id, preserves comments and `required: true` flags.
3. **Auto-deploy worker** — if step 2 changed the file, run `npm run build && ntn workers deploy && ntn workers sync trigger projectsFromDiscord` non-interactively. Uses the OAuth token from `~/.config/notion/auth.json` (written once by `ntn login`, persists indefinitely).

### End-to-end guarantee

Creating a new project channel under the PROJECTS category triggers within ≤5 min:

1. Kanban board created at `~/.hermes/kanban/boards/<channel-name>/`
2. `board_channel_map.yaml` gets a new entry
3. Worker rebuilt + redeployed
4. `projectsFromDiscord` triggered → Notion project row flips from `Backlog` → `In progress` with `kanban_board_slug` populated.

Zero manual `ntn login` / `npm run build` / `ntn workers deploy` required per project.

### Pitfalls

- Reads `AGENTIC_OS_DISCORD_BOT_TOKEN` from `~/.hermes/.env` (falls back to `DISCORD_BOT_TOKEN`). The token must have **`MANAGE_CHANNELS`** on the guild — without it, the bot can read channels but not move them between categories.
- `~/.config/notion/auth.json` must contain the workspace token for `e013cb0d-6d7f-448f-bae1-cca862c5c35c`. If it's missing or stale, the deploy step returns `(False, "no token for workspace ...")` and skips silently — the YAML still gets appended; you'll just need to deploy once manually.
- The auto-deploy step does **not** commit `board_channel_map.yaml` to git. The YAML in the repo is the bootstrap state; runtime additions are local-only and rebuild on every cron tick. If you want the local state versioned, commit it manually.

---

## Operational notes

- Both scripts are **silent on no-op** (cron `no_agent` contract — empty stdout = no notification).
- Both prepend `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin` to `PATH` so subprocess calls to `gh`, `ntn`, `npm`, `node` work under cron's stripped environment.
- Both are non-fatal on webhook/deploy failure — the gist remains the authoritative fallback for the publisher, and YAML changes survive a failed deploy (next cron tick retries).

If you're running this stack and these scripts break, the worker still works — it'll just stop seeing new events. The drift watchdog (`0 9 * * *`) will surface the gap in `#daily-updates`.
