#!/usr/bin/env python3
"""
Drain the kanban→Notion retry queue + poll for missed events.

Two responsibilities:
1. RETRY DRAIN — read kanban_to_notion_retry_queue.jsonl line by line,
   re-exec upsertTask for each. On success, remove. On failure, increment
   retry counter. After 5 failures, move to DLQ and alert via Discord.

2. EVENT POLL — tail the task_events table in the kanban board DB for any
   events the shell hook may have missed (dispatcher claims, CLI edits,
   events from other boards). For each new event, fetch full task JSON and
   fire upsertTask.

Runs every 2 min via Hermes cron (no_agent=True).

Output to stdout is delivered verbatim by the cron system.
Empty stdout = silent (nothing to report).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import sqlite3
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# ── Paths ────────────────────────────────────────────────────────────
# Use REAL_HOME to handle sandboxed vs real execution contexts.
# In sandboxed Hermes workers, Path.home() resolves to
# ~/.hermes/profiles/<profile>/home/ instead of /Users/<user>.
_home = Path(os.environ.get("REAL_HOME", str(Path.home())))
_real_home = Path("/home/user")  # fallback for macOS
# Check if the kanban DB exists at _home; if not, use _real_home
_kanban_sentinel = _home / ".hermes" / "kanban"
if not _kanban_sentinel.exists() and (_real_home / ".hermes" / "kanban").exists():
    _home = _real_home

REPO_DIR = _home / "hermes-projects-sync"
STATE_DIR = REPO_DIR / "local" / "state"
RETRY_QUEUE = STATE_DIR / "kanban_to_notion_retry_queue.jsonl"
DLQ_FILE = STATE_DIR / "kanban_to_notion_dlq.jsonl"
CURSOR_FILE = STATE_DIR / "kanban_to_notion_cursor.txt"
LOG_FILE = STATE_DIR / "kanban_to_notion_drain.log"

BOARD_SLUG = "hermes-projects-sync"
KANBAN_DB = _home / ".hermes" / "kanban" / "boards" / BOARD_SLUG / "kanban.db"

MAX_RETRIES = 5

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

# ── Env setup ────────────────────────────────────────────────────────
STATE_DIR.mkdir(parents=True, exist_ok=True)


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    try:
        with open(LOG_FILE, "a") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def load_env() -> dict:
    """Load env vars from the worker .env file."""
    env = os.environ.copy()
    env_file = REPO_DIR / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    env["NOTION_KEYRING"] = "0"
    # Also source the hermes .env for any missing vars
    hermes_env = Path.home() / ".hermes" / ".env"
    if hermes_env.exists():
        for line in hermes_env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                if k.strip() not in env:
                    env[k.strip()] = v.strip()
    return env


def exec_upsert(payload: dict, env: dict) -> tuple[bool, str]:
    """
    Execute ntn workers exec upsertTask synchronously.
    Returns (success: bool, error_or_info: str).
    """
    payload_json = json.dumps(payload, separators=(",", ":"))
    try:
        r = subprocess.run(
            ["ntn", "workers", "exec", "upsertTask", "--local", "-d", payload_json],
            capture_output=True,
            text=True,
            timeout=15,
            cwd=str(REPO_DIR),
            env=env,
        )
        if r.returncode != 0:
            return False, f"ntn exit {r.returncode}: {r.stderr[:300]}"

        resp = json.loads(r.stdout)
        if not resp.get("ok"):
            return False, f"upsert not ok: {resp.get('error', 'unknown')}"

        action = resp.get("action", "?")
        page_id = resp.get("page_id", "?")
        return True, f"{action} page_id={page_id}"
    except subprocess.TimeoutExpired:
        return False, "timeout (15s)"
    except json.JSONDecodeError as e:
        return False, f"json decode error: {e}"
    except Exception as e:
        return False, f"exception: {e}"


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
            return None
        return json.loads(result.stdout)
    except Exception:
        return None


def build_upsert_payload(task_data: dict, board_slug: str) -> dict:
    """Convert hermes kanban show --json into upsertTask schema."""
    task = task_data.get("task", {})
    task_id = task.get("id", "")
    title = task.get("title", "")
    status = task.get("status", "todo")
    assignee = task.get("assignee")
    body = task.get("body", "")
    parents = task_data.get("parents", [])
    children = task_data.get("children", [])

    status_map = {
        "todo": "todo",
        "ready": "todo",
        "running": "running",
        "blocked": "blocked",
        "done": "done",
        "cancelled": "cancelled",
        "archived": "archived",
    }
    notion_status = status_map.get(status, "todo")

    def epoch_to_iso(epoch) -> str:
        if epoch is None:
            return datetime.now(timezone.utc).isoformat()
        try:
            return datetime.fromtimestamp(int(epoch), tz=timezone.utc).isoformat()
        except (ValueError, TypeError, OSError):
            return datetime.now(timezone.utc).isoformat()

    created_at = task.get("created_at")
    started_at = task.get("started_at")
    completed_at = task.get("completed_at")

    latest_summary = task_data.get("latest_summary") or task.get("result")
    if not latest_summary:
        runs = task_data.get("runs", [])
        for run in reversed(runs):
            if run.get("summary"):
                latest_summary = run["summary"]
                break

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


def read_cursor() -> int:
    """Read the last processed event ID from cursor file."""
    try:
        return int(CURSOR_FILE.read_text().strip())
    except Exception:
        return 0


def write_cursor(cursor: int) -> None:
    """Write the cursor atomically."""
    tmp = CURSOR_FILE.with_suffix(".tmp")
    tmp.write_text(str(cursor))
    tmp.rename(CURSOR_FILE)


def drain_retry_queue(env: dict) -> list[str]:
    """
    Process the retry queue. Returns list of status messages.
    """
    if not RETRY_QUEUE.exists():
        return []

    messages = []
    remaining = []
    dlq_entries = []

    try:
        lines = RETRY_QUEUE.read_text().splitlines()
    except Exception as e:
        log(f"failed to read retry queue: {e}")
        return [f"ERROR: failed to read retry queue: {e}"]

    for line in lines:
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            log(f"skipping malformed retry line: {line[:100]}")
            continue

        payload = entry.get("payload", {})
        retries = entry.get("retries", 0)
        task_id = payload.get("task_id", "?")

        # Truncate fields that may exceed Notion's 2000-char rich_text limit
        for field in ("latest_summary", "body"):
            val = payload.get(field)
            if val and len(val) > 2000:
                payload[field] = val[:1997] + "..."

        success, info = exec_upsert(payload, env)

        if success:
            messages.append(f"retry OK: {task_id} ({info})")
            log(f"retry success: {task_id} {info}")
        else:
            retries += 1
            if retries >= MAX_RETRIES:
                # Move to DLQ
                entry["retries"] = retries
                entry["dlq_at"] = datetime.now(timezone.utc).isoformat()
                entry["last_error"] = info
                dlq_entries.append(entry)
                messages.append(f"DLQ: {task_id} after {retries} retries: {info}")
                log(f"DLQ: {task_id} after {retries} retries: {info}")
            else:
                entry["retries"] = retries
                entry["last_error"] = info
                remaining.append(json.dumps(entry, separators=(",", ":")))
                log(f"retry {retries}/{MAX_RETRIES} for {task_id}: {info}")

    # Write back remaining entries
    try:
        if remaining:
            RETRY_QUEUE.write_text("\n".join(remaining) + "\n")
        else:
            RETRY_QUEUE.write_text("")
    except Exception as e:
        log(f"failed to write retry queue: {e}")

    # Append DLQ entries
    if dlq_entries:
        try:
            with open(DLQ_FILE, "a") as f:
                for entry in dlq_entries:
                    f.write(json.dumps(entry, separators=(",", ":")) + "\n")
        except Exception as e:
            log(f"failed to write DLQ: {e}")

    return messages


def poll_events(env: dict) -> list[str]:
    """
    Poll task_events for new events since last cursor.
    Returns list of status messages.
    """
    if not KANBAN_DB.exists():
        return ["WARNING: kanban DB not found"]

    cursor = read_cursor()
    messages = []

    try:
        conn = sqlite3.connect(str(KANBAN_DB), timeout=5)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT e.id, e.task_id, e.kind, e.payload, e.created_at "
            "FROM task_events e "
            "WHERE e.id > ? ORDER BY e.id ASC LIMIT 200",
            (cursor,),
        ).fetchall()
        conn.close()
    except Exception as e:
        log(f"DB query failed: {e}")
        return [f"ERROR: DB query failed: {e}"]

    # Deduplicate: only sync each task_id once per run
    tasks_to_sync = {}
    max_cursor = cursor

    for row in rows:
        event_id = int(row["id"])
        task_id = row["task_id"]
        kind = row["kind"]
        max_cursor = max(max_cursor, event_id)

        if kind in SYNC_EVENT_KINDS and task_id:
            tasks_to_sync[task_id] = kind  # last event kind wins

    for task_id, kind in tasks_to_sync.items():
        task_data = get_task_json(task_id)
        if not task_data:
            log(f"poll: could not fetch task {task_id} (event={kind})")
            continue

        payload = build_upsert_payload(task_data, BOARD_SLUG)
        success, info = exec_upsert(payload, env)

        if success:
            messages.append(f"poll OK: {task_id} ({kind}) -> {info}")
            log(f"poll success: {task_id} ({kind}) {info}")
        else:
            # Queue for retry
            entry = {
                "payload": payload,
                "error": info,
                "retries": 0,
                "queued_at": datetime.now(timezone.utc).isoformat(),
            }
            try:
                with open(RETRY_QUEUE, "a") as f:
                    f.write(json.dumps(entry, separators=(",", ":")) + "\n")
            except Exception:
                pass
            messages.append(f"poll FAIL (queued): {task_id} ({kind}): {info}")
            log(f"poll fail queued: {task_id} ({kind}) {info}")

    # Always advance cursor even if individual syncs failed
    # (they're in the retry queue now)
    if max_cursor > cursor:
        write_cursor(max_cursor)

    return messages


def alert_dlq_discord(dlq_entries: list[dict]) -> None:
    """
    Send DLQ alert to Discord infra-journal channel.
    Best-effort — if send_message isn't available, just log.
    """
    if not dlq_entries:
        return

    # Build alert message
    lines = ["⚠️ **Kanban→Notion DLQ alert**", ""]
    for entry in dlq_entries:
        task_id = entry.get("payload", {}).get("task_id", "?")
        error = entry.get("last_error", "?")
        retries = entry.get("retries", "?")
        lines.append(f"• `{task_id}`: {error} (retries={retries})")

    msg = "\n".join(lines)

    # Try hermes send_message CLI
    try:
        subprocess.run(
            [
                "hermes", "send",
                "--target", "discord:000000000000000006",
                "--message", msg[:1900],
            ],
            capture_output=True,
            timeout=10,
        )
        log(f"DLQ alert sent to Discord ({len(dlq_entries)} entries)")
    except Exception as e:
        log(f"DLQ Discord alert failed: {e}")


def main():
    start = time.monotonic()
    env = load_env()
    all_messages = []
    dlq_alerts = []

    # 1. Drain retry queue
    retry_msgs = drain_retry_queue(env)
    all_messages.extend(retry_msgs)

    # Check for DLQ entries that need alerting
    dlq_in_this_run = [m for m in retry_msgs if m.startswith("DLQ:")]
    # Read DLQ to get full entries for alerting
    if dlq_in_this_run:
        try:
            dlq_lines = DLQ_FILE.read_text().splitlines()
            # Get last N entries matching this run
            for line in dlq_lines[-len(dlq_in_this_run):]:
                try:
                    dlq_alerts.append(json.loads(line))
                except Exception:
                    pass
        except Exception:
            pass

    # 2. Poll for new events
    poll_msgs = poll_events(env)
    all_messages.extend(poll_msgs)

    # 3. Alert on DLQ entries
    if dlq_alerts:
        alert_dlq_discord(dlq_alerts)

    elapsed = time.monotonic() - start

    # Only print if there's something to report
    if all_messages:
        print(f"kanban→notion drain ({elapsed:.1f}s):")
        for m in all_messages:
            print(f"  {m}")
    # else: empty stdout = silent (cron sends nothing)


if __name__ == "__main__":
    main()
