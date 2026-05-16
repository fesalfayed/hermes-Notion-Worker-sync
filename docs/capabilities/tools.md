# Tools

Seven tools ship with the worker. All accept JSON inputs validated by `j` schemas (from `@notionhq/workers/schema-builder`) and return typed JSON outputs. Errors are returned as `{ ok: false, error: "<reason>" }` rather than thrown.

When invoked via a Notion Custom Agent, `context.notion` is pre-authenticated with the agent's identity. When invoked via `ntn workers exec`, `NOTION_API_TOKEN` from the environment is used.

Test any tool locally with:

```bash
ntn workers exec <name> --input '<json>'
```

| Tool | Side effect | File |
|---|---|---|
| `renameProjectChannel` | Renames a Discord channel | [`src/tools/renameProjectChannel.ts`](../../src/tools/renameProjectChannel.ts) |
| `archiveProject` | Moves Discord channel PROJECTS → ARCHIVE | [`src/tools/archiveProject.ts`](../../src/tools/archiveProject.ts) |
| `unarchiveProject` | Moves Discord channel ARCHIVE → PROJECTS | [`src/tools/unarchiveProject.ts`](../../src/tools/unarchiveProject.ts) |
| `rebindByChannelId` | Re-syncs a Notion project row from current Discord state | [`src/tools/rebindByChannelId.ts`](../../src/tools/rebindByChannelId.ts) |
| `bindProjectToBoard` | Sets `kanban_board_slug` and back-links every task in that board | [`src/tools/bindProjectToBoard.ts`](../../src/tools/bindProjectToBoard.ts) |
| `upsertTask` | Creates / updates a row in the `tasks` DB via direct Notion API | [`src/tools/upsertTask.ts`](../../src/tools/upsertTask.ts) |
| `tombstoneTask` | Archives a row in the `tasks` DB via direct Notion API | [`src/tools/tombstoneTask.ts`](../../src/tools/tombstoneTask.ts) |

---

## renameProjectChannel

Rename a Discord channel. Propagates a name change from Notion → Discord.

**Input:** `{ discord_channel_id: string, new_name: string }` — `new_name` must be 1–100 chars, lowercase + hyphens.
**Output:** `{ ok, old_name, new_name, channel_id, error }`.
**Env:** `DISCORD_BOT_TOKEN`.
**Side effect:** `PATCH /channels/{id}` on Discord.

```bash
ntn workers exec renameProjectChannel --input '{"discord_channel_id":"1504266202506199272","new_name":"hermes-projects-sync"}'
```

---

## archiveProject

Move a Discord channel from `PROJECTS_CATEGORY_ID` to `ARCHIVE_CATEGORY_ID`. The next `projectsFromDiscord` cycle will flip `discord_archived = true` and `status = Cancelled` for the row.

**Input:** `{ discord_channel_id: string }`.
**Output:** `{ ok, error, from_category, to_category }`.
**Env:** `DISCORD_BOT_TOKEN`.
**Pre-check:** refuses to move if the channel is not already in `PROJECTS_CATEGORY_ID` — returns `error: "channel_not_in_expected_category"`.

```bash
ntn workers exec archiveProject --input '{"discord_channel_id":"1504266202506199272"}'
```

---

## unarchiveProject

Inverse of `archiveProject`. Refuses to move if the channel is not in `ARCHIVE_CATEGORY_ID`.

**Input:** `{ discord_channel_id: string }`.
**Output:** `{ ok, error, from_category, to_category }`.
**Env:** `DISCORD_BOT_TOKEN`.

```bash
ntn workers exec unarchiveProject --input '{"discord_channel_id":"1504266202506199272"}'
```

---

## rebindByChannelId

Re-fetches the live Discord channel state and writes the latest `Name`, `discord_topic`, `discord_category_id`, and `discord_archived` to the matching Notion `projects` row. Use when a row drifted (manual Notion edit, missed sync, channel renamed mid-cycle).

**Input:** `{ discord_channel_id: string }`.
**Output:** `{ ok, action, error, before: { Name, discord_topic, discord_category_id, discord_archived }, after: { ... } }`.
**Env:** `DISCORD_BOT_TOKEN`, `NOTION_API_TOKEN`, `PROJECTS_DATABASE_ID`, `PROJECTS_DATA_SOURCE_ID`.

```bash
ntn workers exec rebindByChannelId --input '{"discord_channel_id":"1504266202506199272"}'
```

---

## bindProjectToBoard

Two operations in one call:

1. Sets `kanban_board_slug` on the `projects` row whose `discord_channel_id` matches.
2. Queries the `tasks` DS for every row with that `board_slug` and writes the `parent_project` relation pointing back at the project row.

**Input:** `{ discord_channel_id: string, board_slug: string }`.
**Output:** `{ ok, project_page_id, tasks_relinked, error }`.
**Env:** `NOTION_API_TOKEN`, `PROJECTS_DATABASE_ID`, `PROJECTS_DATA_SOURCE_ID`, `TASKS_DATABASE_ID`, `TASKS_DATA_SOURCE_ID`.

```bash
ntn workers exec bindProjectToBoard --input '{"discord_channel_id":"1504266202506199272","board_slug":"hermes-projects-sync"}'
```

---

## upsertTask

Manual override for the `tasks` DB. Creates or updates a single row via `context.notion`, bypassing the gist → sync pipeline. The next `tasksBackfill` will eventually reconcile against the upstream gist.

**Input:**

```ts
{
  task_id: string;          // primary key, e.g. "t_abcd1234"
  name: string;
  board_slug: string;
  status: "todo" | "running" | "blocked" | "done" | "cancelled" | "archived";
  assignee: string | null;
  body: string | null;       // truncated to 2000 chars
  parents: string | null;    // comma-separated task ids
  children: string | null;
  latest_summary: string | null;
}
```

**Output:** `{ ok, action: "created" | "updated", task_id, error }`.
**Env:** `TASKS_DATABASE_ID`, `TASKS_DATA_SOURCE_ID`, plus a Notion-authenticated `context.notion`.
**Side effect:** resolves `parent_project` via `BOARD_TO_CHANNEL[board_slug]` → `PROJECTS_DATA_SOURCE_ID` lookup → page id.

```bash
ntn workers exec upsertTask --input '{"task_id":"t_abcd1234","name":"refactor sync","board_slug":"hermes-projects-sync","status":"running","assignee":"operator_dev","body":null,"parents":null,"children":null,"latest_summary":null}'
```

---

## tombstoneTask

Marks a task row as archived. Because the `tasks` DB is `type: "managed"`, the platform rejects direct property writes from tools — so this uses `pages.update({ archived: true })` (the page-level archive flag, which IS mutable). The mark-and-sweep tombstone pass in `tasksDelta` performs the same effect via a different mechanism.

**Input:** `{ task_id: string }`.
**Output:** `{ ok, action: "tombstoned" | "not_found", task_id, error }`.
**Env:** `TASKS_DATABASE_ID`, `TASKS_DATA_SOURCE_ID`, plus a Notion-authenticated `context.notion`.

```bash
ntn workers exec tombstoneTask --input '{"task_id":"t_abcd1234"}'
```
