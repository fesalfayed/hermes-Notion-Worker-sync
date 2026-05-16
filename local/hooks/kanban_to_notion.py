#!/usr/bin/env python3
"""
Shell hook: post_tool_call handler for kanban_* tools.

Fires after every kanban tool call (kanban_complete, kanban_block,
kanban_comment, kanban_create, kanban_heartbeat, kanban_show, kanban_link).
Reads the hook JSON payload from stdin, extracts the task_id, fetches
full task state via `hermes kanban show --json`, and fires
`ntn workers exec upsertTask -d '<payload>'` in the background.

On failure, appends the payload to the retry queue JSONL file for
the drainer cron to pick up.

MUST exit within <1 sec — the hook runs inside the agent's tool loop.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

# ── Paths ────────────────────────────────────────────────────────────
# Use REAL_HOME to handle sandboxed vs real execution contexts.
_home = Path(os.environ.get("REAL_HOME", str(Path.home())))
_real_home = Path("/Users/fesal")  # fallback for macOS
_kanban_sentinel = _home / ".hermes" / "kanban"
if not _kanban_sentinel.exists() and (_real_home / ".hermes" / "kanban").exists():
    _home = _real_home

REPO_DIR = _home / "hermes-projects-sync"
STATE_DIR = REPO_DIR / "local" / "state"
RETRY_QUEUE = STATE_DIR / "kanban_to_notion_retry_queue.jsonl"
LOG_FILE = STATE_DIR / "kanban_to_notion_hook.log"
CURSOR_FILE = STATE_DIR / "kanban_to_notion_cursor.txt"

# Kanban board DB (hermes-projects-sync)
BOARD_SLUG = "hermes-projects-sync"
KANBAN_DB = _home / ".hermes" / "kanban" / "boards" / BOARD_SLUG / "kanban.db"

# Ensure state directory exists
STATE_DIR.mkdir(parents=True, exist_ok=True)

# Tool names that trigger a sync
SYNC_TOOL_NAMES = {
    "kanban_complete",
    "kanban_block",
    "kanban_comment",
    "kanban_create",
    "kanban_heartbeat",
    "kanban_link",
}

# Event kinds that warrant an upsert
SYNC_EVENT_KINDS = {
    "created",
    "claimed",
    "started",
    "completed",
    "blocked",
    "unblocked",
    "archived",
    "commented",
    "assignee_changed",
    "promoted",
    "spawned",
}


def log(msg: str) -> None:
    """Append a timestamped line to the hook log."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    try:
        with open(LOG_FILE, "a") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def enqueue_retry(payload: dict, error: str) -> None:
    """Append a failed payload to the retry queue."""
    entry = {
        "payload": payload,
        "error": error,
        "retries": 0,
        "queued_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        with open(RETRY_QUEUE, "a") as f:
            f.write(json.dumps(entry, separators=(",", ":")) + "\n")
        log(f"queued for retry: task_id={payload.get('task_id', '?')} error={error}")
    except Exception as e:
        log(f"FATAL: failed to write retry queue: {e}")


def get_task_json(task_id: str) -> dict | None:
    """Fetch full task state via hermes kanban show --json."""
    try:
        result = subprocess.run(
            ["hermes", "kanban", "show", task_id, "--json"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            log(f"hermes kanban show failed: rc={result.returncode} stderr={result.stderr[:200]}")
            return None
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        log(f"hermes kanban show timed out for {task_id}")
        return None
    except Exception as e:
        log(f"hermes kanban show exception: {e}")
        return None


def build_upsert_payload(task_data: dict, board_slug: str) -> dict:
    """
    Convert the hermes kanban show --json output into the schema
    expected by the ntn upsertTask tool.
    """
    task = task_data.get("task", {})
    task_id = task.get("id", "")
    title = task.get("title", "")
    status = task.get("status", "todo")
    assignee = task.get("assignee")
    body = task.get("body", "")
    parents = task_data.get("parents", [])
    children = task_data.get("children", [])

    # Map kanban status to the Notion select values
    # kanban statuses: todo, ready, running, blocked, done, archived
    # Notion select: todo, running, blocked, done, cancelled, archived
    status_map = {
        "todo": "todo",
        "ready": "todo",      # 'ready' maps to 'todo' in Notion
        "running": "running",
        "blocked": "blocked",
        "done": "done",
        "cancelled": "cancelled",
        "archived": "archived",
    }
    notion_status = status_map.get(status, "todo")

    # Timestamps: kanban stores epoch ints, convert to ISO 8601
    created_at = task.get("created_at")
    started_at = task.get("started_at")
    completed_at = task.get("completed_at")

    def epoch_to_iso(epoch) -> str:
        if epoch is None:
            return datetime.now(timezone.utc).isoformat()
        try:
            return datetime.fromtimestamp(int(epoch), tz=timezone.utc).isoformat()
        except (ValueError, TypeError, OSError):
            return datetime.now(timezone.utc).isoformat()

    # latest_summary from the task result or latest run
    latest_summary = task_data.get("latest_summary") or task.get("result")
    if not latest_summary:
        # Check runs for most recent summary
        runs = task_data.get("runs", [])
        for run in reversed(runs):
            if run.get("summary"):
                latest_summary = run["summary"]
                break

    # updated_at: use the most recent of completed_at, started_at, or now
    updated_at = completed_at or started_at or created_at
    updated_at_iso = epoch_to_iso(updated_at) if updated_at else datetime.now(timezone.utc).isoformat()

    return {
        "task_id": task_id,
        "board_slug": board_slug,
        "name": title[:2000],
        "status": notion_status,
        "assignee": assignee,
        "body": body[:50000],
        "parents": parents,
        "children": children,
        "created_at": epoch_to_iso(created_at),
        "updated_at": updated_at_iso,
        "latest_summary": (latest_summary[:1997] + "...") if latest_summary and len(latest_summary) > 2000 else latest_summary,
    }


def fire_upsert_async(payload: dict) -> None:
    """
    Fire ntn workers exec upsertTask in the background.
    Uses subprocess.Popen (non-blocking). Failures are caught by
    the drainer cron — we don't wait for completion here.
    """
    payload_json = json.dumps(payload, separators=(",", ":"))

    # Source env vars from the worker .env
    env = os.environ.copy()
    env_file = REPO_DIR / ".env"
    if env_file.exists():
        try:
            for line in env_file.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
        except Exception:
            pass

    # Set NOTION_KEYRING=0 to avoid keychain prompts
    env["NOTION_KEYRING"] = "0"
    env["NOTION_API_TOKEN"] = env.get("NOTION_API_TOKEN", "")

    # Build the wrapper command that logs success/failure and queues retries
    # We run a small Python snippet that:
    #   1. Runs ntn workers exec
    #   2. On failure or ok:false, appends to retry queue
    wrapper_script = f"""
import json, subprocess, sys
from pathlib import Path

payload = json.loads({json.dumps(payload_json)})
payload_str = json.dumps(payload, separators=(",", ":"))

try:
    r = subprocess.run(
        ["ntn", "workers", "exec", "upsertTask", "--local", "-d", payload_str],
        capture_output=True, text=True, timeout=15,
        cwd={json.dumps(str(REPO_DIR))},
    )
    if r.returncode != 0:
        error = f"ntn exit {{r.returncode}}: {{r.stderr[:300]}}"
        entry = {{"payload": payload, "error": error, "retries": 0, "queued_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()}}
        with open({json.dumps(str(RETRY_QUEUE))}, "a") as f:
            f.write(json.dumps(entry, separators=(",",":")) + "\\n")
        sys.exit(0)
    resp = json.loads(r.stdout)
    if not resp.get("ok"):
        error = f"upsert not ok: {{resp.get('error', 'unknown')}}"
        entry = {{"payload": payload, "error": error, "retries": 0, "queued_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()}}
        with open({json.dumps(str(RETRY_QUEUE))}, "a") as f:
            f.write(json.dumps(entry, separators=(",",":")) + "\\n")
except Exception as e:
    error = f"exception: {{e}}"
    entry = {{"payload": payload, "error": error, "retries": 0, "queued_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()}}
    with open({json.dumps(str(RETRY_QUEUE))}, "a") as f:
        f.write(json.dumps(entry, separators=(",",":")) + "\\n")
"""

    try:
        subprocess.Popen(
            [sys.executable, "-c", wrapper_script],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=str(REPO_DIR),
        )
        log(f"fired upsert async for {payload.get('task_id', '?')}")
    except Exception as e:
        log(f"Popen failed: {e}")
        enqueue_retry(payload, f"popen failed: {e}")


def extract_task_id_from_hook(data: dict) -> str | None:
    """Extract task_id from the shell hook payload.
    
    Shell hook stdin format:
    {
      "hook_event_name": "post_tool_call",
      "tool_name": "kanban_complete",
      "tool_input": {"task_id": "t_...", ...},  # only if explicitly passed
      "session_id": "...",
      "cwd": "...",
      "extra": {
        "result": '{"ok": true, "task_id": "t_..."}',  # JSON string of tool result
        "task_id": "<session_id>",  # NOT the kanban task_id!
        "tool_call_id": "...",
        "duration_ms": N,
      }
    }
    """
    tool_input = data.get("tool_input") or {}
    extra = data.get("extra") or {}

    # 1. Check tool_input.task_id (present when explicitly passed)
    task_id = tool_input.get("task_id")
    if task_id and task_id.startswith("t_"):
        return task_id

    # 2. Parse extra.result JSON string for task_id (most reliable for implicit calls)
    result_str = extra.get("result")
    if result_str and isinstance(result_str, str):
        try:
            result_data = json.loads(result_str)
            task_id = result_data.get("task_id")
            if task_id and task_id.startswith("t_"):
                return task_id
        except (json.JSONDecodeError, AttributeError):
            pass

    # 3. For kanban_create, the task_id is in the result, not input
    # Already handled by step 2 above.

    # 4. Check HERMES_KANBAN_TASK env var (set when running inside a kanban worker)
    task_id = os.environ.get("HERMES_KANBAN_TASK")
    if task_id and task_id.startswith("t_"):
        return task_id

    return None


def main():
    """
    Main entry point — read hook payload from stdin, fire upsert.
    Must complete in <1 sec.
    """
    start = time.monotonic()

    # Read stdin
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            # No input — print empty JSON and exit
            print("{}")
            return
        data = json.loads(raw)
    except Exception:
        print("{}")
        return

    tool_name = data.get("tool_name", "")

    # Only process kanban tool calls
    if tool_name not in SYNC_TOOL_NAMES:
        print("{}")
        return

    task_id = extract_task_id_from_hook(data)
    if not task_id:
        log(f"no task_id found in hook payload for {tool_name}")
        print("{}")
        return

    # Validate task_id format
    if not task_id.startswith("t_"):
        log(f"invalid task_id format: {task_id}")
        print("{}")
        return

    # Fetch full task data
    task_data = get_task_json(task_id)
    if not task_data:
        log(f"could not fetch task {task_id}")
        print("{}")
        return

    # Build upsert payload
    payload = build_upsert_payload(task_data, BOARD_SLUG)

    # Fire async (non-blocking)
    fire_upsert_async(payload)

    elapsed = time.monotonic() - start
    log(f"hook processed {tool_name} for {task_id} in {elapsed:.3f}s")

    # Return empty JSON (no blocking action)
    print("{}")


if __name__ == "__main__":
    main()
