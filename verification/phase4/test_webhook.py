#!/usr/bin/env python3
"""Test the webhook push by sending a real task payload."""

import json
import hashlib
import hmac
import sqlite3
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

# Read a real task from DB
db_path = "/home/user/.hermes/kanban/boards/hermes-projects-sync/kanban.db"
conn = sqlite3.connect(db_path, timeout=2)
conn.row_factory = sqlite3.Row
row = conn.execute("SELECT * FROM tasks WHERE id = ?", ("t_9c9308bd",)).fetchone()
task = dict(row)

# Get parents/children
parents = [r[0] for r in conn.execute("SELECT parent_id FROM task_links WHERE child_id = ?", ("t_9c9308bd",)).fetchall()]
children = [r[0] for r in conn.execute("SELECT child_id FROM task_links WHERE parent_id = ?", ("t_9c9308bd",)).fetchall()]

conn.close()

# Build payload like the hook would
ts_fields = [task.get("created_at", 0), task.get("started_at") or 0, task.get("completed_at") or 0]
updated_at = datetime.fromtimestamp(max(ts_fields), tz=timezone.utc).isoformat()
created_at = datetime.fromtimestamp(task["created_at"], tz=timezone.utc).isoformat()

payload = {
    "event_type": "task_upsert",
    "tasks": [{
        "task_id": task["id"],
        "board_slug": "hermes-projects-sync",
        "name": task.get("title", ""),
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

print(f"Sending webhook to: {webhook_url}")
print(f"Task: {task['id']} - {task['title'][:60]}")
print(f"Signature: {signature[:30]}...")
print(f"Payload size: {len(body)} bytes")

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
        print(f"Response: HTTP {resp.status}")
        resp_body = resp.read().decode()
        print(f"Body: {resp_body[:500]}")
except urllib.error.HTTPError as e:
    print(f"HTTPError: {e.code} {e.reason}")
    print(f"Body: {e.read().decode()[:500]}")
except Exception as e:
    print(f"Error: {e}")
