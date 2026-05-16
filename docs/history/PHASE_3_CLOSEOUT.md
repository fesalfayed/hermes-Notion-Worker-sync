> **Historical:** This document captures an internal project phase. It is preserved for context but does not reflect current behavior. See [README](../../README.md) and [CHANGELOG](../../CHANGELOG.md) for current state.

# Phase 3 Closeout — 2026-05-16

> Cleanup + multi-board generalization. Three cards, all green.

## Scope shipped

| Card | Title | Outcome |
|---|---|---|
| **3.1** | Cosmetic relation cleanup | Archived `project` ↔ `Tasks 1` pair. Renamed `parent_project` → `project`. End state: single canonical pair `project` (Tasks) ↔ `kanban_tasks` (Projects). |
| **3.2** | Hook repurpose + drain delete | `kanban_to_notion.py` now triggers debounced (30s) `publish_gist()`. `drain_kanban_retry_queue.py` deleted. **Measured latency: 32.3s** (was ~16min). |
| **3.3** | Multi-board mapping | `board_channel_map.yaml` + loader + `--seed` CLI. Per-entry `required:` flag. `yaml@^2.9.0` dep. Back-compat for `hermes-projects-sync` verified. |

## Architecture deltas

### Tasks-delta latency: 16min → ~1.5min (~10x)

**Before:**
```
kanban write → wait for next 15-min cron tick → publish gist → wait for next 1-min tasksDelta → Notion row updated
worst case: ~16 min
```

**After:**
```
kanban write → hook fires → 30s debounce window → publish gist → next 1-min tasksDelta → Notion row updated
worst case: ~1.5 min
best case: ~32 s
```

The 30s debounce coalesces burst writes (e.g. a kanban fan-out emitting N `kanban_link` calls in 2s) into a single gist publish.

### Multi-board registry

`BOARD_TO_CHANNEL` hard-coded dict → `board_channel_map.yaml` at repo root, loaded via `src/boardChannelMap.ts`. Schema:

```yaml
boards:
  hermes-projects-sync:
    channel_id: "1504266202506199272"
    required: true
```

`required: true` per-entry — boot fails on 404 of a required channel, warns on optional. New `scripts/seed-board-map.ts` discovers kanban boards in the AGENTIC-OS guild and emits matched YAML to stdout for human commit (does NOT auto-write).

Unblocks: `notion-pmo`, `imsg-triage`, and any future kanban board with a matching Discord channel.

### Relation schema (final)

| DS | Property | Direction | Partner |
|---|---|---|---|
| Tasks | `project` (renamed from `parent_project`) | forward | `kanban_tasks` on Projects |
| Projects | `kanban_tasks` | back | `project` on Tasks |

Archived: `project` (old, on Tasks) + `Tasks 1` (on Projects). These were a synced pair from the rename iterations; archiving either half archived both.

## Infra fix shipped during phase

**operator_dev provider-routing patch** — three consecutive spawn-crashes (runs 62/63 + earlier 55/56/57) traced to anthropic-named models being routed to Gemini's v1beta endpoint. Root cause: profile `config.yaml` used flat `model: <name>` form, which falls back to a global default routing anthropic→gemini.

Fix: structured form in `~/.hermes/profiles/operator_dev/config.yaml`:
```yaml
model:
  default: claude-opus-4-6
  provider: anthropic
```

Saved as skill `hermes-profile-provider-routing-fix` so we don't re-debug this. Not committed to the repo (config lives outside).

## Spec deltas vs original plan

- **3.1 rename ban lifted** — discovery showed canonical properties were cross-paired with the duplicates. Single surgical rename (`parent_project` → `project`) was the cleanest path to the spec'd end state; Fesal approved.
- **3.3 YAML schema** — picked per-entry `required:` flag over a top-level `required_boards:` list. Self-documenting, simpler loader.
- **3.3 seed script** — standalone via `npx tsx scripts/seed-board-map.ts` since the project has no CLI framework.

## Verification artifacts

- `verification/T1_relations_pre.json` — pre-cleanup schema dump
- `verification/T1_relations_post.json` — post-cleanup schema dump (single canonical pair)
- `verification/T2_smoke_test.md` — measured 32.3s latency
- `verification/T3_backcompat.md` — hermes-projects-sync → `1504266202506199272` unchanged

## Open / deferred

- **`1.A` Architecture drift watch** — continuous card, by design. Not closing.
- **Tier B item 5** (notion-pmo Areas/Sprints wiring) — deferred to Phase 4 or later.
- **Tier C items 7-9** (webhook-driven sync, Custom Agent wiring, row-level drift digest) — deferred.

## Kanban board state at close

| Card | Status |
|---|---|
| `t_d5875960` 3.1 | ✅ done |
| `t_e2fccedb` 3.2 | ✅ done |
| `t_2efeccf7` 3.3 | ✅ done |
| `t_d122e562` 1.A drift watch | ◻ todo (continuous, by design) |
