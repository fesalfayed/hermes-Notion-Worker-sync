# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `docs/companion-automation.md` — documents the optional host-side cron scripts (`publish_kanban_gist.py`, `auto_create_kanban_boards.py`) that emit `tombstone`/`upsert` `kanbanEvent`s for tasks created outside the in-agent tool hook (terminal, scripts, cron) and auto-bind new Discord channels to `board_channel_map.yaml` with auto-deploy.
- Runtime additions to `board_channel_map.yaml` for `vta-rng`, `ambler-drive`, `saved-instagram-curator`, `homerig-roboslav` (auto-bound by `auto_create_kanban_boards.py` after the patch landed).

### Fixed
- **Silent kanban→Notion ingestion gap for non-`hermes-projects-sync` boards.** The Phase 4 worker only ingests via `kanbanEvent`, which was previously fired by an in-agent `post_tool_call` hook hardcoded to one board. Terminal-created tasks (e.g. `hermes kanban create` on `ambler-drive`) landed in the local SQLite DB and the published gist but never reached Notion. Fixed host-side by extending the 5-minute gist publisher to detect deltas via per-task `updated_at` cursor and POST `bulk_upsert` webhooks. Worker is unchanged; the existing `bulk_upsert` event type already supported this — it just had no caller for non-`hermes-projects-sync` boards.
- **Archived/cancelled tasks never tombstoned.** `hermes kanban archive` doesn't bump `updated_at`, so even a working delta detector can't see archived tasks. Same publisher now runs a tombstone pass — any task with `status ∈ {archived, cancelled}` not yet in `webhook_tombstone_cursor.json` gets a `tombstone` event POSTed (throttled 200 ms/req, capped 100/tick to avoid 429-flooding). 215 historical archived/cancelled rows drained on first deploy.
- **New project channels stayed at `Backlog` forever.** `projectsFromDiscord` only promotes a project row to `In progress` when the channel has a YAML binding, but `auto_create_kanban_boards.py` previously only created the kanban board, not the binding. Now also appends to `board_channel_map.yaml` (idempotent, preserves comments) and auto-runs `npm run build && ntn workers deploy && ntn workers sync trigger projectsFromDiscord` non-interactively using the OAuth token from `~/.config/notion/auth.json`. End-to-end: new channel → ≤5 min → kanban board + YAML binding + redeploy + Notion row `In progress`.

## [0.1.0] - 2026-05-17

### Added
- MIT LICENSE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG
- GitHub Actions CI workflow (lint + build on push/PR, node 22)
- Issue + PR templates and CODEOWNERS
- `docs/architecture.md`, `docs/development.md`, `docs/deployment.md`
- `docs/capabilities/{syncs,tools,webhooks}.md` — full per-capability reference
- `docs/configuration/{env,board-channel-map}.md`
- `scripts/onboard.sh` + `npm run onboard` for one-command bootstrap
- **Multi-board auto-discovery:** `resolveBoardChannelMap()` queries Notion `projects` DS at runtime for any board slug not in `board_channel_map.yaml`, caches per sync-run, removes the redeploy-per-board friction.
- **GistSnapshot v2** (`boards: string[]`) — multi-board snapshot format, backwards-compatible with v1.
- `buildTombstoneChanges()` iterates all boards in the snapshot (was: single board).

### Changed
- **Refactored `src/index.ts` (1,681 LOC monolith) into 19 per-capability modules** under `src/syncs/`, `src/tools/`, `src/webhooks/`, `src/lib/`. Behavior unchanged; capability keys preserved.
- Full README rewrite for public OSS release
- `.env.example` cleaned: one variable per line, no placeholder concatenations
- `scripts/seed-board-map.ts` no longer hardcodes a guild ID — reads `DISCORD_GUILD_ID` env var
- `src/constants.ts`: `GUILD_ID`, `PROJECTS_CATEGORY_ID`, `ARCHIVE_CATEGORY_ID` now env-driven (`DISCORD_GUILD_ID`, `DISCORD_PROJECTS_CATEGORY_ID`, `DISCORD_ARCHIVE_CATEGORY_ID`).
- Package renamed `@notionhq/workers-template` → `hermes-projects-sync@1.0.0`.
- Internal phase retrospectives moved to `docs/history/` (then gitignored entirely for OSS hygiene; preserved on disk).

### Fixed
- Restored `validateBoardChannelMap()` boot-time guard (previously imported but never invoked — silent regression)
- README documented 5 tools, code had 7 — now accurate (added `upsertTask`, `tombstoneTask`)
- README schema referenced legacy `parent_project` property — corrected to `project`
- README pointed at a personal absolute path for Notion API docs — replaced with developers.notion.com links
- **Tombstone upsert silent drop:** `buildTombstoneChanges` now writes `task_id` into `properties` (not only `key`) so the managed-DB SDK can bind to existing rows by primary key. Stuck `t_acceptance_test_43` flipped `todo → archived` in one cycle post-deploy.
- **Local hook schema mismatch:** `task_deps` → `task_links` in `local/hooks/kanban_to_notion.py` (kept on disk, gitignored).
- **Sandbox-HOME trap:** `local/scripts/publish_kanban_gist.py` now reads `REAL_HOME` env (default `/home/user`) instead of `Path.home()`.

### Removed
- `src/spike/discordPing.ts` (resolved feasibility spike, never imported)
- `verification/`, `docs/history/`, `.agents/`, `.claude/`, `.claudeignore`, `.codexignore`, `CLAUDE.md`, `docs/custom-tool.png` from tracking (internal artifacts).
- `local/` scripts removed from tracking (kept on disk, gitignored — operational tooling specific to the reference deployment).

## [0.0.4] - 2026-05-15

### Added
- `kanbanEvent` webhook with HMAC-SHA256 signature verification (`x-kanban-signature-256`, `KANBAN_WEBHOOK_SECRET`)
- Auto-disable after 5 consecutive webhook failures
- End-to-end Discord→Notion latency reduced to <10 s (was 1.5 min)

## [0.0.3] - 2026-04-30

### Changed
- Renamed schema property `parent_project` → `project`
- New canonical `kanban_tasks` database (replaces ad-hoc `Tasks 1`)
- Replaced retry-queue drain script with first-class delta sync
- Discord→Notion latency reduced from 16 min to 1.5 min

### Removed
- `local/scripts/drain_kanban_retry_queue.py` (superseded)

## [0.0.2] - 2026-04-15

### Added
- Backfill + delta sync pattern (`tasksBackfill` manual + `tasksDelta` scheduled)
- Pacer declarations for Discord and GitHub APIs

## [0.0.1] - 2026-04-01

### Added
- Initial `projectsFromDiscord` sync (Discord categories → Notion `projects` DB)
- `board_channel_map.yaml` registry and loader

[0.1.0]: https://github.com/fesalfayed/hermes-projects-sync/compare/v0.0.4...HEAD
[0.0.4]: https://github.com/fesalfayed/hermes-projects-sync/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/fesalfayed/hermes-projects-sync/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/fesalfayed/hermes-projects-sync/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/fesalfayed/hermes-projects-sync/releases/tag/v0.0.1
