#!/usr/bin/env python3
"""
drift_watchdog.py — Hermes Projects Sync health watchdog.

Checks:
  1. Tasks DB row count vs kanban DB (allow ±2 drift)
  2. DLQ file size (alert if > 0 entries)
  3. Gist freshness (alert if last-modified > 30min)

Runs every 15min via Hermes cron (no_agent=True).
Empty stdout = everything healthy (silent).
Non-empty stdout = alert (delivered via cron).
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────
_home = Path(os.environ.get("REAL_HOME", str(Path.home())))
if not (_home / ".hermes").exists() and Path("/Users/fesal/.hermes").exists():
    _home = Path("/Users/fesal")

REPO_DIR = _home / "hermes-projects-sync"
STATE_DIR = REPO_DIR / "local" / "state"
DLQ_FILE = STATE_DIR / "kanban_to_notion_dlq.jsonl"
RETRY_QUEUE = STATE_DIR / "kanban_to_notion_retry_queue.jsonl"

BOARD_SLUG = "hermes-projects-sync"
KANBAN_DB = _home / ".hermes" / "kanban" / "boards" / BOARD_SLUG / "kanban.db"
GIST_STATE = _home / ".hermes" / "profiles" / "orchestrator" / "cron" / "state" / "kanban_gist_id.txt"

# How stale (in minutes) the gist can be before we alert
GIST_STALE_THRESHOLD_MINUTES = 35  # 30 + 5 buffer for cron jitter

# How many tasks of drift we allow between kanban and gist snapshot
DRIFT_TOLERANCE = 2

# ── Environment ──────────────────────────────────────────────────────
GH_ENV = {**os.environ, "HOME": str(_home)}

# Load secrets from repo .env
env_file = REPO_DIR / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            GH_ENV[k.strip()] = v.strip()


def check_dlq() -> list[str]:
    """Check DLQ file for entries. Alert if > 0."""
    alerts = []
    if DLQ_FILE.exists():
        lines = [l for l in DLQ_FILE.read_text().splitlines() if l.strip()]
        if lines:
            alerts.append(f"⚠️ DLQ has {len(lines)} entries (should be 0)")
            # Show most recent entry
            try:
                latest = json.loads(lines[-1])
                task_id = latest.get("payload", {}).get("task_id", "?")
                error = latest.get("last_error", "?")[:100]
                alerts.append(f"  Latest: task={task_id} error={error}")
            except Exception:
                pass
    return alerts


def check_retry_queue() -> list[str]:
    """Check retry queue for stale entries."""
    alerts = []
    if RETRY_QUEUE.exists():
        lines = [l for l in RETRY_QUEUE.read_text().splitlines() if l.strip()]
        if len(lines) > 10:
            alerts.append(f"⚠️ Retry queue has {len(lines)} entries (growing)")
    return alerts


def check_gist_freshness() -> list[str]:
    """Check gist last-modified is within threshold."""
    alerts = []
    if not GIST_STATE.exists():
        alerts.append("⚠️ Gist state file not found — publisher may not have run yet")
        return alerts

    gist_id = GIST_STATE.read_text().strip()
    if not gist_id:
        alerts.append("⚠️ Gist state file is empty")
        return alerts

    try:
        r = subprocess.run(
            ["gh", "api", f"gists/{gist_id}", "-q", ".updated_at"],
            capture_output=True, text=True, timeout=15,
            env=GH_ENV,
        )
        if r.returncode != 0:
            alerts.append(f"⚠️ Cannot check gist freshness: gh api failed ({r.stderr[:100]})")
            return alerts

        updated_str = r.stdout.strip()
        if not updated_str:
            alerts.append("⚠️ Gist updated_at is empty")
            return alerts

        # Parse ISO timestamp
        # Handle formats like "2026-05-16T00:15:19Z"
        updated_at = datetime.fromisoformat(updated_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        age = now - updated_at
        age_minutes = age.total_seconds() / 60

        if age_minutes > GIST_STALE_THRESHOLD_MINUTES:
            alerts.append(
                f"⚠️ Gist is {age_minutes:.0f}min stale (threshold: {GIST_STALE_THRESHOLD_MINUTES}min)"
            )
            alerts.append(f"  Last updated: {updated_str}")
    except Exception as e:
        alerts.append(f"⚠️ Gist freshness check error: {e}")

    return alerts


def check_task_count_drift() -> list[str]:
    """Compare kanban DB task count with gist snapshot count."""
    alerts = []

    if not KANBAN_DB.exists():
        alerts.append("⚠️ Kanban DB not found")
        return alerts

    # Count tasks in kanban DB
    try:
        conn = sqlite3.connect(str(KANBAN_DB), timeout=5)
        kanban_count = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
        conn.close()
    except Exception as e:
        alerts.append(f"⚠️ Cannot read kanban DB: {e}")
        return alerts

    # Count tasks in gist snapshot
    gist_url = GH_ENV.get("KANBAN_GIST_URL", "")
    github_token = GH_ENV.get("GITHUB_TOKEN", "")

    if not gist_url or not github_token:
        alerts.append("⚠️ KANBAN_GIST_URL or GITHUB_TOKEN not set — cannot check drift")
        return alerts

    try:
        r = subprocess.run(
            ["curl", "-sf", "-H", f"Authorization: token {github_token}",
             "-H", "Accept: application/json", gist_url],
            capture_output=True, text=True, timeout=15,
        )
        if r.returncode != 0:
            alerts.append(f"⚠️ Cannot fetch gist: curl exit {r.returncode}")
            return alerts

        snapshot = json.loads(r.stdout)
        gist_count = len(snapshot.get("tasks", []))
    except Exception as e:
        alerts.append(f"⚠️ Gist fetch/parse error: {e}")
        return alerts

    drift = abs(kanban_count - gist_count)
    if drift > DRIFT_TOLERANCE:
        alerts.append(
            f"⚠️ Task count drift: kanban={kanban_count} gist={gist_count} (drift={drift}, tolerance=±{DRIFT_TOLERANCE})"
        )

    return alerts


def main():
    all_alerts = []

    all_alerts.extend(check_dlq())
    all_alerts.extend(check_retry_queue())
    all_alerts.extend(check_gist_freshness())
    all_alerts.extend(check_task_count_drift())

    if all_alerts:
        print("🔍 hermes-projects-sync drift watchdog:")
        for a in all_alerts:
            print(f"  {a}")
    # else: empty stdout = silent (healthy)


if __name__ == "__main__":
    main()
