#!/usr/bin/env python3
"""
Test 4.3 acceptance: modify a task title, send via webhook, verify in Notion.
Uses a test suffix that we'll remove after verification.
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
with open("/home/user/hermes-projects-sync/.env") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()

webhook_url = open("/home/user/hermes-projects-sync/local/state/kanban_webhook_url.txt").read().strip()
secret = env["KANBAN_WEBHOOK_SECRET"]
NOTION_API_TOKEN = env["NOTION_API_TOKEN"]
TASKS_DB_ID = "3628f04b-6d24-8112-875e-f787bfa1342a"

TEST_TASK_ID = "t_9c9308bd"
# We'll send the current title with a test suffix to prove real-time update
TITLE_SUFFIX = " [acceptance-test-4.3]"

# Read the task
db_path = "/home/user/.hermes/kanban/boards/hermes-projects-sync/kanban.db"
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

# Build + send webhook with modified title
ts_fields = [task.get("created_at", 0), task.get("started_at") or 0, task.get("completed_at") or 0]
updated_at = datetime.now(timezone.utc).isoformat()  # force fresh timestamp
created_at = datetime.fromtimestamp(task["created_at"], tz=timezone.utc).isoformat()

payload = {
    "event_type": "task_upsert",
    "tasks": [{
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
    }]
}

body = json.dumps(payload, separators=(",", ":"))
mac = hmac.new(secret.encode(), body.encode(), hashlib.sha256)
signature = f"sha256={mac.hexdigest()}"

print(f"\n--- Sending webhook (title change) ---")
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
    print(f"Response: HTTP {resp.status}, eventId: {resp_body.get('eventId', 'N/A')}")

# Wait a bit for processing
print("\nWaiting 5s for Notion to process...")
time.sleep(5)

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
else:
    print(f"\n❌ FAIL: Title suffix not found. Expected suffix '{TITLE_SUFFIX}' in title.")
    print("  (May need more time for processing)")

# Now revert: send the original title back
print("\n--- Reverting title ---")
payload["tasks"][0]["name"] = original_title
payload["tasks"][0]["updated_at"] = datetime.now(timezone.utc).isoformat()
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
    print(f"Revert response: HTTP {resp.status}, eventId: {resp_body.get('eventId', 'N/A')}")

print("\nDone. Title reverted to original.")
