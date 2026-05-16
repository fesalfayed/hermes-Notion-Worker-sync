#!/usr/bin/env python3
"""
test_drift_watchdog.py — Self-validation for drift_watchdog.py.

Injects synthetic drift of all 4 categories and validates the JSON output.
Also tests the zero-drift case.
"""

import json
import sys
import os
from pathlib import Path

# Add the scripts dir to path so we can import the modules
SCRIPTS_DIR = Path(__file__).parent.parent / "local" / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from drift_watchdog import compute_drift, count_aligned
from drift_digest import format_digest


def test_all_drift_categories():
    """Test that all 4 drift categories are detected."""
    print("=== Test: all drift categories ===")

    kanban_tasks = {
        "t_aaa": {"task_id": "t_aaa", "title": "Only in kanban", "status": "running", "assignee": "alice"},
        "t_bbb": {"task_id": "t_bbb", "title": "Title matches", "status": "done", "assignee": "bob"},
        "t_ccc": {"task_id": "t_ccc", "title": "Status mismatch", "status": "running", "assignee": "carol"},
    }

    notion_tasks = {
        "t_bbb": {
            "task_id": "t_bbb", "title": "Title matches", "status": "done", "assignee": "bob",
            "board_slug": "hermes-projects-sync", "notion_page_id": "np_bbb",
            "parent_project_ids": ["proj_1"],
        },
        "t_ccc": {
            "task_id": "t_ccc", "title": "Status mismatch", "status": "blocked", "assignee": "carol",
            "board_slug": "hermes-projects-sync", "notion_page_id": "np_ccc",
            "parent_project_ids": [],
        },
        "t_ddd": {
            "task_id": "t_ddd", "title": "Only in Notion (orphan)", "status": "todo", "assignee": "dan",
            "board_slug": "hermes-projects-sync", "notion_page_id": "np_ddd",
            "parent_project_ids": [],
        },
        "t_eee": {
            "task_id": "t_eee", "title": "Orphan relation task", "status": "running", "assignee": "eve",
            "board_slug": "hermes-projects-sync", "notion_page_id": "np_eee",
            "parent_project_ids": ["proj_wrong"],
        },
    }

    notion_projects = {
        "proj_1": {
            "page_id": "proj_1", "name": "Good Project", "kanban_board_slug": "hermes-projects-sync",
            "discord_channel_id": "123",
        },
        "proj_wrong": {
            "page_id": "proj_wrong", "name": "Wrong Board Project", "kanban_board_slug": "other-board",
            "discord_channel_id": "456",
        },
    }

    drift = compute_drift(kanban_tasks, notion_tasks, notion_projects)

    # 1. kanban_only should have t_aaa
    assert drift["kanban_only"], "Expected kanban_only to have items"
    assert drift["kanban_only"][0]["task_id"] == "t_aaa", f"Expected t_aaa, got {drift['kanban_only'][0]['task_id']}"
    print(f"  ✓ kanban_only: {len(drift['kanban_only'])} items (t_aaa)")

    # 2. notion_only should include t_ddd and t_eee (both active in Notion but not in kanban)
    assert drift["notion_only"], "Expected notion_only to have items"
    no_ids = {item["task_id"] for item in drift["notion_only"]}
    assert "t_ddd" in no_ids, f"Expected t_ddd in notion_only, got {no_ids}"
    assert "t_eee" in no_ids, f"Expected t_eee in notion_only, got {no_ids}"
    print(f"  ✓ notion_only: {len(drift['notion_only'])} items ({', '.join(sorted(no_ids))})")

    # 3. status_mismatch should have t_ccc
    assert drift["status_mismatch"], "Expected status_mismatch to have items"
    assert drift["status_mismatch"][0]["task_id"] == "t_ccc"
    assert "status" in drift["status_mismatch"][0]["diffs"]
    assert drift["status_mismatch"][0]["diffs"]["status"]["kanban"] == "running"
    assert drift["status_mismatch"][0]["diffs"]["status"]["notion"] == "blocked"
    print(f"  ✓ status_mismatch: {len(drift['status_mismatch'])} items (t_ccc: running→blocked)")

    # 4. orphan_relation should have t_eee → proj_wrong
    assert drift["orphan_relation"], "Expected orphan_relation to have items"
    assert drift["orphan_relation"][0]["task_id"] == "t_eee"
    assert drift["orphan_relation"][0]["project_board_slug"] == "other-board"
    print(f"  ✓ orphan_relation: {len(drift['orphan_relation'])} items (t_eee → Wrong Board Project)")

    # Count aligned
    tasks_aligned, projects_aligned = count_aligned(kanban_tasks, notion_tasks, notion_projects, drift)
    # t_bbb is the only common task with matching fields
    assert tasks_aligned == 1, f"Expected 1 aligned task (t_bbb), got {tasks_aligned}"
    # 2 projects total, 1 referenced in orphan_relation (proj_wrong)
    assert projects_aligned == 1, f"Expected 1 aligned project, got {projects_aligned}"
    print(f"  ✓ aligned: {tasks_aligned} tasks, {projects_aligned} projects")

    print("  PASS\n")
    return drift, tasks_aligned, projects_aligned


def test_digest_formatting(drift, tasks_aligned, projects_aligned):
    """Test the digest formatter produces correct output."""
    print("=== Test: digest formatting ===")

    data = {
        "counts": {
            "tasks_aligned": tasks_aligned,
            "projects_aligned": projects_aligned,
        },
        "drift": {
            "kanban_only": {"count": len(drift["kanban_only"]), "items": drift["kanban_only"]},
            "notion_only": {"count": len(drift["notion_only"]), "items": drift["notion_only"]},
            "status_mismatch": {"count": len(drift["status_mismatch"]), "items": drift["status_mismatch"]},
            "orphan_relation": {"count": len(drift["orphan_relation"]), "items": drift["orphan_relation"]},
        },
    }

    msg = format_digest(data)
    assert msg, "Expected non-empty digest message"
    assert "Drift Digest" in msg, "Missing header"
    assert "kanban_only: 1" in msg, "Missing kanban_only count"
    assert "notion_only: 2" in msg, "Missing notion_only count"
    assert "status_mismatch: 1" in msg, "Missing status_mismatch count"
    assert "orphan_relation: 1" in msg, "Missing orphan_relation count"
    assert "t_aaa" in msg, "Missing t_aaa in message"
    assert "t_ddd" in msg, "Missing t_ddd in message"
    assert "t_ccc" in msg, "Missing t_ccc in message"
    assert "t_eee" in msg, "Missing t_eee in message"
    assert "Wrong Board Project" in msg, "Missing project name in orphan_relation"
    print(f"  ✓ digest message looks correct ({len(msg)} chars)")
    print(f"  Preview:\n{msg}")
    print("  PASS\n")


def test_zero_drift():
    """Test that zero drift produces empty digest (silent-success)."""
    print("=== Test: zero drift (silent) ===")

    kanban_tasks = {
        "t_aaa": {"task_id": "t_aaa", "title": "Same", "status": "running", "assignee": "alice"},
    }
    notion_tasks = {
        "t_aaa": {
            "task_id": "t_aaa", "title": "Same", "status": "running", "assignee": "alice",
            "board_slug": "hermes-projects-sync", "notion_page_id": "np_aaa",
            "parent_project_ids": ["proj_1"],
        },
    }
    notion_projects = {
        "proj_1": {
            "page_id": "proj_1", "name": "Good", "kanban_board_slug": "hermes-projects-sync",
            "discord_channel_id": "123",
        },
    }

    drift = compute_drift(kanban_tasks, notion_tasks, notion_projects)
    total = sum(len(v) for v in drift.values())
    assert total == 0, f"Expected 0 drift items, got {total}"
    print(f"  ✓ all drift categories empty")

    data = {
        "counts": {"tasks_aligned": 1, "projects_aligned": 1},
        "drift": {
            "kanban_only": {"count": 0, "items": []},
            "notion_only": {"count": 0, "items": []},
            "status_mismatch": {"count": 0, "items": []},
            "orphan_relation": {"count": 0, "items": []},
        },
    }

    msg = format_digest(data)
    assert msg == "", f"Expected empty string for zero drift, got: {msg!r}"
    print(f"  ✓ digest is empty (silent-success)")
    print("  PASS\n")


def test_notion_only_excludes_archived():
    """Archived tasks in Notion should not appear in notion_only."""
    print("=== Test: notion_only excludes archived ===")

    kanban_tasks = {}  # kanban has no tasks (all gc'd)
    notion_tasks = {
        "t_old": {
            "task_id": "t_old", "title": "Archived task", "status": "archived", "assignee": "",
            "board_slug": "hermes-projects-sync", "notion_page_id": "np_old",
            "parent_project_ids": [],
        },
        "t_active": {
            "task_id": "t_active", "title": "Active orphan", "status": "running", "assignee": "alice",
            "board_slug": "hermes-projects-sync", "notion_page_id": "np_active",
            "parent_project_ids": [],
        },
    }
    notion_projects = {}

    drift = compute_drift(kanban_tasks, notion_tasks, notion_projects)
    # t_old (archived) should NOT appear; t_active should appear
    assert len(drift["notion_only"]) == 1, f"Expected 1 notion_only, got {len(drift['notion_only'])}"
    assert drift["notion_only"][0]["task_id"] == "t_active"
    print(f"  ✓ archived task excluded, active orphan detected")
    print("  PASS\n")


if __name__ == "__main__":
    drift, ta, pa = test_all_drift_categories()
    test_digest_formatting(drift, ta, pa)
    test_zero_drift()
    test_notion_only_excludes_archived()
    print("=" * 50)
    print("ALL TESTS PASSED ✓")
