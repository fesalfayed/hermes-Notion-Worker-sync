#!/usr/bin/env python3
"""
drift_digest.py — Daily drift digest formatter and poster for Discord.

Reads the latest drift JSON produced by drift_watchdog.py and posts
a compact Discord-friendly digest to the #daily-updates forum channel.

Rules:
  - If all four drift counts are zero: prints nothing (empty stdout = silent).
  - Otherwise: posts a forum thread in #daily-updates and prints confirmation.

Designed for no_agent=True Hermes cron execution.
Channel ID comes from DRIFT_DIGEST_CHANNEL_ID env var.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────
_home = Path(os.environ.get("REAL_HOME", str(Path.home())))
if not (_home / ".hermes").exists() and Path("/Users/fesal/.hermes").exists():
    _home = Path("/Users/fesal")

REPO_DIR = _home / "hermes-projects-sync"
STATE_DIR = REPO_DIR / "local" / "state"
DRIFT_JSON = STATE_DIR / "drift_latest.json"

# ── Environment ──────────────────────────────────────────────────────
ENV = {**os.environ, "HOME": str(_home)}
env_file = REPO_DIR / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            ENV[k.strip()] = v.strip()

# Discord channel ID for #daily-updates — env var, not hardcoded
CHANNEL_ID = ENV.get("DRIFT_DIGEST_CHANNEL_ID", "1503874454584037406")
DISCORD_TOKEN = ENV.get("DISCORD_BOT_TOKEN", "")

# Forum tag IDs from #daily-updates
TAG_DIGEST = "1503905750530134026"
TAG_ALERT = "1503905789578969189"


def format_digest(data: dict) -> str:
    """Format the drift JSON into a compact Discord message."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    counts = data.get("counts", {})
    drift = data.get("drift", {})

    ko = drift.get("kanban_only", {})
    no = drift.get("notion_only", {})
    sm = drift.get("status_mismatch", {})
    orel = drift.get("orphan_relation", {})

    total_drift = (
        ko.get("count", 0)
        + no.get("count", 0)
        + sm.get("count", 0)
        + orel.get("count", 0)
    )

    if total_drift == 0:
        return ""  # Silent success

    lines = [f"**Hermes-Projects-Sync Drift Digest — {today}**"]
    lines.append(
        f"✓ Clean: {counts.get('tasks_aligned', '?')} tasks aligned, "
        f"{counts.get('projects_aligned', '?')} projects aligned"
    )

    # kanban_only
    if ko.get("count", 0) > 0:
        lines.append(f"⚠ kanban_only: {ko['count']}")
        for item in ko.get("items", [])[:5]:
            tid = item.get("task_id", "?")
            title = item.get("title", "?")[:50]
            status = item.get("status", "?")
            lines.append(f"  • `{tid}` {title} [{status}]")

    # notion_only
    if no.get("count", 0) > 0:
        lines.append(f"⚠ notion_only: {no['count']}")
        for item in no.get("items", [])[:5]:
            tid = item.get("task_id", "?")
            title = item.get("title", "?")[:50]
            status = item.get("status", "?")
            lines.append(f"  • `{tid}` {title} [{status}]")

    # status_mismatch
    if sm.get("count", 0) > 0:
        lines.append(f"⚠ status_mismatch: {sm['count']}")
        for item in sm.get("items", [])[:5]:
            tid = item.get("task_id", "?")
            diffs = item.get("diffs", {})
            diff_parts = []
            for field, vals in diffs.items():
                diff_parts.append(
                    f"{field}: `{vals.get('kanban', '?')}` → `{vals.get('notion', '?')}`"
                )
            diff_str = ", ".join(diff_parts)
            lines.append(f"  • `{tid}` {diff_str}")

    # orphan_relation
    if orel.get("count", 0) > 0:
        lines.append(f"⚠ orphan_relation: {orel['count']}")
        for item in orel.get("items", [])[:5]:
            tid = item.get("task_id", "?")
            proj = item.get("project_name", "?")
            proj_slug = item.get("project_board_slug", "?")
            task_slug = item.get("task_board_slug", "?")
            lines.append(
                f"  • `{tid}` → project `{proj}` "
                f"(board: `{proj_slug}` ≠ `{task_slug}`)"
            )

    return "\n".join(lines)


def post_forum_thread(title: str, content: str) -> bool:
    """Post a new forum thread in #daily-updates."""
    if not DISCORD_TOKEN:
        print("⚠️ DISCORD_BOT_TOKEN not set — cannot post digest", file=sys.stderr)
        return False

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    body = json.dumps({
        "name": f"Drift Digest — {today}",
        "message": {
            "content": content,
        },
        "applied_tags": [TAG_DIGEST],
    })

    r = subprocess.run(
        [
            "curl", "-sf",
            "-X", "POST",
            f"https://discord.com/api/v10/channels/{CHANNEL_ID}/threads",
            "-H", f"Authorization: Bot {DISCORD_TOKEN}",
            "-H", "Content-Type: application/json",
            "-d", body,
        ],
        capture_output=True, text=True, timeout=15,
    )

    if r.returncode != 0:
        print(f"⚠️ Discord API error: {r.stderr[:200]}", file=sys.stderr)
        return False

    try:
        result = json.loads(r.stdout)
        thread_id = result.get("id", "?")
        return True
    except Exception:
        # curl -sf silently fails on HTTP errors
        print(f"⚠️ Discord response: {r.stdout[:200]}", file=sys.stderr)
        return False


def main():
    if not DRIFT_JSON.exists():
        # No watchdog output yet — be silent
        return

    try:
        data = json.loads(DRIFT_JSON.read_text())
    except (json.JSONDecodeError, OSError) as e:
        print(f"⚠️ Cannot read drift JSON: {e}", file=sys.stderr)
        sys.exit(1)

    msg = format_digest(data)
    if not msg:
        # Zero drift — silent success
        return

    # Post to Discord forum channel
    posted = post_forum_thread(f"Drift Digest", msg)
    if posted:
        # Print to stdout so cron knows we did something (optional confirmation)
        print(msg)
    else:
        # If Discord post failed, still print the message for cron delivery fallback
        print(msg)
        sys.exit(1)


if __name__ == "__main__":
    main()
