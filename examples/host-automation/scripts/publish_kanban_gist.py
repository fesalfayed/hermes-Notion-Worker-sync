#!/usr/bin/env python3
"""
publish_kanban_gist.py — Publish ALL kanban boards as a unified snapshot
to a private GitHub gist.

Auto-discovers every kanban board at ~/.hermes/kanban/boards/*/kanban.db.
Each task in the snapshot is tagged with its board_slug so the Notion-side
sync can route `parent_project` relations per-board via Notion lookup
(no static YAML registry required).

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
import time
from datetime import datetime, timezone
from pathlib import Path

# ── PATH hardening (cron-safety) ───────────────────────────────────────
# Cron schedulers ship a stripped PATH that often omits /opt/homebrew/bin
# where `gh` (and other Homebrew CLIs) live. This causes subprocess.run(["gh", ...])
# to raise FileNotFoundError, silently bricking the pipeline. Prepend the
# common Homebrew + system locations unconditionally — harmless on Linux, fatal
# to omit on macOS cron. See: hermes-cron-script-paths skill.
for _p in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"):
    if _p not in os.environ.get("PATH", "").split(":"):
        os.environ["PATH"] = _p + ":" + os.environ.get("PATH", "")

# ── Configuration ──────────────────────────────────────────────────────
# Resolve against literal real HOME — Path.home() returns the agent-sandbox
# HOME under ~/.hermes/profiles/*/home/, which doesn't contain the kanban DBs.
#
# Override KANBAN_HOME if your kanban DBs live somewhere other than
# $HOME/.hermes/kanban. The default matches Hermes' standard layout.
REAL_HOME = Path(os.environ.get("REAL_HOME", os.path.expanduser("~")))
KANBAN_HOME = Path(os.environ.get("KANBAN_HOME", str(REAL_HOME / ".hermes")))
BOARDS_ROOT = KANBAN_HOME / "kanban" / "boards"
# State dir is per-profile under Hermes; for non-Hermes deployments set
# CRON_STATE_DIR to anywhere persistent and writable.
STATE_DIR = Path(os.environ.get(
    "CRON_STATE_DIR",
    str(REAL_HOME / ".hermes" / "profiles" / "orchestrator" / "cron" / "state"),
))
STATE_FILE = STATE_DIR / "kanban_gist_id.txt"
GIST_FILENAME = "kanban_snapshot.json"
GIST_DESC = "hermes kanban snapshot (multi-board)"

# Path to the hermes-projects-sync worker repo (used to find .env with the
# KANBAN_WEBHOOK_SECRET and the post-deploy webhook URL state file).
REPO_DIR = Path(os.environ.get(
    "HERMES_PROJECTS_SYNC_REPO",
    str(REAL_HOME / "hermes-projects-sync"),
))

# Boards that should NEVER be published to Notion (internal/legacy/scratch).
# To exclude a board, add its slug here. Empty by default — every board ships.
EXCLUDE_BOARDS = set(os.environ.get("KANBAN_EXCLUDE_BOARDS", "").split(",")) - {""}

# gh CLI needs the real HOME for keychain access
GH_ENV = {**os.environ, "HOME": str(REAL_HOME)}

# ── Status mapping ─────────────────────────────────────────────────────
# Kanban DB statuses → Notion tasks-DB select enum values.
# Notion schema accepts: todo, running, blocked, done, cancelled, archived
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


def discover_boards():
    """Find every kanban board directory with a kanban.db file."""
    if not BOARDS_ROOT.exists():
        print(f"ERROR: boards root not found at {BOARDS_ROOT}", file=sys.stderr)
        sys.exit(1)
    boards = []
    for board_dir in sorted(BOARDS_ROOT.iterdir()):
        if not board_dir.is_dir():
            continue
        slug = board_dir.name
        if slug in EXCLUDE_BOARDS:
            continue
        db_path = board_dir / "kanban.db"
        if db_path.exists():
            boards.append((slug, db_path))
    return boards


def read_board_db(slug: str, db_path: Path):
    """Read all tasks from a single kanban SQLite database."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    try:
        tasks_rows = conn.execute(
            "SELECT id, title, body, assignee, status, priority, created_at, "
            "started_at, completed_at, result FROM tasks"
        ).fetchall()

        # Parent-child links (graceful if table is missing on legacy boards)
        try:
            links = conn.execute(
                "SELECT parent_id, child_id FROM task_links"
            ).fetchall()
        except sqlite3.OperationalError:
            links = []

        parents_map, children_map = {}, {}
        for link in links:
            parents_map.setdefault(link["child_id"], []).append(link["parent_id"])
            children_map.setdefault(link["parent_id"], []).append(link["child_id"])

        # Latest completed-run summary per task
        try:
            summaries = conn.execute(
                "SELECT task_id, summary FROM task_runs "
                "WHERE outcome = 'completed' AND summary IS NOT NULL "
                "ORDER BY ended_at DESC"
            ).fetchall()
        except sqlite3.OperationalError:
            summaries = []
        summary_map = {}
        for row in summaries:
            summary_map.setdefault(row["task_id"], row["summary"])
    finally:
        conn.close()

    tasks = []
    for row in tasks_rows:
        task_id = row["id"]
        status = STATUS_MAP.get(row["status"], row["status"])

        created_at = (
            datetime.fromtimestamp(row["created_at"], tz=timezone.utc).isoformat()
            if row["created_at"]
            else datetime.now(timezone.utc).isoformat()
        )
        updated_epoch = row["completed_at"] or row["started_at"] or row["created_at"]
        updated_at = (
            datetime.fromtimestamp(updated_epoch, tz=timezone.utc).isoformat()
            if updated_epoch
            else created_at
        )

        tasks.append({
            "task_id": task_id,
            "board_slug": slug,
            "name": row["title"],
            "status": status,
            "assignee": row["assignee"],
            "body": row["body"] or "",
            "parents": parents_map.get(task_id, []),
            "children": children_map.get(task_id, []),
            "created_at": created_at,
            "updated_at": updated_at,
            "latest_summary": summary_map.get(task_id),
        })
    return tasks


def build_snapshot(boards, all_tasks):
    return {
        "version": 2,                              # bumped: multi-board format
        "boards": [slug for slug, _ in boards],    # list of slugs included
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "tasks": all_tasks,
    }


def gh_gist_create(json_path: str) -> str:
    result = subprocess.run(
        ["gh", "gist", "create", json_path, "--desc", GIST_DESC],
        capture_output=True, text=True, env=GH_ENV,
    )
    if result.returncode != 0:
        print(f"ERROR: gh gist create failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    gist_url = result.stdout.strip()
    return gist_url.rstrip("/").split("/")[-1]


def gh_gist_edit(gist_id: str, json_path: str):
    result = subprocess.run(
        ["gh", "gist", "edit", gist_id, "--add", json_path],
        capture_output=True, text=True, env=GH_ENV,
    )
    if result.returncode != 0:
        print(f"ERROR: gh gist edit failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)


def get_gist_raw_url(gist_id: str) -> str:
    result = subprocess.run(
        ["gh", "api", f"gists/{gist_id}",
         "-q", f'.files."{GIST_FILENAME}".raw_url'],
        capture_output=True, text=True, env=GH_ENV,
    )
    if result.returncode != 0:
        print(f"ERROR: gh api gists/{gist_id} failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()


def _push_to_notion_webhook(all_tasks):
    """
    Push tasks to the Notion worker webhook as a bulk_upsert.
    Only sends tasks whose updated_at has advanced since the last successful push
    (cursor stored in STATE_DIR/webhook_push_cursor.json).

    This closes the loop for tasks created OUTSIDE the in-agent tool hook
    (terminal `hermes kanban create`, scripts, cron-spawned agents, etc.),
    which is the failure mode that broke ambler-drive ingestion on 2026-05-18.

    Failures here are NON-FATAL — the gist remains the authoritative fallback,
    and a later cron tick will retry any unflushed deltas because we only
    advance the cursor on HTTP 2xx.
    """
    import hashlib
    import hmac
    import urllib.error
    import urllib.request

    # Read repo .env (KANBAN_WEBHOOK_SECRET) and state (webhook URL)
    env_file = REPO_DIR / ".env"
    url_file = REPO_DIR / "local" / "state" / "kanban_webhook_url.txt"
    cursor_file = STATE_DIR / "webhook_push_cursor.json"
    tombstone_cursor_file = STATE_DIR / "webhook_tombstone_cursor.json"

    if not env_file.exists() or not url_file.exists():
        print("INFO: webhook push skipped — repo .env or webhook URL missing",
              file=sys.stderr)
        return

    env = {}
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()
    secret = env.get("KANBAN_WEBHOOK_SECRET")
    webhook_url = url_file.read_text().strip()
    if not secret or not webhook_url.startswith("https://"):
        print("INFO: webhook push skipped — secret or URL invalid", file=sys.stderr)
        return

    # ── Helpers ────────────────────────────────────────────────────────
    def _sign_and_post(payload: dict) -> bool:
        body = json.dumps(payload, separators=(",", ":"))
        sig = "sha256=" + hmac.new(
            secret.encode(), body.encode(), hashlib.sha256
        ).hexdigest()
        req = urllib.request.Request(
            webhook_url,
            data=body.encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Kanban-Signature-256": sig,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                if 200 <= resp.status < 300:
                    return True
                print(f"WARN: webhook HTTP {resp.status} for {payload.get('event_type')} "
                      f"{payload.get('board_slug')}", file=sys.stderr)
                return False
        except urllib.error.HTTPError as e:
            print(f"WARN: webhook HTTP {e.code} for {payload.get('event_type')} "
                  f"{payload.get('board_slug')}: "
                  f"{e.read()[:200].decode(errors='replace')}", file=sys.stderr)
            return False
        except Exception as e:
            print(f"WARN: webhook POST failed: {e}", file=sys.stderr)
            return False

    # Read cursors
    cursor = {}
    if cursor_file.exists():
        try:
            cursor = json.loads(cursor_file.read_text())
        except Exception:
            cursor = {}
    tombstoned = set()
    if tombstone_cursor_file.exists():
        try:
            tombstoned = set(json.loads(tombstone_cursor_file.read_text()))
        except Exception:
            tombstoned = set()

    # ── Tombstone pass ─────────────────────────────────────────────────
    # Statuses that should be deleted from Notion (matches Notion-side status
    # enum — see STATUS_MAP). A task transitioning into one of these is no
    # longer something the user wants to see in the project view.
    TOMBSTONE_STATUSES = {"archived", "cancelled"}

    tombstone_targets = []
    new_tombstoned = set(tombstoned)
    for task in all_tasks:
        if task["status"] in TOMBSTONE_STATUSES and task["task_id"] not in tombstoned:
            tombstone_targets.append(task)

    tombs_sent = 0
    # Cap per-tick tombstones to keep a single cron run bounded (≤~30s of work
    # at 200ms throttle). Backlogs > cap drain over subsequent ticks.
    TOMBSTONE_CAP_PER_TICK = 100
    for task in tombstone_targets[:TOMBSTONE_CAP_PER_TICK]:
        payload = {
            "event_type": "tombstone",
            "kanban_id": task["task_id"],
            "board_slug": task["board_slug"],
        }
        if _sign_and_post(payload):
            new_tombstoned.add(task["task_id"])
            # Also remove from upsert cursor so a future un-archive correctly
            # re-emits as a new task (no false skip).
            cursor.pop(task["task_id"], None)
            tombs_sent += 1
            # Throttle: Notion worker's webhook endpoint rate-limits hard
            # past ~50 events in a burst. 200ms = 5 req/s sustained leaves
            # comfortable headroom; large backlogs (>100) drain across a few
            # cron ticks rather than 429-flooding. Next tick re-tries any 429s.
            time.sleep(0.2)

    if new_tombstoned != tombstoned:
        try:
            tmp = tombstone_cursor_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(sorted(new_tombstoned)))
            tmp.rename(tombstone_cursor_file)
        except Exception as e:
            print(f"WARN: failed to write tombstone cursor: {e}", file=sys.stderr)

    # ── Upsert pass ────────────────────────────────────────────────────
    # Detect tasks that need a push (new task OR updated_at advanced),
    # EXCLUDING tombstoned statuses (we don't push deleted rows).
    deltas_by_board = {}
    for task in all_tasks:
        if task["status"] in TOMBSTONE_STATUSES:
            continue
        tid = task["task_id"]
        prev = cursor.get(tid)
        if prev == task["updated_at"]:
            continue
        deltas_by_board.setdefault(task["board_slug"], []).append(task)

    if not deltas_by_board:
        if tombs_sent:
            print(f"webhook: pushed {tombs_sent} tombstone(s) to Notion worker",
                  file=sys.stderr)
        # Persist upsert cursor even if no upserts (tombstone pass may have popped entries)
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            tmp = cursor_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(cursor))
            tmp.rename(cursor_file)
        except Exception as e:
            print(f"WARN: failed to write webhook cursor: {e}", file=sys.stderr)
        return

    pushed = 0
    new_cursor = dict(cursor)
    for board_slug, tasks in deltas_by_board.items():
        # Chunk to keep HTTP bodies reasonable (worker accepts arrays)
        for i in range(0, len(tasks), 50):
            chunk = tasks[i:i + 50]
            payload = {
                "event_type": "bulk_upsert",
                "board_slug": board_slug,
                "tasks": chunk,
            }
            if _sign_and_post(payload):
                for t in chunk:
                    new_cursor[t["task_id"]] = t["updated_at"]
                pushed += len(chunk)

    # Persist cursor only for successfully-pushed deltas (others retry next tick)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = cursor_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(new_cursor))
        tmp.rename(cursor_file)
    except Exception as e:
        print(f"WARN: failed to write webhook cursor: {e}", file=sys.stderr)

    if pushed or tombs_sent:
        bits = []
        if pushed:
            bits.append(f"{pushed} upsert(s)")
        if tombs_sent:
            bits.append(f"{tombs_sent} tombstone(s)")
        print(f"webhook: pushed {', '.join(bits)} to Notion worker",
              file=sys.stderr)


def main():
    # 1. Discover & read every board
    boards = discover_boards()
    if not boards:
        print("ERROR: no kanban boards discovered", file=sys.stderr)
        sys.exit(1)

    all_tasks = []
    for slug, db_path in boards:
        all_tasks.extend(read_board_db(slug, db_path))

    # 2. Build unified snapshot
    snapshot = build_snapshot(boards, all_tasks)
    snapshot_json = json.dumps(snapshot, indent=2, ensure_ascii=False)

    # 3. Write to temp file with the exact gist filename
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", prefix="kanban_snapshot_", delete=False
    ) as f:
        tmp_path = f.name
        f.write(snapshot_json)
    final_tmp = os.path.join(os.path.dirname(tmp_path), GIST_FILENAME)
    os.rename(tmp_path, final_tmp)

    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)

        if STATE_FILE.exists() and STATE_FILE.read_text().strip():
            gist_id = STATE_FILE.read_text().strip()
            gh_gist_edit(gist_id, final_tmp)
            action = "edited"
        else:
            gist_id = gh_gist_create(final_tmp)
            STATE_FILE.write_text(gist_id)
            action = "created"

        # 4. PUSH deltas to Notion worker webhook (closes loop for tasks
        # created outside the in-agent tool hook — terminal, scripts, cron).
        # Non-fatal on failure; gist remains the authoritative fallback.
        try:
            _push_to_notion_webhook(all_tasks)
        except Exception as e:
            print(f"WARN: webhook push pass crashed: {e}", file=sys.stderr)

        if action == "created":
            print(f"Kanban gist created: {gist_id}")
            print(f"Raw URL: {get_gist_raw_url(gist_id)}")
            print(f"Boards: {len(boards)} | Tasks: {len(all_tasks)}")
        # edited: silent (cron no-agent: empty stdout = no notification)
    finally:
        if os.path.exists(final_tmp):
            os.unlink(final_tmp)


if __name__ == "__main__":
    main()
