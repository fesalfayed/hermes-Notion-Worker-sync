#!/usr/bin/env python3
"""
publish_kanban_gist.py — Publish kanban board snapshot to a private GitHub gist.

Reads all tasks on the hermes-projects-sync kanban board (all statuses
including done/archived) and publishes a JSON snapshot to a private gist.
First run creates the gist; subsequent runs edit the same gist.

Designed for no-agent cron execution:
  - stdout is the delivery payload (empty = silent)
  - non-zero exit = error alert
"""

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────
BOARD_SLUG = "hermes-projects-sync"
DB_PATH = Path.home() / ".hermes" / "kanban" / "boards" / BOARD_SLUG / "kanban.db"
STATE_DIR = Path.home() / ".hermes" / "profiles" / "orchestrator" / "cron" / "state"
STATE_FILE = STATE_DIR / "kanban_gist_id.txt"
GIST_FILENAME = "kanban_snapshot.json"
GIST_DESC = "hermes-projects-sync kanban snapshot"

# gh CLI needs the real HOME for keychain access
GH_ENV = {**os.environ, "HOME": "/Users/fesal"}

# ── Status mapping ─────────────────────────────────────────────────────
# Kanban DB statuses → tasksDelta schema enum values
# tasksDelta expects: todo, running, blocked, done, cancelled, archived
STATUS_MAP = {
    "todo": "todo",
    "ready": "todo",       # ready is a kanban-internal pre-todo state
    "running": "running",
    "blocked": "blocked",
    "done": "done",
    "cancelled": "cancelled",
    "archived": "archived",
    "triage": "todo",      # triage tasks are pre-todo
}


def read_kanban_db():
    """Read all tasks from the kanban SQLite database."""
    if not DB_PATH.exists():
        print(f"ERROR: kanban DB not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    # Get all tasks
    tasks_rows = conn.execute(
        "SELECT id, title, body, assignee, status, priority, created_at, "
        "started_at, completed_at, result, metadata FROM tasks"
    ).fetchall()

    # Get all parent-child links
    links = conn.execute("SELECT parent_id, child_id FROM task_links").fetchall()
    parents_map = {}  # child_id -> [parent_ids]
    children_map = {}  # parent_id -> [child_ids]
    for link in links:
        parents_map.setdefault(link["child_id"], []).append(link["parent_id"])
        children_map.setdefault(link["parent_id"], []).append(link["child_id"])

    # Get latest completed run summary for each task
    summaries = conn.execute(
        "SELECT task_id, summary FROM task_runs "
        "WHERE outcome = 'completed' AND summary IS NOT NULL "
        "ORDER BY ended_at DESC"
    ).fetchall()
    summary_map = {}
    for row in summaries:
        if row["task_id"] not in summary_map:
            summary_map[row["task_id"]] = row["summary"]

    conn.close()

    # Build task objects matching tasksDelta schema
    tasks = []
    for row in tasks_rows:
        task_id = row["id"]
        status = STATUS_MAP.get(row["status"], row["status"])

        # Timestamps: kanban stores epoch integers, tasksDelta expects ISO 8601
        created_at = (
            datetime.fromtimestamp(row["created_at"], tz=timezone.utc).isoformat()
            if row["created_at"]
            else datetime.now(timezone.utc).isoformat()
        )
        # updated_at: use completed_at if available, else started_at, else created_at
        updated_epoch = row["completed_at"] or row["started_at"] or row["created_at"]
        updated_at = (
            datetime.fromtimestamp(updated_epoch, tz=timezone.utc).isoformat()
            if updated_epoch
            else created_at
        )

        task_obj = {
            "task_id": task_id,
            "board_slug": BOARD_SLUG,
            "name": row["title"],
            "status": status,
            "assignee": row["assignee"],
            "body": row["body"] or "",
            "parents": parents_map.get(task_id, []),
            "children": children_map.get(task_id, []),
            "created_at": created_at,
            "updated_at": updated_at,
            "latest_summary": summary_map.get(task_id),
        }
        tasks.append(task_obj)

    return tasks


def build_snapshot(tasks):
    """Build the JSON snapshot envelope."""
    return {
        "version": 1,
        "board": BOARD_SLUG,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "tasks": tasks,
    }


def gh_gist_create(json_path: str) -> str:
    """Create a new private gist and return the gist ID."""
    result = subprocess.run(
        [
            "gh", "gist", "create",
            json_path,
            "--desc", GIST_DESC,
        ],
        capture_output=True, text=True, env=GH_ENV,
    )
    if result.returncode != 0:
        print(f"ERROR: gh gist create failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    # gh gist create outputs the gist URL on stdout
    gist_url = result.stdout.strip()
    # Extract gist ID from URL (https://gist.github.com/<user>/<gist_id>)
    gist_id = gist_url.rstrip("/").split("/")[-1]
    return gist_id


def gh_gist_edit(gist_id: str, json_path: str):
    """Edit an existing gist with updated content."""
    result = subprocess.run(
        [
            "gh", "gist", "edit",
            gist_id,
            "--add", json_path,
        ],
        capture_output=True, text=True, env=GH_ENV,
    )
    if result.returncode != 0:
        print(f"ERROR: gh gist edit failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)


def get_gist_raw_url(gist_id: str) -> str:
    """Get the raw content URL for the gist file."""
    result = subprocess.run(
        [
            "gh", "api", f"gists/{gist_id}",
            "-q", f".files.\"{GIST_FILENAME}\".raw_url",
        ],
        capture_output=True, text=True, env=GH_ENV,
    )
    if result.returncode != 0:
        print(f"ERROR: gh api gists/{gist_id} failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()


def main():
    # 1. Read kanban state
    tasks = read_kanban_db()

    # 2. Build snapshot
    snapshot = build_snapshot(tasks)
    snapshot_json = json.dumps(snapshot, indent=2, ensure_ascii=False)

    # 3. Write to temp file
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", prefix="kanban_snapshot_",
        delete=False
    ) as f:
        # gh gist create uses the filename as the gist filename,
        # so we need to rename to match expected name
        tmp_path = f.name
        f.write(snapshot_json)

    # Rename temp file so gist filename is correct
    final_tmp = os.path.join(os.path.dirname(tmp_path), GIST_FILENAME)
    os.rename(tmp_path, final_tmp)

    try:
        # 4. Create or edit gist
        STATE_DIR.mkdir(parents=True, exist_ok=True)

        if STATE_FILE.exists():
            gist_id = STATE_FILE.read_text().strip()
            if gist_id:
                # Edit existing gist
                gh_gist_edit(gist_id, final_tmp)
                action = "edited"
            else:
                # State file exists but empty — create new
                gist_id = gh_gist_create(final_tmp)
                STATE_FILE.write_text(gist_id)
                action = "created"
        else:
            # First run — create gist
            gist_id = gh_gist_create(final_tmp)
            STATE_FILE.write_text(gist_id)
            action = "created"

        # 5. Get raw URL
        raw_url = get_gist_raw_url(gist_id)

        # 6. Output summary (stdout = delivery message for no-agent cron)
        # We keep this silent for recurring runs — only print on first create
        if action == "created":
            print(f"Kanban gist created: {gist_id}")
            print(f"Raw URL: {raw_url}")
            print(f"Tasks: {len(tasks)}")
        # For edits: silent (no stdout = no notification)

    finally:
        # Cleanup temp file
        if os.path.exists(final_tmp):
            os.unlink(final_tmp)


if __name__ == "__main__":
    main()
