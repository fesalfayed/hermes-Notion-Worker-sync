> **Historical:** This document captures an internal project phase. It is preserved for context but does not reflect current behavior. See [README](../../README.md) and [CHANGELOG](../../CHANGELOG.md) for current state.

# hermes-projects-sync — Checkpoint (2026-05-15)

End-of-Phase-2 snapshot. Captures shipped architecture, what's deployed, and the open scope for Phase 3.

---

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Projects sync (Discord ↔ Notion managed DB, 4 tools) | ✅ Closed (2026-05-15) |
| 2 | Tasks sync via gist pipeline (backfill + delta pair) + drift watchdog | ✅ Closed (2026-05-15) |
| 3 | Cleanup + multi-board generalization | 🔵 Scoped, not started |

Phase 1 closeout journal: Discord thread `1504884437316407487`.
Phase 2 closeout journal: Discord thread `1505018157939818536`.

---

## Deployed architecture (post-Phase 2)

```
                   ┌─────────────────────────────┐
                   │   Discord (AGENTIC-OS)      │
                   │   PROJECTS / ARCHIVE cats   │
                   └──────────────┬──────────────┘
                                  │ poll 5m
                   ┌──────────────▼──────────────┐
                   │   projectsFromDiscord       │ ← replace, 5m
                   │   (Notion Worker sync)      │   writes: Name, topic,
                   └──────────────┬──────────────┘   category, archived,
                                  │                  status, last_edit
                   ┌──────────────▼──────────────┐
                   │  Notion: Hermes Projects DB │ DS 08a4c553...
                   │  (managed, 10 props)        │
                   └──────────────┬──────────────┘
                                  │ dual_property
                                  │   parent_project ↔ kanban_tasks
                   ┌──────────────▼──────────────┐
                   │  Notion: Hermes Tasks DB    │ DS c951d64c...
                   │  (managed, dual_property)   │
                   └──────────────▲──────────────┘
                                  │ upsert via tasksDelta + tasksBackfill
                                  │
                   ┌──────────────┴──────────────┐
                   │  Private GitHub Gist        │ 9dd38de637358d11...
                   │  kanban_snapshot.json       │ (15-min refresh)
                   └──────────────▲──────────────┘
                                  │ publish
                   ┌──────────────┴──────────────┐
                   │  publish_kanban_gist.py     │ ← operator_dev cron
                   │  (no_agent, */15 * * * *)   │
                   └──────────────▲──────────────┘
                                  │ read
                   ┌──────────────┴──────────────┐
                   │  kanban.db (hermes-         │
                   │   projects-sync board)      │
                   └─────────────────────────────┘
```

### Worker capabilities (Notion Workers SDK, `@notionhq/workers`)

**Syncs (3):**
- `projectsFromDiscord` — replace, schedule `"5m"`, writes Projects DB
- `tasksBackfill` — replace, manual trigger, reads gist → Tasks DB
- `tasksDelta` — incremental, schedule `"1m"`, reads gist → Tasks DB

**Tools (5):**
- `renameProjectChannel` — PATCH Discord channel name
- `archiveProject` — move channel PROJECTS → ARCHIVE
- `unarchiveProject` — move channel ARCHIVE → PROJECTS
- `rebindByChannelId` — sync Discord → Notion (Name, topic, cat, archived)
- `bindProjectToBoard` — populate `kanban_board_slug` + auto-relate tasks

**Databases:**
| Handle | DS ID | Used by |
|---|---|---|
| `projects` | `08a4c553-3df9-4b34-8943-97717ace176a` | projectsFromDiscord |
| `tasks` | `c951d64c-43bd-4904-a593-21d8c59db225` | tasksBackfill, tasksDelta |

### Local infrastructure (operator_dev profile)

| Cron | Schedule | Script | Status |
|---|---|---|---|
| `kanban-gist-publisher` | `*/15 * * * *` | `publish_kanban_gist.py` | ok |
| `hermes-sync-drift-watchdog` | `*/15 * * * *` | `drift_watchdog.py` | ok |
| `hermes-projects-sync-watcher` (orchestrator) | `*/5 * * * *` | `hermes_projects_sync_watcher.py` | ok |

**Deprecated (removed 2026-05-15):**
- `notion-pmo-event-sync` (`38c384c4c33b`) — old Python event-sync architecture
- `kanban-notion-drain` (`a7ba04e5b939`) — old `upsertTask` drain path

---

## Schema state

### Projects DB (DS `08a4c553-...`) — 10 properties

| Property | Type | Ownership |
|---|---|---|
| Name | title | Discord (sync writes) |
| discord_channel_id | rich_text | Discord (primary key, immutable) |
| discord_topic | rich_text | Discord (sync writes) |
| discord_category_id | rich_text | Discord (sync writes) |
| discord_archived | checkbox | Discord (derived from category) |
| last_discord_edit | date | Discord (sync writes) |
| kanban_board_slug | rich_text | Kanban + orchestrator-verified |
| kanban_task_ids | rich_text | Kanban + orchestrator-verified |
| status | select | Kanban-derived (archived→Cancelled, has-board→In progress, else→Backlog) |
| notes | rich_text | Notion-owned (sync skips) |

Back-relations (auto-created): `kanban_tasks`, `Tasks 1` → both point to tasks DS.

### Tasks DB (DS `c951d64c-...`)

| Property | Type | Notes |
|---|---|---|
| (Title) | title | Task name |
| status | select | Mirrors kanban status |
| project | relation | dual_property → projects DS (legacy) |
| parent_project | relation | dual_property → projects DS (canonical) |

**Known cosmetic debris:** duplicate forward/back relation pairs from rename iterations (Phase 2 worked through `project` → `parent_project`). Functionally fine. Phase 3 cleanup item.

---

## Verified ground truth (2026-05-15 21:25 UTC)

### Project rows
| Project | discord_channel_id | status | board_slug |
|---|---|---|---|
| notion-infra | 1504266202506199272 | **In progress** | hermes-projects-sync |
| saved-instagram-curator | 1504560480671498260 | Backlog | — |
| homerig-roboslav | 1504705726948446349 | Backlog | — |

### Sync queues
- DLQ: 0 entries (archived 16 to `_archive/dlq_pre_gist_20260515.jsonl`)
- Retry queue: 1 entry (archived 4 to `_archive/retry_queue_pre_gist_20260515.jsonl`)
- All archived entries were stale `upsertTask` errors from pre-2.5 architecture.

### Gist
- ID `9dd38de637358d118c771c018bba702d` (private)
- Last refresh: 2026-05-16 00:30:29 UTC

---

## Phase 3 scope (open)

### Tier A — finish Phase 2's debris
1. **Cosmetic relation cleanup.** Drop legacy `project` + `Tasks 1` properties; keep `parent_project` + `kanban_tasks` as canonical.
2. **Hook/drain dead-code removal.** `local/hooks/kanban_to_notion.py` + `local/scripts/drain_kanban_retry_queue.py` still call removed `upsertTask`. Either delete or repurpose to trigger gist publish on kanban event (latency: 16 min → ~1 min).
3. **`tasksDelta` delete handling.** Only backfill catches deletes today. Add tombstone emission so removed kanban tasks drop from Notion within the delta cycle.

### Tier B — new capability
4. **Multi-board mapping.** Generalize `BOARD_TO_CHANNEL` so any kanban board with a matching Discord channel auto-links. Unblocks `notion-pmo`, `imsg-triage`, future boards.
5. **Areas + Sprints sync.** Wire the remaining two `notion-pmo` DBs (Areas DS `20f2e89c-...`, Sprints DS `f76ea8ab-...`).
6. **Notion → kanban write-back.** Read `sync_dirty` checkbox; flow human edits back into kanban with conflict arbitration (kanban wins on status, Notion on description/due).

### Tier C — architectural
7. **Webhook-driven sync** — replace 15-min gist + 1-min delta with event-triggered push. Latency → seconds.
8. **Notion Custom Agent** — wire the 5 tools into Notion AI ("rename project X to Y").
9. **Drift watchdog → row-level diffs** — emit kanban-vs-Notion deltas to a digest channel instead of count summaries.

**Recommended Phase 3.0:** Tier A (1+2+3) — clean exit from Phase 2 debris.
**Recommended Phase 3.1:** Tier B item 4 (multi-board) — biggest unlock.

---

## Open risks / known issues

- **Duplicate forward/back relation pairs** on both DS (cosmetic). Tier A item 1.
- **Hook/drain scripts call removed tools** (silent no-op). Tier A item 2.
- **No tombstone path in `tasksDelta`** — deletes only propagate via backfill. Tier A item 3.
- **`BOARD_TO_CHANNEL` mapping is hardcoded single-board.** Tier B item 4.
- **OAuth doesn't persist in sandboxed agent HOME** — `ntn workers deploy` requires non-sandboxed terminal. Documented in `notion-pmo` skill (sandbox HOME pitfall); accepted constraint.

---

## File map

- `src/index.ts` — worker entry (3 syncs, 5 tools, 2 databases)
- `local/scripts/publish_kanban_gist.py` — gist publisher
- `local/scripts/drain_kanban_retry_queue.py` — deprecated drain (Tier A removal candidate)
- `local/hooks/kanban_to_notion.py` — deprecated hook (Tier A removal candidate)
- `verification/` — per-card evidence (1.0 through 2.6)
- `_archive/` — flushed pre-gist DLQ + retry queue snapshots
- `docs/CHECKPOINT.md` — this file

---

## Related skills

- `notion-pmo` — canonical PMO IDs, schema, ntn recipes
- `notion-workers-deployment` — `@notionhq/workers` deploy recipes
- `kanban-orchestrator` — decomposition + routing
- `infra-journal` — change-log discipline
