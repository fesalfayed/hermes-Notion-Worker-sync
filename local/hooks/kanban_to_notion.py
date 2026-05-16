#!/usr/bin/env python3
"""
Shell hook: post_tool_call handler for kanban_* tools.

Fires after every kanban tool call (kanban_complete, kanban_block,
kanban_comment, kanban_create, kanban_heartbeat, kanban_link).
Reads the hook JSON payload from stdin and triggers a debounced
publish_gist() invocation (30s window) to push the kanban snapshot
to GitHub gist — enabling ~1min Notion sync latency via tasksDelta.

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

# Debounce state file: stores epoch timestamp of when publish should fire
DEBOUNCE_FILE = STATE_DIR / "publish_gist_debounce.json"
# Debounce window in seconds
DEBOUNCE_WINDOW = 30

# The gist publisher script
PUBLISH_SCRIPT = _home / ".hermes" / "profiles" / "operator_dev" / "scripts" / "publish_kanban_gist.py"

# Ensure state directory exists
STATE_DIR.mkdir(parents=True, exist_ok=True)

# Tool names that trigger a gist publish
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
    Schedule a debounced gist publish.

    Strategy: spawn a background process that sleeps for DEBOUNCE_WINDOW
    seconds then runs the gist publisher. If a previous debounce process
    is still sleeping, we just update the pending count (the existing
    sleeper will pick up all coalesced changes).
    """
    state = read_debounce_state()

    # If there's already a live debounce process sleeping, just bump pending
    if is_process_alive(state.get("pid")):
        state["pending"] = state.get("pending", 0) + 1
        state["fire_at"] = time.time() + DEBOUNCE_WINDOW
        write_debounce_state(state)
        log(f"kanban_to_notion: debounced publish_gist scheduled (window=30s, pending={state['pending']})")
        return

    # No live debounce process — spawn one
    new_state = {
        "fire_at": time.time() + DEBOUNCE_WINDOW,
        "pending": pending_count,
        "pid": None,  # will be filled after Popen
    }

    # The debounce runner script: sleep, then exec the gist publisher
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

# Sleep for the debounce window
time.sleep({DEBOUNCE_WINDOW})

# Read final pending count for logging
pending = 0
try:
    state = json.loads(debounce_file.read_text())
    pending = state.get("pending", 0)
except Exception:
    pass

# Clear debounce state
try:
    debounce_file.write_text(json.dumps({{"fire_at": 0, "pending": 0, "pid": None}}))
except Exception:
    pass

# Run the gist publisher
log(f"publish_gist firing (coalesced {{pending}} events)")
try:
    env = os.environ.copy()
    env["HOME"] = "/Users/fesal"
    r = subprocess.run(
        [sys.executable, str(publish_script)],
        capture_output=True, text=True, timeout=60,
        env=env,
    )
    if r.returncode == 0:
        log(f"publish_gist completed OK (coalesced {{pending}} events)")
    else:
        log(f"publish_gist FAILED rc={{r.returncode}}: {{r.stderr[:300]}}")
except subprocess.TimeoutExpired:
    log("publish_gist TIMEOUT (60s)")
except Exception as e:
    log(f"publish_gist exception: {{e}}")
"""

    try:
        proc = subprocess.Popen(
            [sys.executable, "-c", runner_script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,  # detach from parent process group
        )
        new_state["pid"] = proc.pid
        write_debounce_state(new_state)
        log(f"kanban_to_notion: debounced publish_gist scheduled (window=30s, pending={pending_count})")
    except Exception as e:
        log(f"kanban_to_notion: failed to spawn debounce runner: {e}")


def main():
    """
    Main entry point — read hook payload from stdin, trigger debounced publish.
    Must complete in <1 sec.
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

    # Schedule debounced gist publish
    schedule_publish(pending_count=1)

    elapsed = time.monotonic() - start
    log(f"hook processed {tool_name} in {elapsed:.3f}s")

    # Return empty JSON (no blocking action)
    print("{}")


if __name__ == "__main__":
    main()
