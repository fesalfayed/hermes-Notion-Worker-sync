# Webhooks

One webhook ships with the worker.

| Webhook | Source | File |
|---|---|---|
| `kanbanEvent` | Local kanban CLI post-write hook | [`src/webhooks/kanbanEvent.ts`](../../src/webhooks/kanbanEvent.ts) |

## kanbanEvent

Receives real-time kanban task events from the operator's local shell hook and applies them directly to the Notion `tasks` database via `context.notion`. Provides <5 s kanban → Notion latency, complementing the 1 m `tasksDelta` gist poll.

### Endpoint

Assigned by Notion at deploy time. Discover it with:

```bash
ntn workers webhook show kanbanEvent
```

### Headers

| Header | Required | Notes |
|---|---|---|
| `Content-Type: application/json` | yes | |
| `x-kanban-signature-256` | yes | `sha256=<hex>` where `<hex>` = `HMAC-SHA256(KANBAN_WEBHOOK_SECRET, rawBody)`. Verified with `crypto.timingSafeEqual`. |

### Env

| Var | Required | Purpose |
|---|---|---|
| `KANBAN_WEBHOOK_SECRET` | yes | Shared secret with the local hook. |
| `TASKS_DATABASE_ID` | yes | Target managed DB id. |
| `TASKS_DATA_SOURCE_ID` | yes | Used to look up existing rows by `task_id`. |
| `PROJECTS_DATA_SOURCE_ID` | optional | Used to resolve `parent_project` relations. Skipped when absent. |

### Payload shapes

All three variants share `event_type`, `kanban_id`, `board_slug`.

**Upsert** — single task create / update:

```json
{
  "event_type": "upsert",
  "kanban_id": "t_abcd1234",
  "board_slug": "hermes-projects-sync",
  "task_payload": {
    "task_id": "t_abcd1234",
    "board_slug": "hermes-projects-sync",
    "name": "Refactor sync",
    "status": "running",
    "assignee": "operator_dev",
    "body": "...",
    "parents": [],
    "children": [],
    "created_at": "2026-05-15T20:00:00Z",
    "updated_at": "2026-05-16T12:34:56Z",
    "latest_summary": null
  }
}
```

**Tombstone** — single task archive (sets the page-level `archived` flag):

```json
{
  "event_type": "tombstone",
  "kanban_id": "t_abcd1234",
  "board_slug": "hermes-projects-sync"
}
```

**Bulk upsert** — many tasks in one delivery (e.g. board recompute):

```json
{
  "event_type": "bulk_upsert",
  "board_slug": "hermes-projects-sync",
  "tasks": [ { /* GistTask */ }, { /* GistTask */ } ]
}
```

`GistTask` is defined in [`src/lib/notionHelpers.ts`](../../src/lib/notionHelpers.ts).

### Behavior

1. The platform invokes `execute(events, { notion })` with one or more deliveries batched.
2. For each delivery: HMAC verify → parse `event_type` → dispatch.
3. `upsert` / `bulk_upsert` → `upsertTaskViaNotion` resolves `parent_project` via `BOARD_TO_CHANNEL[board_slug]` then either `pages.update` (existing) or `pages.create` (new). `body` and `latest_summary` are truncated to 2000 chars.
4. `tombstone` → `tombstoneTaskViaNotion` looks up the page by `task_id` and calls `pages.update({ archived: true })`. Returns `not_found` if no row exists.

### Auto-disable

The Workers platform disables a webhook after **5 consecutive failed deliveries** (any 4xx/5xx including signature rejections). Re-enable manually from the Notion worker UI after the root cause is fixed. The gist-fed `tasksDelta` sync keeps Notion within ~1 minute of kanban truth while the webhook is offline.

### curl example

```bash
SECRET="$KANBAN_WEBHOOK_SECRET"
WEBHOOK_URL="https://workers.notion.com/.../kanbanEvent"  # from ntn workers webhook show

BODY='{"event_type":"upsert","kanban_id":"t_abcd1234","board_slug":"hermes-projects-sync","task_payload":{"task_id":"t_abcd1234","board_slug":"hermes-projects-sync","name":"Refactor sync","status":"running","assignee":"operator_dev","body":"","parents":[],"children":[],"created_at":"2026-05-15T20:00:00Z","updated_at":"2026-05-16T12:34:56Z","latest_summary":null}}'

SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"

curl -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "x-kanban-signature-256: $SIG" \
  --data "$BODY"
```

Be careful to sign **exactly** the bytes you send — any trailing newline or JSON re-formatting between signing and POSTing will fail verification.
