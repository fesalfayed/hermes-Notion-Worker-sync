#!/usr/bin/env python3
"""
Test 4.2 acceptance: tombstone via webhook.
Creates a test task via webhook, then tombstones it, verifies it's archived in Notion.
"""

import json
import hashlib
import hmac
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

# Load env
env = {}
with open("/Users/fesal/hermes-projects-sync/.env") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()

webhook_url = open("/Users/fesal/hermes-projects-sync/local/state/kanban_webhook_url.txt").read().strip()
secret = env["KANBAN_WEBHOOK_SECRET"]
NOTION_API_TOKEN = env["NOTION_API_TOKEN"]
TASKS_DB_ID = "3628f04b-6d24-8112-875e-f787bfa1342a"

TEST_TASK_ID = "t_tombstone_test_42"

def send_webhook(payload):
    body = json.dumps(payload, separators=(",", ":"))
    mac = hmac.new(secret.encode(), body.encode(), hashlib.sha256)
    signature = f"sha256={mac.hexdigest()}"
    req = urllib.request.Request(
        webhook_url,
        data=body.encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Kanban-Signature-256": signature,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status, json.loads(resp.read().decode())

def query_notion(task_id):
    query_url = f"https://api.notion.com/v1/databases/{TASKS_DB_ID}/query"
    query_body = json.dumps({"filter": {"property": "task_id", "rich_text": {"equals": task_id}}})
    req = urllib.request.Request(
        query_url,
        data=query_body.encode(),
        headers={
            "Authorization": f"Bearer {NOTION_API_TOKEN}",
            "Content-Type": "application/json",
            "Notion-Version": "2022-06-28",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())

# Step 1: Create a test task via webhook
print("--- Step 1: Create test task via webhook ---")
now = datetime.now(timezone.utc).isoformat()
create_payload = {
    "event_type": "upsert",
    "kanban_id": TEST_TASK_ID,
    "board_slug": "hermes-projects-sync",
    "task_payload": {
        "task_id": TEST_TASK_ID,
        "board_slug": "hermes-projects-sync",
        "name": "Tombstone acceptance test 4.2",
        "status": "todo",
        "assignee": "operator_dev",
        "body": "This task will be tombstoned",
        "parents": [],
        "children": [],
        "created_at": now,
        "updated_at": now,
        "latest_summary": None,
    }
}

status, resp = send_webhook(create_payload)
print(f"Create: HTTP {status}, eventId: {resp.get('eventId', 'N/A')}")

print("Waiting 8s for create to process...")
time.sleep(8)

# Verify created
result = query_notion(TEST_TASK_ID)
pages = result.get("results", [])
if pages:
    page = pages[0]
    print(f"Task created in Notion: page_id={page['id']}, archived={page.get('archived')}")
else:
    print("ERROR: Task not found after create!")
    exit(1)

# Step 2: Tombstone via webhook
print("\n--- Step 2: Tombstone the task ---")
tombstone_payload = {
    "event_type": "tombstone",
    "kanban_id": TEST_TASK_ID,
    "board_slug": "hermes-projects-sync",
}

status, resp = send_webhook(tombstone_payload)
print(f"Tombstone: HTTP {status}, eventId: {resp.get('eventId', 'N/A')}")

print("Waiting 8s for tombstone to process...")
time.sleep(8)

# Step 3: Verify tombstoned (archived=true)
print("\n--- Step 3: Verify tombstoned ---")
# Query by page ID (archived pages don't appear in DB queries)
page_id = pages[0]["id"]
req = urllib.request.Request(
    f"https://api.notion.com/v1/pages/{page_id}",
    headers={
        "Authorization": f"Bearer {NOTION_API_TOKEN}",
        "Notion-Version": "2022-06-28",
    },
)
with urllib.request.urlopen(req, timeout=10) as resp:
    page_data = json.loads(resp.read().decode())

archived = page_data.get("archived", False)
print(f"Page archived: {archived}")

if archived:
    print("\n✅ PASS: Tombstone propagated via webhook — task archived in Notion")
else:
    print("\n❌ FAIL: Task not archived after tombstone webhook")
