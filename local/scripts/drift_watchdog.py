#!/usr/bin/env python3
"""
drift_watchdog.py — Hermes Projects Sync row-level drift watchdog.

Compares kanban DB ↔ Notion Tasks DB and Notion Projects DB for divergence.

Four diff categories emitted per tick:
  1. kanban_only   — tasks in kanban not present in Notion (excluding tombstoned)
  2. notion_only   — tasks in Notion (status != archived) not in kanban → orphan
  3. status_mismatch — same task_id in both, but status/title/assignee differs
  4. orphan_relation — Notion task whose `parent_project` relation points at a
                       project whose kanban_board_slug doesn't match the task's board_slug

Output:
  - JSON diff file at local/state/drift_latest.json (overwritten each tick)
  - Stdout: alert lines if any drift found (for cron delivery).
    Empty stdout when all clear (silent-success).

Runs every 15min via Hermes cron (no_agent=True).
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ── Paths ────────────────────────────────────────────────────────────
_home = Path(os.environ.get("REAL_HOME", str(Path.home())))
if not (_home / ".hermes").exists() and Path("/home/user/.hermes").exists():
    _home = Path("/home/user")

REPO_DIR = _home / "hermes-projects-sync"
STATE_DIR = REPO_DIR / "local" / "state"
DRIFT_JSON = STATE_DIR / "drift_latest.json"
DLQ_FILE = STATE_DIR / "kanban_to_notion_dlq.jsonl"

BOARD_SLUG = "hermes-projects-sync"
KANBAN_DB = _home / ".hermes" / "kanban" / "boards" / BOARD_SLUG / "kanban.db"

# ── Environment ──────────────────────────────────────────────────────
ENV = {**os.environ, "HOME": str(_home)}

# Load secrets from repo .env
env_file = REPO_DIR / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            ENV[k.strip()] = v.strip()

NOTION_API_TOKEN = ENV.get("NOTION_API_TOKEN", "")
NOTION_TASKS_DB_ID = ENV.get("NOTION_TASKS_DATABASE_ID", "")
NOTION_PROJECTS_DB_ID = ENV.get("NOTION_PROJECTS_DATABASE_ID", "")

# Status normalisation: kanban uses ready/triage which map to todo in Notion
STATUS_MAP = {
    "todo": "todo",
    "ready": "todo",
    "triage": "todo",
    "running": "running",
    "blocked": "blocked",
    "done": "done",
    "cancelled": "cancelled",
    "archived": "archived",
}


# ── Notion API helpers ───────────────────────────────────────────────
def notion_query_all(database_id: str, filter_obj: dict | None = None) -> list[dict]:
    """Paginate through a Notion database query, return all result pages."""
    results = []
    start_cursor = None
    while True:
        body: dict[str, Any] = {"page_size": 100}
        if filter_obj:
            body["filter"] = filter_obj
        if start_cursor:
            body["start_cursor"] = start_cursor

        r = subprocess.run(
            [
                "curl", "-sf",
                "-X", "POST",
                f"https://api.notion.com/v1/databases/{database_id}/query",
                "-H", f"Authorization: Bearer {NOTION_API_TOKEN}",
                "-H", "Content-Type: application/json",
                "-H", "Notion-Version: 2022-06-28",
                "-d", json.dumps(body),
            ],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            raise RuntimeError(f"Notion API query failed: {r.stderr[:200]}")

        data = json.loads(r.stdout)
        results.extend(data.get("results", []))
        if data.get("has_more") and data.get("next_cursor"):
            start_cursor = data["next_cursor"]
        else:
            break
    return results


def extract_rich_text(props: dict, key: str) -> str:
    """Extract plain text from a Notion rich_text property."""
    prop = props.get(key, {})
    if prop.get("type") == "rich_text":
        parts = prop.get("rich_text", [])
        return "".join(p.get("plain_text", "") for p in parts)
    return ""


def extract_title(props: dict) -> str:
    """Extract plain text from a Notion title property."""
    prop = props.get("Name", {})
    if prop.get("type") == "title":
        parts = prop.get("title", [])
        return "".join(p.get("plain_text", "") for p in parts)
    return ""


def extract_select(props: dict, key: str) -> str:
    """Extract select value."""
    prop = props.get(key, {})
    if prop.get("type") == "select":
        sel = prop.get("select")
        if sel:
            return sel.get("name", "")
    return ""


def extract_relation_ids(props: dict, key: str) -> list[str]:
    """Extract relation page IDs."""
    prop = props.get(key, {})
    if prop.get("type") == "relation":
        return [r.get("id", "") for r in prop.get("relation", []) if r.get("id")]
    return []


# ── Read kanban DB ───────────────────────────────────────────────────
def read_kanban_tasks() -> dict[str, dict]:
    """Read all non-archived tasks from kanban DB, keyed by task_id."""
    if not KANBAN_DB.exists():
        raise RuntimeError(f"Kanban DB not found: {KANBAN_DB}")

    conn = sqlite3.connect(str(KANBAN_DB), timeout=5)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, title, status, assignee FROM tasks"
    ).fetchall()
    conn.close()

    tasks = {}
    for row in rows:
        status = STATUS_MAP.get(row["status"], row["status"])
        # Skip archived/gc'd tasks — these are expected not to be in Notion active set
        if status == "archived":
            continue
        tasks[row["id"]] = {
            "task_id": row["id"],
            "title": row["title"],
            "status": status,
            "assignee": row["assignee"] or "",
        }
    return tasks


# ── Read Notion Tasks DB ─────────────────────────────────────────────
def read_notion_tasks() -> dict[str, dict]:
    """Read all tasks from Notion Tasks DB, keyed by task_id."""
    if not NOTION_API_TOKEN or not NOTION_TASKS_DB_ID:
        raise RuntimeError("NOTION_API_TOKEN or NOTION_TASKS_DATABASE_ID not set")

    # Query only tasks with board_slug matching our board
    pages = notion_query_all(NOTION_TASKS_DB_ID, {
        "property": "board_slug",
        "rich_text": {"equals": BOARD_SLUG},
    })

    tasks = {}
    for page in pages:
        props = page.get("properties", {})
        task_id = extract_rich_text(props, "task_id")
        if not task_id:
            continue
        status = extract_select(props, "status")
        tasks[task_id] = {
            "task_id": task_id,
            "title": extract_title(props),
            "status": status,
            "assignee": extract_rich_text(props, "assignee"),
            "board_slug": extract_rich_text(props, "board_slug"),
            "notion_page_id": page.get("id", ""),
            "parent_project_ids": extract_relation_ids(props, "parent_project"),
        }
    return tasks


# ── Read Notion Projects DB ──────────────────────────────────────────
def read_notion_projects() -> dict[str, dict]:
    """Read all projects from Notion Projects DB, keyed by page_id."""
    if not NOTION_API_TOKEN or not NOTION_PROJECTS_DB_ID:
        raise RuntimeError("NOTION_API_TOKEN or NOTION_PROJECTS_DATABASE_ID not set")

    pages = notion_query_all(NOTION_PROJECTS_DB_ID)
    projects = {}
    for page in pages:
        page_id = page.get("id", "")
        props = page.get("properties", {})
        projects[page_id] = {
            "page_id": page_id,
            "name": extract_title(props),
            "kanban_board_slug": extract_rich_text(props, "kanban_board_slug"),
            "discord_channel_id": extract_rich_text(props, "discord_channel_id"),
        }
    return projects


# ── Diff engine ──────────────────────────────────────────────────────
def compute_drift(
    kanban_tasks: dict[str, dict],
    notion_tasks: dict[str, dict],
    notion_projects: dict[str, dict],
) -> dict:
    """Compute 4 categories of drift between kanban and Notion."""

    kanban_ids = set(kanban_tasks.keys())
    notion_ids = set(notion_tasks.keys())
    # For notion_only, exclude tasks that are already archived in Notion (tombstoned)
    active_notion_ids = {
        tid for tid, t in notion_tasks.items() if t["status"] != "archived"
    }

    # 1. kanban_only: in kanban but not in Notion (active tasks only)
    kanban_only_ids = kanban_ids - notion_ids
    kanban_only = []
    for tid in sorted(kanban_only_ids):
        t = kanban_tasks[tid]
        kanban_only.append({
            "task_id": tid,
            "title": t["title"],
            "status": t["status"],
            "assignee": t["assignee"],
        })

    # 2. notion_only: in Notion (active) but not in kanban → orphans
    notion_only_ids = active_notion_ids - kanban_ids
    notion_only = []
    for tid in sorted(notion_only_ids):
        t = notion_tasks[tid]
        notion_only.append({
            "task_id": tid,
            "title": t["title"],
            "status": t["status"],
            "assignee": t["assignee"],
            "notion_page_id": t["notion_page_id"],
        })

    # 3. status_mismatch: present in both, but fields differ
    common_ids = kanban_ids & notion_ids
    status_mismatch = []
    for tid in sorted(common_ids):
        kt = kanban_tasks[tid]
        nt = notion_tasks[tid]
        diffs = {}
        if kt["status"] != nt["status"]:
            diffs["status"] = {"kanban": kt["status"], "notion": nt["status"]}
        if kt["title"] != nt["title"]:
            diffs["title"] = {
                "kanban": kt["title"][:80],
                "notion": nt["title"][:80],
            }
        if kt["assignee"] != nt["assignee"]:
            diffs["assignee"] = {"kanban": kt["assignee"], "notion": nt["assignee"]}
        if diffs:
            status_mismatch.append({
                "task_id": tid,
                "diffs": diffs,
            })

    # 4. orphan_relation: Notion task with parent_project pointing at a project
    #    whose kanban_board_slug != the task's board_slug
    orphan_relation = []
    for tid, nt in notion_tasks.items():
        for proj_id in nt.get("parent_project_ids", []):
            proj = notion_projects.get(proj_id)
            if proj is None:
                # Relation points at a page that's not in projects DB
                orphan_relation.append({
                    "task_id": tid,
                    "project_page_id": proj_id,
                    "project_name": "(not found)",
                    "project_board_slug": "(missing)",
                    "task_board_slug": nt["board_slug"],
                })
            elif proj["kanban_board_slug"] and proj["kanban_board_slug"] != nt["board_slug"]:
                orphan_relation.append({
                    "task_id": tid,
                    "project_page_id": proj_id,
                    "project_name": proj["name"],
                    "project_board_slug": proj["kanban_board_slug"],
                    "task_board_slug": nt["board_slug"],
                })

    return {
        "kanban_only": kanban_only,
        "notion_only": notion_only,
        "status_mismatch": status_mismatch,
        "orphan_relation": orphan_relation,
    }


# ── Count aligned items ─────────────────────────────────────────────
def count_aligned(
    kanban_tasks: dict[str, dict],
    notion_tasks: dict[str, dict],
    notion_projects: dict[str, dict],
    drift: dict,
) -> tuple[int, int]:
    """Count tasks and projects that are fully aligned."""
    common = set(kanban_tasks.keys()) & set(notion_tasks.keys())
    mismatched_ids = {m["task_id"] for m in drift["status_mismatch"]}
    tasks_aligned = len(common - mismatched_ids)

    # Projects aligned = all projects minus those referenced in orphan_relation
    orphan_proj_ids = {o["project_page_id"] for o in drift["orphan_relation"]}
    projects_aligned = len(notion_projects) - len(orphan_proj_ids)

    return tasks_aligned, max(0, projects_aligned)


# ── Main ─────────────────────────────────────────────────────────────
def main():
    try:
        kanban_tasks = read_kanban_tasks()
        notion_tasks = read_notion_tasks()
        notion_projects = read_notion_projects()
    except Exception as e:
        print(f"⚠️ Drift watchdog error: {e}", file=sys.stderr)
        sys.exit(1)

    drift = compute_drift(kanban_tasks, notion_tasks, notion_projects)
    tasks_aligned, projects_aligned = count_aligned(
        kanban_tasks, notion_tasks, notion_projects, drift
    )

    # Build structured output
    now = datetime.now(timezone.utc).isoformat()
    output = {
        "generated_at": now,
        "board": BOARD_SLUG,
        "counts": {
            "kanban_tasks": len(kanban_tasks),
            "notion_tasks": len(notion_tasks),
            "notion_projects": len(notion_projects),
            "tasks_aligned": tasks_aligned,
            "projects_aligned": projects_aligned,
        },
        "drift": {
            "kanban_only": {
                "count": len(drift["kanban_only"]),
                "items": drift["kanban_only"],
            },
            "notion_only": {
                "count": len(drift["notion_only"]),
                "items": drift["notion_only"],
            },
            "status_mismatch": {
                "count": len(drift["status_mismatch"]),
                "items": drift["status_mismatch"],
            },
            "orphan_relation": {
                "count": len(drift["orphan_relation"]),
                "items": drift["orphan_relation"],
            },
        },
    }

    # Write JSON to state dir
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    DRIFT_JSON.write_text(json.dumps(output, indent=2, ensure_ascii=False))

    # Check for any drift
    total_drift = sum(
        output["drift"][cat]["count"]
        for cat in ("kanban_only", "notion_only", "status_mismatch", "orphan_relation")
    )

    if total_drift > 0:
        # Emit alert to stdout (cron delivery)
        print(f"🔍 Drift detected ({total_drift} items) — see {DRIFT_JSON}")
        for cat in ("kanban_only", "notion_only", "status_mismatch", "orphan_relation"):
            c = output["drift"][cat]["count"]
            if c > 0:
                print(f"  ⚠ {cat}: {c}")
                # Show top 3 identifiers
                for item in output["drift"][cat]["items"][:3]:
                    tid = item.get("task_id", "?")
                    extra = ""
                    if cat == "status_mismatch":
                        fields = ", ".join(item.get("diffs", {}).keys())
                        extra = f" [{fields}]"
                    elif cat == "orphan_relation":
                        extra = f" → project {item.get('project_name', '?')}"
                    else:
                        extra = f" ({item.get('title', '?')[:40]})"
                    print(f"    - {tid}{extra}")
    # else: empty stdout = silent (healthy)


if __name__ == "__main__":
    main()
