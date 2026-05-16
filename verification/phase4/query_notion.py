#!/usr/bin/env python3
"""Query Notion Tasks DB for verification."""

import json
import os
import sys
import urllib.request
import urllib.error

# Load env
env = {}
with open("/home/user/hermes-projects-sync/.env") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()

NOTION_API_TOKEN = env["NOTION_API_TOKEN"]
TASKS_DB_ID = "3628f04b-6d24-8112-875e-f787bfa1342a"

def query_notion_task(task_id):
    """Query Notion Tasks DB for a specific task."""
    url = f"https://api.notion.com/v1/databases/{TASKS_DB_ID}/query"
    body = json.dumps({
        "filter": {"property": "task_id", "rich_text": {"equals": task_id}}
    })
    
    req = urllib.request.Request(
        url,
        data=body.encode(),
        headers={
            "Authorization": f"Bearer {NOTION_API_TOKEN}",
            "Content-Type": "application/json",
            "Notion-Version": "2022-06-28",
        },
        method="POST",
    )
    
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())

def get_text_prop(page, prop_name):
    """Extract rich_text property value."""
    props = page.get("properties", {})
    prop = props.get(prop_name, {})
    if prop.get("type") == "rich_text":
        parts = prop.get("rich_text", [])
        return "".join(p.get("plain_text", "") for p in parts)
    elif prop.get("type") == "title":
        parts = prop.get("title", [])
        return "".join(p.get("plain_text", "") for p in parts)
    elif prop.get("type") == "select":
        sel = prop.get("select")
        return sel.get("name") if sel else None
    return None

# Query for given task or default
task_id = sys.argv[1] if len(sys.argv) > 1 else "t_9c9308bd"
print(f"Querying Notion for task: {task_id}")

result = query_notion_task(task_id)
pages = result.get("results", [])

if not pages:
    print(f"NOT FOUND in Notion Tasks DB")
    sys.exit(1)

page = pages[0]
print(f"Found page: {page['id']}")
print(f"  Title: {get_text_prop(page, 'Name')}")
print(f"  task_id: {get_text_prop(page, 'task_id')}")
print(f"  status: {get_text_prop(page, 'status')}")
print(f"  assignee: {get_text_prop(page, 'assignee')}")
print(f"  board_slug: {get_text_prop(page, 'board_slug')}")
print(f"  archived: {page.get('archived', False)}")
print(f"  last_edited: {page.get('last_edited_time', 'unknown')}")
