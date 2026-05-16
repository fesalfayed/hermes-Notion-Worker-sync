# Environment variables

Populate `.env` locally; push to the deployed worker with `ntn workers env push`. See [`.env.example`](../../.env.example) for the canonical template.

| Variable | Required by | Required? | Where to obtain | Notes |
|---|---|---|---|---|
| `NOTION_API_TOKEN` | `tasksDelta` (tombstone pass), `bindProjectToBoard`, `rebindByChannelId`, `kanbanEvent`, all tools when invoked outside a Custom Agent | yes (for those code paths) | Create an internal integration at <https://www.notion.so/profile/integrations/internal>; grant it access to both managed databases | When a tool is invoked by a Custom Agent, the platform sets this automatically with the agent's identity; manual `ntn workers exec` uses your local value. |
| `DISCORD_BOT_TOKEN` | `projectsFromDiscord`, `archiveProject`, `unarchiveProject`, `renameProjectChannel`, `rebindByChannelId`, boot-time validator | yes for any Discord-touching path | Discord Developer Portal → Application → Bot tab | Bot must be a member of the guild and have channel-read + channel-manage permissions on the relevant categories. Unset = boot-time YAML validator is skipped (warns). |
| `DISCORD_GUILD_ID` | `projectsFromDiscord`, `scripts/seed-board-map.ts`, all channel-management tools | yes | Discord guild ID (right-click server in Discord with Developer Mode on) | Used at runtime by the worker to scope Discord API calls. |
| `DISCORD_PROJECTS_CATEGORY_ID` | `projectsFromDiscord`, `archiveProject`, `unarchiveProject` | yes | Discord channel category ID for active projects | Right-click the category in Discord with Developer Mode on. |
| `DISCORD_ARCHIVE_CATEGORY_ID` | `projectsFromDiscord`, `archiveProject`, `unarchiveProject`, `rebindByChannelId` | yes | Discord channel category ID for archived projects | Same as above, for the ARCHIVE category. |
| `GITHUB_TOKEN` | `tasksBackfill`, `tasksDelta` (via `fetchGistSnapshot`) | yes for the task syncs | <https://github.com/settings/tokens> with `gist` scope | Only `gist` scope is needed — read-only access to the snapshot gist. |
| `KANBAN_GIST_URL` | `tasksBackfill`, `tasksDelta` | yes for the task syncs | The raw gist URL of `kanban_snapshot.json` published by the local hook | Form: `https://gist.githubusercontent.com/<user>/<gist_id>/raw/kanban_snapshot.json`. The audit notes `KANBAN_TASKS_GIST_ID` in `.env.example` as a *fragment* convention; the live code reads the full URL from `KANBAN_GIST_URL`. |
| `KANBAN_WEBHOOK_SECRET` | `kanbanEvent` | yes if the webhook is enabled | Generate with `openssl rand -hex 32` and share with the local hook | Used to verify the `x-kanban-signature-256` HMAC. Missing → `WebhookVerificationError` on every delivery. |
| `PROJECTS_DATABASE_ID` | `bindProjectToBoard`, `rebindByChannelId` | yes for those tools | `ntn workers database show projects` after first deploy | Stable across deploys. |
| `PROJECTS_DATA_SOURCE_ID` | `bindProjectToBoard`, `rebindByChannelId`, `kanbanEvent` (for `parent_project` resolution) | yes for those code paths | Same as above; data source id is shown alongside the database id | When unset, the webhook still upserts tasks but skips `parent_project` linking. |
| `TASKS_DATABASE_ID` | `upsertTask`, `tombstoneTask`, `bindProjectToBoard`, `kanbanEvent` | yes for those code paths | `ntn workers database show tasks` after first deploy | |
| `TASKS_DATA_SOURCE_ID` | `upsertTask`, `tombstoneTask`, `bindProjectToBoard`, `tasksDelta` (tombstone pass), `kanbanEvent` | yes for those code paths | Same as above | |

## Scope reference

- **Boot-time validator** (`src/index.ts`) — needs only `DISCORD_BOT_TOKEN`. Without it, the validator emits a warning and skips channel-ID verification but boot still proceeds.
- **Custom Agent invocations** — `NOTION_API_TOKEN` is auto-injected by the platform; you do not need to set it for tools-only deployments.
- **`scripts/seed-board-map.ts`** — only reads `DISCORD_GUILD_ID` and `DISCORD_BOT_TOKEN`; it's a local helper that emits YAML to stdout and never touches Notion.

## Pushing env to the deployed worker

```bash
cp .env.example .env
# fill in values
ntn workers env push        # uploads every key from .env
ntn workers env list
```

`.env` is **not** checked in. Rotate secrets by editing `.env` and re-running `env push`.
