#!/usr/bin/env python3
"""
auto_create_kanban_boards.py — Watch Discord PROJECTS category and ensure
every project channel has a matching kanban board.

For each channel under category 000000000000000002 (AGENTIC-OS PROJECTS),
if ~/.hermes/kanban/boards/<channel-name>/ doesn't exist, create a kanban
board with slug = channel name. This makes "new Discord channel" the only
manual step required to onboard a project into the kanban→Notion pipeline.

Cron-safe: no_agent=true, silent on no-op, summary on board creation.
"""

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

# ── PATH hardening (cron-safety) ───────────────────────────────────────
# Cron schedulers ship a stripped PATH that often omits /opt/homebrew/bin
# where `ntn`, `npm`, `node`, `gh` live. Prepend defensively.
for _p in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"):
    if _p not in os.environ.get("PATH", "").split(":"):
        os.environ["PATH"] = _p + ":" + os.environ.get("PATH", "")

REAL_HOME = Path(os.environ.get("REAL_HOME", os.path.expanduser("~")))
KANBAN_HOME = Path(os.environ.get("KANBAN_HOME", str(REAL_HOME / ".hermes")))
BOARDS_ROOT = KANBAN_HOME / "kanban" / "boards"
# .env that holds the Discord bot token (DISCORD_BOT_TOKEN or
# AGENTIC_OS_DISCORD_BOT_TOKEN). Default points at Hermes' system .env.
ENV_FILE = Path(os.environ.get("HERMES_ENV_FILE", str(REAL_HOME / ".hermes" / ".env")))
# Repo containing board_channel_map.yaml + .env + the worker source.
REPO_DIR = Path(os.environ.get(
    "HERMES_PROJECTS_SYNC_REPO",
    str(REAL_HOME / "hermes-projects-sync"),
))
YAML_FILE = REPO_DIR / "board_channel_map.yaml"
NOTION_AUTH_FILE = Path(os.environ.get(
    "NOTION_AUTH_FILE", str(REAL_HOME / ".config" / "notion" / "auth.json"),
))
NOTION_WORKSPACE_ID = os.environ.get("NOTION_WORKSPACE_ID", "")

# REQUIRED env vars (no sensible defaults — must be set per deployment):
GUILD_ID = os.environ.get("DISCORD_GUILD_ID", "")
PROJECTS_CATEGORY = os.environ.get("DISCORD_PROJECTS_CATEGORY_ID", "")
ARCHIVE_CATEGORY = os.environ.get("DISCORD_ARCHIVE_CATEGORY_ID", "")


def load_env_var(key: str):
    """Read a single env var from the user's real ~/.hermes/.env."""
    if key in os.environ:
        return os.environ[key]
    if not ENV_FILE.exists():
        return None
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith(f"{key}="):
            v = line.split("=", 1)[1].split()[0]
            return v.strip().strip('"').strip("'")
    return None


def get_agentic_os_token():
    """The token that has access to AGENTIC-OS guild.

    DISCORD_BOT_TOKEN in ~/.hermes/.env is the OBLITERATOR bot (different guild).
    operator-dev's bot token has full AGENTIC-OS access — pushed to workers env
    and mirrored to ~/.hermes/.env as AGENTIC_OS_DISCORD_BOT_TOKEN.
    """
    return (
        load_env_var("AGENTIC_OS_DISCORD_BOT_TOKEN")
        or load_env_var("DISCORD_BOT_TOKEN")
    )


def fetch_project_channels(token: str):
    """GET /guilds/<id>/channels, filter to PROJECTS category children."""
    req = urllib.request.Request(
        f"https://discord.com/api/v10/guilds/{GUILD_ID}/channels",
        headers={
            "Authorization": f"Bot {token}",
            "Content-Type": "application/json",
            # Discord rejects requests with no UA — urllib default "Python-urllib/3.x"
            # gets blanket-403'd. A descriptive UA per Discord's API guidelines is fine.
            "User-Agent": "hermes-auto-board-create (https://github.com/fesalfayed/hermes-projects-sync, 1.0)",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        channels = json.loads(r.read())
    return [c for c in channels if c.get("parent_id") == PROJECTS_CATEGORY]


def create_board(slug: str, name: str):
    """Run `hermes kanban boards create <slug>` in the user's real HOME."""
    env = {**os.environ, "HOME": str(REAL_HOME)}
    result = subprocess.run(
        ["hermes", "kanban", "boards", "create", slug, "--name", name],
        capture_output=True, text=True, env=env, timeout=30,
    )
    return result.returncode == 0, (result.stderr or result.stdout).strip()[:200]


def update_yaml_bindings(channels_to_bind):
    """
    Append new (slug → channel_id) entries to board_channel_map.yaml.
    `channels_to_bind` is a list of dicts {slug, channel_id}.
    Returns the list of slugs actually appended (idempotent — skips already-present).

    Simple line-append rather than full YAML rewrite so existing comments,
    ordering, and `required: true` flags are preserved.
    """
    if not YAML_FILE.exists():
        print(f"WARN: {YAML_FILE} missing — skipping YAML binding update",
              file=sys.stderr)
        return []

    existing_text = YAML_FILE.read_text()
    appended = []
    new_lines = []
    for entry in channels_to_bind:
        slug = entry["slug"]
        channel_id = entry["channel_id"]
        # Idempotency: skip if already present (by slug as a YAML key OR by
        # channel_id elsewhere in file)
        if f"\n  {slug}:" in existing_text or f'"{channel_id}"' in existing_text:
            continue
        new_lines.append(
            f"  {slug}:\n"
            f"    channel_id: \"{channel_id}\"\n"
            f"    required: false\n"
        )
        appended.append(slug)

    if not new_lines:
        return []

    # Ensure trailing newline before append
    text = existing_text
    if not text.endswith("\n"):
        text += "\n"
    text += "".join(new_lines)
    YAML_FILE.write_text(text)
    return appended


def deploy_worker():
    """
    Build + deploy hermes-projects-sync worker non-interactively.

    Uses the OAuth token from ~/.config/notion/auth.json (written by
    `ntn login` — survives across sessions). This is the documented
    pattern in the notion-pmo skill for unattended deploys.

    Returns (ok: bool, msg: str).
    """
    if not NOTION_AUTH_FILE.exists():
        return False, f"no auth file at {NOTION_AUTH_FILE} — run `ntn login`"
    try:
        auth = json.loads(NOTION_AUTH_FILE.read_text())
        token = auth.get(NOTION_WORKSPACE_ID)
    except Exception as e:
        return False, f"failed to read {NOTION_AUTH_FILE}: {e}"
    if not token:
        return False, f"no token for workspace {NOTION_WORKSPACE_ID} in auth.json"

    env = {
        **os.environ,
        "HOME": str(REAL_HOME),
        "NOTION_API_TOKEN": token,
        "NOTION_WORKSPACE_ID": NOTION_WORKSPACE_ID,
    }

    build = subprocess.run(
        ["npm", "run", "build"],
        capture_output=True, text=True, env=env, cwd=str(REPO_DIR), timeout=180,
    )
    if build.returncode != 0:
        return False, f"npm run build failed: {build.stderr[-500:]}"

    deploy = subprocess.run(
        ["ntn", "workers", "deploy"],
        capture_output=True, text=True, env=env, cwd=str(REPO_DIR), timeout=300,
    )
    if deploy.returncode != 0:
        return False, f"ntn workers deploy failed: {deploy.stderr[-500:]}"

    # Trigger projectsFromDiscord so the new status flips immediately
    # (otherwise waits up to 5 min for the next sync cycle).
    subprocess.run(
        ["ntn", "workers", "sync", "trigger", "projectsFromDiscord"],
        capture_output=True, text=True, env=env, cwd=str(REPO_DIR), timeout=30,
    )

    return True, "deployed and triggered projectsFromDiscord"


def main():
    # Required-env preflight (these have no sensible defaults — must be set):
    missing = [k for k, v in [
        ("DISCORD_GUILD_ID", GUILD_ID),
        ("DISCORD_PROJECTS_CATEGORY_ID", PROJECTS_CATEGORY),
        ("DISCORD_ARCHIVE_CATEGORY_ID", ARCHIVE_CATEGORY),
    ] if not v]
    if missing:
        print(f"ERROR: missing required env vars: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    token = get_agentic_os_token()
    if not token:
        print("ERROR: AGENTIC_OS_DISCORD_BOT_TOKEN not found in env or ~/.hermes/.env",
              file=sys.stderr)
        sys.exit(1)

    try:
        channels = fetch_project_channels(token)
    except Exception as e:
        print(f"ERROR: Discord fetch failed: {e}", file=sys.stderr)
        sys.exit(1)

    BOARDS_ROOT.mkdir(parents=True, exist_ok=True)
    existing = {p.name for p in BOARDS_ROOT.iterdir() if p.is_dir()}

    # Step 1: create kanban boards for any channels that lack one
    created = []
    for ch in channels:
        slug = ch["name"]
        if slug in existing:
            continue
        ok, msg = create_board(slug, slug)
        if ok:
            created.append({"slug": slug, "channel_id": ch["id"]})
        else:
            print(f"WARN: failed to create board {slug}: {msg}", file=sys.stderr)

    # Step 2: ensure EVERY project channel has a YAML binding (not just newly
    # created ones — also catches boards created by hand that were never bound).
    # The YAML binding is what makes projectsFromDiscord promote status from
    # Backlog → In progress; without it, projects sit at Backlog forever.
    all_bindings = [{"slug": ch["name"], "channel_id": ch["id"]} for ch in channels]
    appended_slugs = update_yaml_bindings(all_bindings)

    # Step 3: redeploy worker if YAML changed (else next sync uses stale dist)
    deploy_msg = None
    if appended_slugs:
        ok, deploy_msg = deploy_worker()
        if not ok:
            print(f"WARN: auto-deploy failed: {deploy_msg}", file=sys.stderr)

    # Silent on no-op (cron no_agent contract); otherwise summarize
    if created or appended_slugs:
        lines = []
        if created:
            lines.append(f"Created {len(created)} kanban board(s) for new Discord projects:")
            for c in created:
                lines.append(f"  • {c['slug']}")
        if appended_slugs:
            lines.append(f"Auto-bound {len(appended_slugs)} channel(s) in board_channel_map.yaml:")
            for slug in appended_slugs:
                lines.append(f"  • {slug}")
        if deploy_msg:
            lines.append(f"Worker auto-deploy: {deploy_msg}")
        print("\n".join(lines))


if __name__ == "__main__":
    main()
