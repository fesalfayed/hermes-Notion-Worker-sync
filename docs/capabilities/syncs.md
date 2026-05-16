# Syncs

Three syncs ship with the worker. All three target managed databases (`projects`, `tasks`) declared in [`src/databases.ts`](../../src/databases.ts).

| Sync | Mode | Schedule | Source | Target | File |
|---|---|---|---|---|---|
| `projectsFromDiscord` | replace | 5m | Discord guild channels | `projects` DB | [`src/syncs/projectsFromDiscord.ts`](../../src/syncs/projectsFromDiscord.ts) |
| `tasksBackfill` | replace | manual | Private gist snapshot | `tasks` DB | [`src/syncs/tasksBackfill.ts`](../../src/syncs/tasksBackfill.ts) |
| `tasksDelta` | incremental | 1m | Private gist snapshot | `tasks` DB | [`src/syncs/tasksDelta.ts`](../../src/syncs/tasksDelta.ts) |

---

## projectsFromDiscord

**Trigger:** automatic, every 5 minutes.
**Mode:** `replace` — emits the full set of channels each cycle; missing rows are deleted via the platform's mark-and-sweep.
**Source:** `GET https://discord.com/api/v10/guilds/${GUILD_ID}/channels`, filtered to those whose `parent_id` is `PROJECTS_CATEGORY_ID` or `ARCHIVE_CATEGORY_ID` (see [`src/constants.ts`](../../src/constants.ts)).
**Pacer:** `discord` (50 req/s).
**Env:** `DISCORD_BOT_TOKEN` (required).

**Per-channel output** (`projects` DB, keyed by `discord_channel_id`):

| Property | Source |
|---|---|
| `Name` | `channel.name` |
| `discord_channel_id` | `channel.id` (primary key) |
| `discord_topic` | `channel.topic` or `""` |
| `discord_category_id` | `channel.parent_id` |
| `discord_archived` | `parent_id === ARCHIVE_CATEGORY_ID` |
| `kanban_board_slug` | from `CHANNEL_TO_BOARD` lookup (only set when a binding exists) |
| `status` | `"Cancelled"` if archived · `"In progress"` if a board binding exists · `"Backlog"` otherwise |

Notion-owned fields (`notes`, `kanban_task_ids`) are deliberately omitted from the upsert so user edits survive.

**Idempotency:** the upstream channel id is the primary key, so re-running is safe.
**Safety guard:** if Discord returns fewer than 1 matching channel, the sync **throws** rather than returning an empty change set, preventing a mark-and-sweep wipe of the projects DB on transient Discord outages.

---

## tasksBackfill

**Trigger:** manual — `ntn workers exec tasksBackfill`. Run on schema migrations, to recover from drift, or to sweep tombstones the delta path might have missed.
**Mode:** `replace`. Emits the full gist snapshot; orphans are deleted.
**Source:** `fetchGistSnapshot()` in [`src/lib/notionHelpers.ts`](../../src/lib/notionHelpers.ts) — pulls `KANBAN_GIST_URL` with a `GITHUB_TOKEN` bearer.
**Pacer:** `github` (30 req/min).
**Env:** `KANBAN_GIST_URL`, `GITHUB_TOKEN` (required).

**Per-task output** (`tasks` DB, keyed by `task_id`): see `taskToChange` for the full field map. Includes `Name`, `task_id`, `board_slug`, `status` (forced to `"archived"` when `gc'd === true`), `assignee`, `body` (truncated to 2000), `parents`, `children`, `created_at`, `updated_at`, `latest_summary`, and the `parent_project` relation (populated from `BOARD_TO_CHANNEL` when a binding exists).

**Idempotency:** `task_id` is the primary key.
**Safety guard:** if the gist returns 0 tasks the sync logs a warning and returns `{ changes: [], hasMore: false }` — it does **not** mass-delete.

---

## tasksDelta

**Trigger:** automatic, every 1 minute.
**Mode:** `incremental`. Persists `{ last_generated_at }` between runs and filters the snapshot to tasks with `updated_at > last_generated_at`.
**Source:** same gist as `tasksBackfill`.
**Pacer:** `github` (30 req/min, shared with `tasksBackfill`).
**Env:** `KANBAN_GIST_URL`, `GITHUB_TOKEN`, plus optionally `NOTION_API_TOKEN` + `TASKS_DATA_SOURCE_ID` (for the tombstone pass).

**Two-pass cycle:**

1. **Upsert pass** — applies `taskToChange` to every task whose `updated_at` is newer than `state.last_generated_at`.
2. **Tombstone pass** (`buildTombstoneChanges`) — queries the Notion tasks data source for all non-archived rows whose `board_slug` matches the snapshot's `board`, diffs against the snapshot's task ids, and emits `status: archived` writes for rows present in Notion but absent from the snapshot.

After each run `nextState = { last_generated_at: snapshot.generated_at }`.

**Idempotency:**
- Upserts are keyed by `task_id`.
- The tombstone pass queries `status != "archived"`, so re-running after a tombstone is a no-op (no status flap, no write churn).

**Error handling:**
- Empty / missing gist snapshot → returns `{ changes: [], hasMore: false }`. Crucially, no tombstones are emitted in this branch.
- Notion query failure in the tombstone pass → logs a warning and returns `[]` (upserts still proceed). Tombstones are deferred to the next cycle.
- Missing `NOTION_API_TOKEN` / `TASKS_DATA_SOURCE_ID` → tombstone pass is skipped silently with a single warning log.

**Multi-board safety:** the tombstone query is scoped to `snapshot.board`, so a snapshot for board A never tombstones board B's rows.
