> **Historical:** Internal phase retrospective. See [README](../../README.md) and [CHANGELOG](../../CHANGELOG.md) for current state.

# Phase 5 Closeout — 2026-05-17

> OSS-ready public release + zero-config multi-board auto-discovery pipeline. Six commits shipped, one Notion-side ingestion issue carried forward.

## Scope shipped

| Commit | Headline | Outcome |
|---|---|---|
| `c03cced` | **Phase 5 build: OSS-ready public release** | LICENSE (MIT), CODE_OF_CONDUCT, CONTRIBUTING, SECURITY, CHANGELOG, GitHub Actions CI, issue/PR templates, CODEOWNERS, full README rewrite with badges + 3-minute Quickstart, `scripts/onboard.sh` interactive bootstrap, `src/index.ts` split 1,681 LOC → 19 per-capability modules under `src/{syncs,tools,webhooks,lib}/` + `databases.ts` + `pacers.ts` + `bindings.ts` + `constants.ts`, full docs (`architecture.md`, `deployment.md`, `development.md`, per-capability + per-config refs), Phase 1–4 closeouts relocated to `docs/history/`. |
| `b48a3cc` | **fix(local): unbreak webhook-driven Notion sync** | Two compounding bugs that stalled Notion for 2h26m. (a) hook schema mismatch — `task_deps` → `task_links` in `local/hooks/kanban_to_notion.py` (2 sites), stderr capture 300 → 2000 chars. (b) `local/scripts/publish_kanban_gist.py` `Path.home()` resolved to the agent-sandbox HOME; now reads `REAL_HOME` env (default `/Users/fesal`). Belt-and-braces: new `*/5min` `no_agent=true` cron `hermes-projects-sync-gist-publisher` republishes the gist regardless of hook health. |
| `009207e` | **fix(tombstone): include task_id in upsert payload** | `buildTombstoneChanges` emitted upserts with `task_id` in `key` only, omitting it from `properties`. For managed DBs with `primaryKeyProperty='task_id'`, the SDK binds upserts by reading the primary key out of `properties` — missing → silent drop every cycle. Symptom: `t_acceptance_test_43` stuck at `todo` for 2h26m despite a tombstone every run. Post-deploy: `todo → archived` in one cycle. |
| `87f07af` | **chore: OSS cleanup — internal artifacts, env-drive constants** | Removed `verification/`, `docs/history/`, `.agents/`, `.claude/`, `.claudeignore`, `.codexignore`, `CLAUDE.md`, `docs/custom-tool.png` from tracking. `src/constants.ts` no longer hardcodes IDs — `DISCORD_GUILD_ID`, `DISCORD_PROJECTS_CATEGORY_ID`, `DISCORD_ARCHIVE_CATEGORY_ID` env-driven. Package renamed `@notionhq/workers-template` → `hermes-projects-sync@1.0.0`. |
| `3ac0199` | **chore: remove local/ scripts and tests/ from tracking** | `local/` is operational tooling specific to this deployment — kept on disk but gitignored for OSS hygiene. |
| `04c962c` | **feat(multi-board): dynamic project→Notion auto-binding** | Zero-config kanban→Notion sync. New `resolveBoardChannelMap()` starts from the static YAML map, queries Notion `projects` DS for `Name == board_slug` for any unknown slug in the snapshot, caches per sync-run. `taskToChange()` takes the resolved map. `GistSnapshot` v2 (boards: string[]) shipped, backwards-compatible with v1. `buildTombstoneChanges()` iterates ALL boards in the snapshot. `tasksDelta` + `tasksBackfill` call the resolver once per cycle. Out-of-tree (operator-side): `publish_kanban_gist.py` refactored for v2 multi-board snapshots; new `auto_create_kanban_boards.py` `*/5min` cron creates a kanban board for each Discord PROJECTS channel that lacks one. |

## Architecture deltas

### From single-board hardcoded → multi-board auto-discovery

**Before (Phase 4):**
```
publish_kanban_gist.py: BOARD_SLUG = "hermes-projects-sync"  # hardcoded
board_channel_map.yaml: { hermes-projects-sync: <channel_id> }  # manual entry per board
src/lib/notionHelpers.ts: parent_project bound only from YAML map
```

**After (Phase 5):**
```
publish_kanban_gist.py: glob ~/.hermes/kanban/boards/*/kanban.db  → snapshot v2 multi-board
auto_create_kanban_boards.py (*/5min): Discord PROJECTS channels → kanban-board create
src/lib/notionHelpers.ts: resolveBoardChannelMap() runtime Notion query for unknown slugs
                          (YAML map becomes bootstrap/override; new boards work without redeploy)
```

End-state: create a Discord channel under PROJECTS → ~10 min later its kanban tasks appear in Notion. Zero manual deploy steps for new boards.

### Legacy reconciliation: `vitarange-revive` → `vta-rng`

Discord channel `vta-rng` (id `1505337506324021438`) existed but its kanban tasks lived on a mismatched-name board `vitarange-revive`. Migrated 12 tasks → `vta-rng`, archived old board. Going forward: **Discord channel name == kanban board slug** is the convention enforced by `auto_create_kanban_boards.py`. Documented as the architectural invariant.

### Repository surface

| Metric | Before | After |
|---|---|---|
| `src/index.ts` LOC | 1,681 (monolith) | 67 (orchestrator) |
| Per-capability modules | 0 | 19 |
| OSS contributor docs | none | LICENSE, CONTRIBUTING, SECURITY, CoC, CHANGELOG, CI, templates |
| README onboarding | manual env walkthrough | `npm run onboard` (~3 min, interactive) |
| Boards discoverable | 1 (hardcoded) | All under `~/.hermes/kanban/boards/*` (glob) |

## Infra fixes shipped during phase

| Fix | Captured as |
|---|---|
| Sandbox-HOME trap in cron `no_agent=true` scripts (`Path.home()` resolves to agent sandbox) | `hermes-worker-sandbox-paths` patched — added cron variant + `REAL_HOME` env pattern |
| Managed-DB upsert silently drops rows when primaryKey isn't in `properties` | NEW skill `notion-workers-managed-db-upsert-primary-key` |
| `discord.com` rejects `urllib` with default `User-Agent` (403 Cloudflare 1010) — needs `DiscordBot (...)` UA | Documented in `auto_create_kanban_boards.py` source + `infra-journal` recipe |
| AGENTIC-OS auto-create cron needs the operator-dev token (orchestrator's bot lives in OBLITERATOR guild) | Token stashed at `~/.hermes/secrets/agentic-os-bot-token` |

### Crons added / changed

| Cron id | Schedule | Purpose | State |
|---|---|---|---|
| `1fe8bb599f2e` `hermes-projects-sync-gist-publisher` | `*/5 * * * *` | Belt-and-braces: republish gist regardless of hook health. `no_agent=true`, silent-on-success. | active |
| `hermes-auto-create-kanban-boards` | `*/5 * * * *` | Discord PROJECTS channel → create kanban board if missing | active |
| `kanban-gist-publisher` (Phase 4 legacy, paused) | — | Pre-webhook 15m gist publisher | still paused (7d reap window expired but kept as fallback) |

## Spec deltas vs original plan

- **Phase 5 was originally scoped as OSS-only.** Mid-phase, the long-standing single-board hardcoding became blocking (vitarange-revive case) — Fesal approved expanding scope to include the full multi-board auto-discovery pipeline. Resulting commits split cleanly: `c03cced` (OSS) + `b48a3cc/009207e/87f07af/3ac0199/04c962c` (multi-board).
- **`claude -p` opus-4.6 used in place of `delegate_task`** for in-phase coding work to reduce token consumption.

## Open / deferred — carry to Phase 6

**🔴 Notion-side ingestion cap (HIGH priority):**

SDK accepts 566 upserts across 11 boards with `_tag:"success"`; Notion DS shows only ~25 rows landed (~12 per board where a project page exists). Pattern hypothesis: rows whose `parent_project` relation channel_id doesn't resolve to an existing Notion project page primary key may be silently dropped by the managed-DB platform layer. Worker run-log confirms full payload egress; investigation needs the Notion platform-side log.

**🟡 `projectsFromDiscord` 400 Bad Request:**

Started erroring after this round (separate regression from the auto-created channel set; unrelated to multi-board work). Likely the new `discord-archived: false` `Builder.checkbox` call now getting rejected. Triage in Phase 6 opening.

**Other deferred items (unchanged from Phase 4):**

- Notion → kanban write-back (sync_dirty checkbox + conflict arbitration)
- Wire remaining notion-pmo DBs (Areas, Sprints)
- `1.A` Architecture drift watch — continuous card, by design

## Verification artifacts

- Worker run log: `board-resolver: auto-bound notion-infra → 1504266202506199272, saved-instagram-curator → 1504560480671498260, vta-rng → 1505337506324021438` (proves runtime resolver working)
- Gist `9dd38de637358d118c771c018bba702d` — `kanban_snapshot.json` v2 multi-board: 566 tasks across 11 boards
- Backfill run emitted 566 upsert changes, SDK `_tag:"success"`
- `t_acceptance_test_43` `todo → archived` flip in 1 cycle post-tombstone-fix deploy

## Kanban board state at close

Board `hermes-projects-sync` is clean. All 27 tracked cards `done` except `t_d122e562` `1.A Architecture drift watch` — continuous by design.

## Pushed commits

```
c03cced  Phase 5 build: OSS-ready public release
b48a3cc  fix(local): unbreak webhook-driven Notion sync
009207e  fix(tombstone): include task_id in upsert payload — silent no-op for 2h26m
87f07af  chore: OSS cleanup — remove internal artifacts, env-drive constants
3ac0199  chore: remove local/ scripts and tests/ from tracking
04c962c  feat(multi-board): dynamic project→Notion auto-binding
```

All on `main`, GitHub `fesalfayed/hermes-projects-sync`.
