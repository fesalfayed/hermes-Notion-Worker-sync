# Host-side automation

The Notion worker runs in Notion's cloud and is the source of truth for the Discord ↔ Notion sync. These two scripts run on **your own host** (a server, your laptop, a tiny VPS — anywhere with cron) and emit the `kanbanEvent` webhooks the worker subscribes to.

You don't *have* to use them — any process that POSTs a correctly-HMAC'd payload to the worker's webhook URL (see [`../../docs/capabilities/webhooks.md`](../../docs/capabilities/webhooks.md)) is fine. These are the reference implementations.

---

## What's in here

| Script | Cron | What it does |
|---|---|---|
| [`scripts/publish_kanban_gist.py`](scripts/publish_kanban_gist.py) | `*/5 * * * *` | Reads every local kanban SQLite DB, publishes a unified snapshot to a private GitHub gist (legacy fallback for `tasksDelta`), and POSTs `bulk_upsert` + `tombstone` events to the worker webhook for any deltas. Closes the loop for tasks created outside the in-agent tool hook (terminal, scripts, cron-spawned jobs). |
| [`scripts/auto_create_kanban_boards.py`](scripts/auto_create_kanban_boards.py) | `*/5 * * * *` | For every Discord channel under the PROJECTS category: creates the matching kanban board if missing, appends an entry to `board_channel_map.yaml` if missing, and runs `npm run build && ntn workers deploy && ntn workers sync trigger projectsFromDiscord` if the YAML changed. End-to-end: new Discord channel → ≤5 min → Notion project row `In progress`. |

The repo's worker code (`src/syncs/projectsFromDiscord.ts`) **also** auto-discovers boards at runtime from the gist snapshot — so even without `auto_create_kanban_boards.py`, new channels whose name matches an active kanban board slug get promoted to `In progress`. The host script is needed when you also want the YAML in source control to reflect reality.

---

## Setup

### 1. Required environment

Both scripts read config from environment variables. Put these in your shell's rc file, your cron job's environment, or a `.env` you source before invoking them:

```bash
# REQUIRED
export DISCORD_GUILD_ID="<your-guild-snowflake>"
export DISCORD_PROJECTS_CATEGORY_ID="<projects-category-snowflake>"
export DISCORD_ARCHIVE_CATEGORY_ID="<archive-category-snowflake>"
export NOTION_WORKSPACE_ID="<your-notion-workspace-uuid>"

# OPTIONAL (defaults shown; override if your layout differs)
export KANBAN_HOME="$HOME/.hermes"                          # where kanban/boards/* lives
export HERMES_PROJECTS_SYNC_REPO="$HOME/hermes-projects-sync"
export CRON_STATE_DIR="$HOME/.hermes/profiles/orchestrator/cron/state"
export NOTION_AUTH_FILE="$HOME/.config/notion/auth.json"    # written by `ntn login`
export HERMES_ENV_FILE="$HOME/.hermes/.env"
```

`auto_create_kanban_boards.py` also expects one of these tokens in its `.env`:

```
DISCORD_BOT_TOKEN=<bot-token-with-MANAGE_CHANNELS-on-the-guild>
# OR
AGENTIC_OS_DISCORD_BOT_TOKEN=<...>
```

And `publish_kanban_gist.py` expects:

```
KANBAN_WEBHOOK_SECRET=<same-value-as-in-the-worker-.env>
```

The webhook URL is read from `$HERMES_PROJECTS_SYNC_REPO/local/state/kanban_webhook_url.txt` — write the URL there after your first deploy.

### 2. One-time `ntn login` (needed only for auto-deploy)

`auto_create_kanban_boards.py` runs `ntn workers deploy` non-interactively using the OAuth token written by `ntn login`:

```bash
NOTION_KEYRING=0 ntn login          # opens browser, prints poll URL
NOTION_KEYRING=0 ntn login poll     # blocks until you click confirm
```

This writes `~/.config/notion/auth.json`. The token persists indefinitely — auto-deploy reads it on every cron tick. If you skip this step, the script still appends to `board_channel_map.yaml` but logs a warning and you need to deploy manually.

### 3. Wire up cron

Copy or symlink the scripts somewhere on disk, then add to crontab:

```cron
*/5 * * * * /usr/bin/env python3 /path/to/publish_kanban_gist.py
*/5 * * * * /usr/bin/env python3 /path/to/auto_create_kanban_boards.py
```

Both are silent on no-op — they only emit stdout when something changed.

---

## What success looks like

After both crons have run once on a freshly-onboarded board:

- `publish_kanban_gist.py` → `webhook: pushed N upsert(s) [, M tombstone(s)] to Notion worker`
- `auto_create_kanban_boards.py` → `Created N kanban board(s) for new Discord projects: ... ; Auto-bound N channel(s) in board_channel_map.yaml ; Worker auto-deploy: deployed and triggered projectsFromDiscord`

Verify in Notion:
- New channel's row in the projects DB has `kanban_board_slug` populated and `status = In progress`
- Tasks from the matching kanban board appear in the tasks DB with `parent_project` linked to the project row

---

## Failure modes & how to debug

| Symptom | Likely cause | Fix |
|---|---|---|
| `webhook push HTTP 429` | Notion worker rate-limited (bursty tombstone backlog) | Already handled — script throttles at 200ms/req and caps 100/tick. Backlogs > 100 drain across cron ticks. |
| `webhook push HTTP 401` | `KANBAN_WEBHOOK_SECRET` mismatch between host `.env` and worker env | Re-set the secret in both, `ntn workers env push`, redeploy |
| `auto-deploy failed: no token for workspace ...` | `~/.config/notion/auth.json` missing or has a different workspace UUID | Re-run `NOTION_KEYRING=0 ntn login` then `... poll` |
| `Discord fetch failed: 403` | Bot token missing or lacks `View Channels` on the guild | Re-invite bot with `applications.commands bot` scope + `View Channels` permission |
| `FileNotFoundError: 'gh'` | Cron's stripped PATH doesn't have `/opt/homebrew/bin` on macOS | Already handled — scripts prepend Homebrew/system paths defensively |

The publisher is **always non-fatal** on webhook failure — the gist is still published, and `tasksDelta` sync (which reads the gist) acts as the catch-up path. So even if the webhook is completely broken, you lose latency but not data.
