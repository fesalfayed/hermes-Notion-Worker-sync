#!/usr/bin/env python3
"""
Test 4.3 acceptance: modify a task title, send via webhook, verify in Notion.
Uses the correct payload format matching the webhook handler.
"""

import json
import hashlib
import hmac
import sqlite3
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

TEST_TASK_ID = "t_9c9308bd"
TITLE_SUFFIX = " [acceptance-4.3]"

# Read the task
db_path = "/Users/fesal/.hermes/kanban/boards/hermes-projects-sync/kanban.db"
conn = sqlite3.connect(db_path, timeout=2)
conn.row_factory = sqlite3.Row
row = conn.execute("SELECT * FROM tasks WHERE id = ?", (TEST_TASK_ID,)).fetchone()
task = dict(row)
parents = [r[0] for r in conn.execute("SELECT parent_id FROM task_links WHERE child_id = ?", (TEST_TASK_ID,)).fetchall()]
children = [r[0] for r in conn.execute("SELECT child_id FROM task_links WHERE parent_id = ?", (TEST_TASK_ID,)).fetchall()]
conn.close()

original_title = task.get("title", "")
modified_title = original_title + TITLE_SUFFIX
print(f"Original title: {original_title}")
print(f"Modified title: {modified_title}")

# Build payload - using "upsert" event_type with "task_payload" (singular)
ts_fields = [task.get("created_at", 0), task.get("started_at") or 0, task.get("completed_at") or 0]
updated_at = datetime.now(timezone.utc).isoformat()
created_at = datetime.fromtimestamp(task["created_at"], tz=timezone.utc).isoformat()

task_payload = {
    "task_id": task["id"],
    "board_slug": "hermes-projects-sync",
    "name": modified_title,
    "status": task.get("status", "todo"),
    "assignee": task.get("assignee"),
    "body": (task.get("body", "") or "")[:2000],
    "parents": parents,
    "children": children,
    "created_at": created_at,
    "updated_at": updated_at,
    "latest_summary": None,
}

payload = {
    "event_type": "upsert",
    "kanban_id": TEST_TASK_ID,
    "board_slug": "hermes-projects-sync",
    "task_payload": task_payload,
}

body = json.dumps(payload, separators=(",", ":"))
mac = hmac.new(secret.encode(), body.encode(), hashlib.sha256)
signature = f"sha256={mac.hexdigest()}"

print(f"\n--- Sending webhook (upsert with title change) ---")
req = urllib.request.Request(
    webhook_url,
    data=body.encode("utf-8"),
    headers={
        "Content-Type": "application/json",
        "X-Kanban-Signature-256": signature,
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        resp_body = json.loads(resp.read().decode())
        print(f"Response: HTTP {resp.status}, eventId: {resp_body.get('eventId', 'N/A')}")
except urllib.error.HTTPError as e:
    print(f"HTTPError: {e.code} {e.reason}")
    err_body = e.read().decode()
    print(f"Body: {err_body[:500]}")
    exit(1)

# Wait for processing
print("\nWaiting 8s for Notion to process...")
time.sleep(8)

# Verify in Notion
print("\n--- Verifying in Notion ---")
query_url = f"https://api.notion.com/v1/databases/{TASKS_DB_ID}/query"
query_body = json.dumps({"filter": {"property": "task_id", "rich_text": {"equals": TEST_TASK_ID}}})
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
    result = json.loads(resp.read().decode())

pages = result.get("results", [])
if not pages:
    print("ERROR: Task not found in Notion!")
    exit(1)

page = pages[0]
title_parts = page.get("properties", {}).get("Name", {}).get("title", [])
notion_title = "".join(p.get("plain_text", "") for p in title_parts)
last_edited = page.get("last_edited_time", "unknown")

print(f"Notion title: {notion_title}")
print(f"Last edited: {last_edited}")

if TITLE_SUFFIX in notion_title:
    print("\n✅ PASS: Title change propagated via webhook in <10s")
    
    # Now revert
    print("\n--- Reverting title ---")
    task_payload["name"] = original_title
    task_payload["updated_at"] = datetime.now(timezone.utc).isoformat()
    payload["task_payload"] = task_payload
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
        resp_body = json.loads(resp.read().decode())
        print(f"Revert: HTTP {resp.status}, eventId: {resp_body.get('eventId', 'N/A')}")
    print("Title reverted.")
else:
    print(f"\n❌ FAIL: Title suffix not found in Notion title.")
    print("  The webhook was accepted (202) but the worker may have errored internally.")
    print("  Check: env vars TASKS_DATABASE_ID and TASKS_DATA_SOURCE_ID on deployed worker.")
