# 4.3 Webhook-Driven Push — Deployment Runbook

## What Was Built

### 1. `worker.webhook("kanbanEvent")` in `src/index.ts`
- Receives POST payloads from the local shell hook
- Verifies HMAC-SHA256 signature via `X-Kanban-Signature-256` header
- Dispatches to `upsertTaskViaNotion()` or `tombstoneTaskViaNotion()` based on `event_type`
- Uses `context.notion` (Notion SDK client) — NOT managed DB writes
- Supports: `upsert` (single task), `tombstone` (archive by ID), `bulk_upsert` (array)
- Throws `WebhookVerificationError` on bad/missing HMAC → Notion returns 401

### 2. Updated `local/hooks/kanban_to_notion.py`
- PRIMARY PATH: reads task from kanban SQLite DB, POSTs signed payload to webhook URL
- FALLBACK PATH: on webhook failure (5xx, timeout, network), falls back to debounced gist publish (30s window)
- Webhook retry queue at: `local/state/kanban_webhook_retry_queue.jsonl`
- Webhook URL read from: `local/state/kanban_webhook_url.txt` (set after deploy)
- Secret read from: `.env` → `KANBAN_WEBHOOK_SECRET`

### 3. `.env` updated with `KANBAN_WEBHOOK_SECRET`
- Secret: `e05eb61ad038c9764b3ff518332462611e3eaa3b64c05997616e2dfdb1f9f384`
- Must be pushed to deployed worker env

## Deployment Steps (requires interactive `ntn login`)

```bash
cd /Users/fesal/hermes-projects-sync

# 1. Build (already done, but re-run to be safe)
npm run build

# 2. Push the webhook secret to deployed worker env
ntn workers env push --yes
# This reads .env and pushes all vars including KANBAN_WEBHOOK_SECRET

# 3. Deploy the updated worker
ntn workers deploy

# 4. Get the webhook URL
ntn workers webhooks list
# Copy the URL for "kanbanEvent" and save it:
# echo "https://www.notion.so/webhooks/worker/..." > local/state/kanban_webhook_url.txt

# 5. Verify the webhook is registered
ntn workers webhooks list --json
```

## Post-Deploy Verification

### Test 1: Signature mismatch returns 401
```bash
# Send a POST with wrong signature — should fail
curl -X POST "<WEBHOOK_URL>" \
  -H "Content-Type: application/json" \
  -H "X-Kanban-Signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000" \
  -d '{"event_type":"upsert","kanban_id":"t_test","board_slug":"hermes-projects-sync"}'
# Expected: 202 Accepted (async), but run logs show WebhookVerificationError
ntn workers runs list --plain | head -5
```

### Test 2: Valid upsert via kanban tool
```bash
# Any kanban tool call should now:
# 1. Trigger the hook
# 2. Hook reads task from DB
# 3. Hook POSTs to webhook with HMAC
# 4. Webhook verifies + upserts via Notion API
# Check the hook log:
tail -20 /Users/fesal/hermes-projects-sync/local/state/kanban_to_notion_hook.log
# Should show: "webhook: upsert t_xxx via kanban_xxx -> HTTP 202"

# Check worker run logs:
ntn workers runs list --plain | head -5
ntn workers runs logs <run-id>
# Should show: "kanbanEvent: updated task t_xxx"
```

### Test 3: Webhook 5xx falls through to gist
```bash
# Temporarily set a bad webhook URL:
echo "https://httpstat.us/500" > local/state/kanban_webhook_url.txt
# Trigger a kanban tool call
# Check log shows: "webhook: FAILED ... falling back to gist"
# Check retry queue has an entry:
cat local/state/kanban_webhook_retry_queue.jsonl
# Restore the real URL after testing
```

## Decommission Plan (for card 4.5 — NOT done here)

Once the webhook path is proven stable (3+ successful webhook runs in production):

1. **Pause the gist publisher cron** (15m → no longer needed for steady-state):
   ```bash
   hermes cron pause 12ada971a84c  # kanban-gist-publisher
   ```

2. **Pause the tasksDelta sync** (1m → webhook handles real-time):
   ```bash
   cd /Users/fesal/hermes-projects-sync
   ntn workers sync pause tasksDelta
   ```

3. **Keep these as emergency fallback** — do NOT remove:
   - The gist publisher script (`publish_kanban_gist.py`)
   - The tasksBackfill sync (manual trigger for drift correction)
   - The fallback gist-publish path in the hook

4. **Monitor for 1 week** before considering permanent removal.

5. **Journal entry**: Document the decommission in the infra-journal Discord channel.

## Architecture After 4.3

```
┌────────── LOCAL (macOS) ──────────────────────────────────────────┐
│                                                                    │
│  Kanban DB ─── kanban_to_notion.py ──→ Notion Workers Webhook     │
│  (SQLite)     (shell hook,              (kanbanEvent)             │
│               post_tool_call)                                     │
│               │                         │                         │
│               │ ← fallback on 5xx ──→   ↓                        │
│               ↓                         context.notion            │
│               publish_gist (30s debounce)  → tasks DB upsert     │
│               ↓                                                   │
│               GitHub Gist → tasksDelta (1m)                       │
│                                                                   │
│  Latency:                                                         │
│    Webhook path: <5 sec (kanban event → Notion row)              │
│    Fallback path: ~1 min (gist 30s + delta 1m)                   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```
