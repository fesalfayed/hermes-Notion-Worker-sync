#!/usr/bin/env python3
"""
Shell hook: post_tool_call handler for kanban_* tools.

Fires after every kanban tool call (kanban_complete, kanban_block,
kanban_comment, kanban_create, kanban_heartbeat, kanban_link).

PRIMARY PATH (webhook):
  Reads the affected task from the local kanban SQLite DB, builds a
  webhook payload, signs it with HMAC-SHA256, and POSTs to the deployed
  Notion Workers webhook endpoint. This gives <5s kanban→Notion latency.

FALLBACK PATH (gist publish):
  On webhook failure (5xx, timeout, network error), falls back to the
  existing debounced gist-publish flow (30s window → 1min tasksDelta).
  This ensures no events are lost even if the webhook endpoint is down.

MUST exit within <5 sec — the hook runs inside the agent's tool loop.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# ── Paths ────────────────────────────────────────────────────────────
_home = Path(os.environ.get("REAL_HOME", str(Path.home())))
_real_home = Path("/Users/fesal")  # fallback for macOS
_kanban_sentinel = _home / ".hermes" / "kanban"
if not _kanban_sentinel.exists() and (_real_home / ".hermes" / "kanban").exists():
    _home = _real_home

REPO_DIR = _home / "hermes-projects-sync"
STATE_DIR = REPO_DIR / "local" / "state"
LOG_FILE = STATE_DIR / "kanban_to_notion_hook.log"
ENV_FILE = REPO_DIR / ".env"

# Debounce state file for fallback gist publish
DEBOUNCE_FILE = STATE_DIR / "publish_gist_debounce.json"
DEBOUNCE_WINDOW = 30

# The gist publisher script (fallback path)
PUBLISH_SCRIPT = _home / ".hermes" / "profiles" / "operator_dev" / "scripts" / "publish_kanban_gist.py"

# Kanban DB path
KANBAN_DB = _home / ".hermes" / "kanban" / "boards" / "hermes-projects-sync" / "kanban.db"

# Board slug for this project
BOARD_SLUG = "hermes-projects-sync"

# Ensure state directory exists
STATE_DIR.mkdir(parents=True, exist_ok=True)

# Retry queue for webhook failures
RETRY_QUEUE = STATE_DIR / "kanban_webhook_retry_queue.jsonl"

# Tool names that trigger sync
SYNC_TOOL_NAMES = {
    "kanban_complete",
    "kanban_block",
    "kanban_comment",
    "kanban_create",
    "kanban_heartbeat",
    "kanban_link",
}


def log(msg: str) -> None:
    """Append a timestamped line to the hook log."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    try:
        with open(LOG_FILE, "a") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def load_env() -> dict:
    """Load .env file into a dict (simple KEY=VALUE parser)."""
    env = {}
    try:
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip()
    except Exception:
        pass
    return env


def get_webhook_url() -> Optional[str]:
    """Read webhook URL from state file (set after first deploy)."""
    url_file = STATE_DIR / "kanban_webhook_url.txt"
    try:
        if url_file.exists():
            url = url_file.read_text().strip()
            if url.startswith("https://"):
                return url
    except Exception:
        pass
    return None


def get_webhook_secret() -> Optional[str]:
    """Read KANBAN_WEBHOOK_SECRET from .env."""
    env = load_env()
    return env.get("KANBAN_WEBHOOK_SECRET") or os.environ.get("KANBAN_WEBHOOK_SECRET")


def compute_hmac(secret: str, body: str) -> str:
    """Compute HMAC-SHA256 signature for the webhook payload."""
    mac = hmac.new(secret.encode(), body.encode(), hashlib.sha256)
    return f"sha256={mac.hexdigest()}"


def extract_task_id(data: dict) -> Optional[str]:
    """Extract the task_id from the hook payload."""
    # The hook payload contains tool_name and the tool's arguments/result.
    # For kanban tools, the task_id is typically in the arguments or result.
    args = data.get("arguments", {})
    result = data.get("result", {})

    # Direct task_id in args (kanban_show, kanban_complete, kanban_block, etc.)
    task_id = args.get("task_id")
    if task_id:
        return task_id

    # From environment variable (kanban_complete, kanban_block often use env default)
    env_task = os.environ.get("HERMES_KANBAN_TASK")
    if env_task:
        return env_task

    # From result (kanban_create returns the new task_id)
    if isinstance(result, dict):
        tid = result.get("task_id") or result.get("id")
        if tid:
            return tid

    return None


def read_task_from_db(task_id: str) -> Optional[dict]:
    """Read a single task from the kanban SQLite DB."""
    if not KANBAN_DB.exists():
        return None

    try:
        conn = sqlite3.connect(str(KANBAN_DB), timeout=2)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
        if not row:
            conn.close()
            return None

        task = dict(row)

        # Get parents
        parents = [
            r[0]
            for r in conn.execute(
                "SELECT parent_id FROM task_links WHERE child_id = ?",
                (task_id,),
            ).fetchall()
        ]

        # Get children
        children = [
            r[0]
            for r in conn.execute(
                "SELECT child_id FROM task_links WHERE parent_id = ?",
                (task_id,),
            ).fetchall()
        ]

        # Get latest run summary
        latest_summary = None
        try:
            run_row = conn.execute(
                "SELECT summary FROM task_runs WHERE task_id = ? AND summary IS NOT NULL "
                "ORDER BY ended_at DESC LIMIT 1",
                (task_id,),
            ).fetchone()
            if run_row:
                latest_summary = run_row[0]
        except Exception:
            pass

        conn.close()

        # Build GistTask-compatible payload
        created_at = datetime.fromtimestamp(
            task["created_at"], tz=timezone.utc
        ).isoformat()
        # Use max of all timestamp fields for updated_at
        ts_fields = [
            task.get("created_at", 0),
            task.get("started_at") or 0,
            task.get("completed_at") or 0,
            task.get("last_heartbeat_at") or 0,
        ]
        updated_at = datetime.fromtimestamp(
            max(ts_fields), tz=timezone.utc
        ).isoformat()

        return {
            "task_id": task["id"],
            "board_slug": BOARD_SLUG,
            "name": task.get("title", ""),
            "status": task.get("status", "todo"),
            "assignee": task.get("assignee"),
            "body": task.get("body", "") or "",
            "parents": parents,
            "children": children,
            "created_at": created_at,
            "updated_at": updated_at,
            "latest_summary": latest_summary,
        }
    except Exception as e:
        log(f"read_task_from_db error: {e}")
        return None


def post_webhook(url: str, secret: str, payload: dict) -> tuple[bool, str]:
    """
    POST a signed JSON payload to the webhook URL.
    Returns (success: bool, detail: str).
    """
    body = json.dumps(payload, separators=(",", ":"))
    signature = compute_hmac(secret, body)

    req = urllib.request.Request(
        url,
        data=body.encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Kanban-Signature-256": signature,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=4) as resp:
            status = resp.status
            if 200 <= status < 300:
                return True, f"HTTP {status}"
            else:
                return False, f"HTTP {status}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.reason}"
    except urllib.error.URLError as e:
        return False, f"URLError: {e.reason}"
    except Exception as e:
        return False, f"Exception: {e}"


def append_to_retry_queue(payload: dict, error: str) -> None:
    """Append a failed webhook payload to the retry queue."""
    entry = {
        "payload": payload,
        "error": error,
        "retries": 0,
        "queued_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        with open(RETRY_QUEUE, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception as e:
        log(f"append_to_retry_queue error: {e}")


# ── Fallback: debounced gist publish ─────────────────────────────────

def read_debounce_state() -> dict:
    """Read debounce state: {fire_at: epoch, pending: int, pid: int|null}."""
    try:
        if DEBOUNCE_FILE.exists():
            return json.loads(DEBOUNCE_FILE.read_text())
    except Exception:
        pass
    return {"fire_at": 0, "pending": 0, "pid": None}


def write_debounce_state(state: dict) -> None:
    """Write debounce state atomically."""
    tmp = DEBOUNCE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    tmp.rename(DEBOUNCE_FILE)


def is_process_alive(pid: Optional[int]) -> bool:
    """Check if a process is still running."""
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def schedule_publish(pending_count: int) -> None:
    """
    Schedule a debounced gist publish (fallback path).
    Spawn a background process that sleeps for DEBOUNCE_WINDOW seconds
    then runs the gist publisher.
    """
    state = read_debounce_state()

    if is_process_alive(state.get("pid")):
        state["pending"] = state.get("pending", 0) + 1
        state["fire_at"] = time.time() + DEBOUNCE_WINDOW
        write_debounce_state(state)
        log(f"fallback: debounced publish_gist scheduled (window=30s, pending={state['pending']})")
        return

    new_state = {
        "fire_at": time.time() + DEBOUNCE_WINDOW,
        "pending": pending_count,
        "pid": None,
    }

    runner_script = f"""
import time, subprocess, json, sys, os
from pathlib import Path

debounce_file = Path({json.dumps(str(DEBOUNCE_FILE))})
publish_script = Path({json.dumps(str(PUBLISH_SCRIPT))})
log_file = Path({json.dumps(str(LOG_FILE))})

def log(msg):
    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    try:
        with open(log_file, "a") as f:
            f.write(f"[{{ts}}] {{msg}}\\n")
    except Exception:
        pass

time.sleep({DEBOUNCE_WINDOW})

pending = 0
try:
    state = json.loads(debounce_file.read_text())
    pending = state.get("pending", 0)
except Exception:
    pass

try:
    debounce_file.write_text(json.dumps({{"fire_at": 0, "pending": 0, "pid": None}}))
except Exception:
    pass

log(f"fallback publish_gist firing (coalesced {{pending}} events)")
try:
    env = os.environ.copy()
    env["HOME"] = "/Users/fesal"
    r = subprocess.run(
        [sys.executable, str(publish_script)],
        capture_output=True, text=True, timeout=60,
        env=env,
    )
    if r.returncode == 0:
        log(f"fallback publish_gist completed OK (coalesced {{pending}} events)")
    else:
        log(f"fallback publish_gist FAILED rc={{r.returncode}}: stderr={{r.stderr[:2000]}} stdout={{r.stdout[:500]}}")
except subprocess.TimeoutExpired:
    log("fallback publish_gist TIMEOUT (60s)")
except Exception as e:
    log(f"fallback publish_gist exception: {{e}}")
"""

    try:
        proc = subprocess.Popen(
            [sys.executable, "-c", runner_script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        new_state["pid"] = proc.pid
        write_debounce_state(new_state)
        log(f"fallback: debounced publish_gist scheduled (window=30s, pending={pending_count})")
    except Exception as e:
        log(f"fallback: failed to spawn debounce runner: {e}")


# ── Main ─────────────────────────────────────────────────────────────

def main():
    """
    Main entry point — read hook payload from stdin, try webhook first,
    fall back to debounced gist publish on failure.
    Must complete in <5 sec.
    """
    start = time.monotonic()

    # Read stdin
    try:
        raw = sys.stdin.read()
        if not raw.strip():
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

    # Extract the affected task_id
    task_id = extract_task_id(data)
    if not task_id:
        log(f"hook: could not extract task_id from {tool_name}, falling back to gist publish")
        schedule_publish(pending_count=1)
        elapsed = time.monotonic() - start
        log(f"hook processed {tool_name} (no task_id, gist fallback) in {elapsed:.3f}s")
        print("{}")
        return

    # Try webhook path first
    webhook_url = get_webhook_url()
    webhook_secret = get_webhook_secret()

    if webhook_url and webhook_secret:
        # Read full task data from kanban DB
        task_data = read_task_from_db(task_id)
        if task_data:
            payload = {
                "event_type": "upsert",
                "kanban_id": task_id,
                "board_slug": BOARD_SLUG,
                "task_payload": task_data,
            }

            success, detail = post_webhook(webhook_url, webhook_secret, payload)

            if success:
                log(f"webhook: upsert {task_id} via {tool_name} -> {detail}")
                elapsed = time.monotonic() - start
                log(f"hook processed {tool_name} for {task_id} in {elapsed:.3f}s (webhook)")
                print("{}")
                return
            else:
                # Webhook failed — append to retry queue and fall through to gist
                log(f"webhook: FAILED upsert {task_id} -> {detail}, falling back to gist")
                append_to_retry_queue(payload, detail)
        else:
            log(f"webhook: could not read task {task_id} from DB, falling back to gist")
    else:
        if not webhook_url:
            log(f"webhook: no URL configured, using gist fallback for {task_id}")
        elif not webhook_secret:
            log(f"webhook: no secret configured, using gist fallback for {task_id}")

    # Fallback: debounced gist publish
    schedule_publish(pending_count=1)

    elapsed = time.monotonic() - start
    log(f"hook processed {tool_name} for {task_id} in {elapsed:.3f}s (gist fallback)")
    print("{}")


if __name__ == "__main__":
    main()
