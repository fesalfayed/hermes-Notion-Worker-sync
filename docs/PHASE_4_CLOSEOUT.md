# Phase 4 Closeout — 2026-05-16

> Custom Agent layer + event-driven push + drift digest. Five cards, all green.

## Scope shipped

| Card | Title | Outcome |
|---|---|---|
| **4.1** | Custom Agent layer | 7 tools (`upsertTask`, `tombstoneTask`, `renameProjectChannel`, `rebindByChannelId`, `archiveProject`, `unarchiveProject`, `bindProjectToBoard`) attached as a Notion Custom Agent. **Smoke test passed** — Notion AI prompt "rename project hermes-projects-sync to <X>, then revert" round-tripped cleanly. |
| **4.2** | tasksDelta delete handling | Tombstone now emits inside the sync cycle on row vanish, not only on backfill. Sync-path verified live (row `e32076b2-cb7e`). Tool path uses `pages.update({archived:true})` (managed-DB constraint). |
| **4.3** | Webhook-driven push | `worker.webhook(kanbanEvent)` replaces the 15m gist + 1m delta loop. **Measured: HTTP 202 + Notion row landed <10s** for both upsert and tombstone. HMAC verification via `x-kanban-signature-256: sha256=<hex>` header. |
| **4.4** | Drift watchdog → row-level diffs | Watchdog promoted from a count comparator to a 4-category row-level differ (kanban-only / notion-only / status-mismatch / orphan-relations) → `local/state/drift_latest.json`. Daily digest cron at `0 9 * * *` posts to `#daily-updates` (`000000000000000003`), silent-on-zero. |
| **4.5** | Phase-4 acceptance + closeout | Acceptance probes for all four capabilities passed. `kanban-gist-publisher` cron paused-not-deleted. Three new permanent skills shipped. |

## Architecture deltas

### Sync latency: ~1.5min → <10s (~9× over Phase 3, ~96× over Phase 2)

**Before (Phase 3):**
```
kanban write → 30s debounce → publish gist → wait for 1-min tasksDelta → Notion row
best ~32s · worst ~1.5min
```

**After (Phase 4):**
```
kanban write → POST kanbanEvent webhook → HMAC verify → upsert/tombstone via dataSources
end-to-end <10s, measured
```

The gist and tasksDelta paths remain wired but the cron that fed them (`kanban-gist-publisher` id `12ada971a84c`) is paused — kept around for the 7-day grace window before reaping, per stranded-artifacts rule. `tasksBackfill` is retained as a manual recovery path.

### Tombstone semantics — sync-path vs tool-path

Managed databases reject status-property writes from tool capabilities (`{ok:false, error:"property not writable from tool"}`). The two paths converge but use different mechanisms:

| Path | Mechanism | Result |
|---|---|---|
| Sync (`tasksDelta`) | `change.type = "delete"` → managed-DB sweep | `status=archived` on row |
| Tool (`tombstoneTask`) | `notion.pages.update({page_id, archived:true})` | Page archive flag set |

Both effectively hide the row. Documented in `notion-workers-tool-writes` skill.

### Custom Agent surface

Worker exposes 7 tools (was 5 in Phase 3). The Custom Agent — attached via Notion workspace settings → Custom Agents → bind worker `019e2a23-71c0-70e4-b04e-0e15659ba93a` — routes Notion AI prompts directly to tool calls. No CLI hop, no agent loop.

Example invocations that now work from the Notion AI panel:
- "Rename the hermes-projects-sync channel to projects-sync-test, then revert."
- "Archive the project bound to channel 000000000000000014."
- "Bind board hermes-projects-sync to its kanban_tasks relation on the projects DB."

### Drift digest

Watchdog writes `local/state/drift_latest.json`:

```json
{
  "checked_at": "<iso>",
  "categories": {
    "kanban_only":      [{"task_id": "...", "title": "..."}],
    "notion_only":      [{"page_id": "...", "task_id": "..."}],
    "status_mismatch":  [{"task_id": "...", "kanban": "done", "notion": "todo"}],
    "orphan_relations": [{"page_id": "...", "reason": "..."}]
  },
  "totals": {"kanban_only": N, "notion_only": N, "status_mismatch": N, "orphan_relations": N}
}
```

Digest cron formats and posts to `#daily-updates` only when any category is non-empty. Zero-drift days produce zero messages (filler-as-silence rule).

## Infra fixes shipped during phase

### API conventions migrated to Notion 2025-09-03

Server-side change required across the whole worker:

| Before | After |
|---|---|
| `Notion-Version: 2022-06-28` | `Notion-Version: 2025-09-03` |
| `notion.databases.query(databaseId, ...)` | `notion.dataSources.query(dataSourceId, ...)` |
| `POST /v1/databases/<db_id>/query` | `POST /v1/data_sources/<ds_id>/query` |
| Env: `NOTION_TASKS_DB_ID`, `NOTION_PROJECTS_DB_ID` | Env: `TASKS_DATABASE_ID`, `PROJECTS_DATABASE_ID` + `TASKS_DATA_SOURCE_ID`, `PROJECTS_DATA_SOURCE_ID` |

`NOTION_*` env prefix is reserved server-side and was being silently dropped at deploy. Renamed across `src/`, `.env`, `README.md`.

### YAML bundle fix (Option 2)

`board_channel_map.yaml` wasn't being shipped to the Notion runtime bundle, breaking `boardChannelMap.ts` at startup. Fix: `package.json` postbuild `cp` into `dist/`. Preserves Phase 3 config-driven design. Caught by Gate 1 of the new deploy-verification skill.

### Skills shipped

| Skill | Purpose |
|---|---|
| `notion-workers-deploy-verification-gates` (NEW) | Mandatory Gates 0–4 for any deploy-class card. Catches "HTTP 202 but no row" and similar runtime-only failures. |
| `macos-browser-oauth-autonomy-limits` (NEW) | Documents why autonomous OAuth/`ntn login` flows can't be completed by a background agent when Chrome has multiple profiles — and what the working alternatives are. |
| `hermes-projects-sync` (NEW) | Project-level skill: worker UUID, webhook URL, HMAC header gotcha, env conventions, decommissioned cron registry, verification gates xref. |
| `notion-workers-tool-writes` (patched) | Added the `pages.update({archived:true})` workaround for managed-DB tombstones. |
| `notion-workers-deployment` (patched) | Added the `NOTION_*` env-prefix reservation pitfall and Notion-Version 2025-09-03 migration note. |

## Spec deltas vs original plan

- **4.1 tool count: 5 → 7.** Original card said "wire the 5 tools". Phase 3 also added `upsertTask` and `tombstoneTask` to the tool surface; the Custom Agent attached all 7 as a unit. No scope reduction — strict superset.
- **4.3 gist cron: paused-not-deleted.** Original plan was decommission. Per Fesal's stranded-artifacts default, paused for 7d grace before reap to preserve a rollback path if a webhook regression surfaces.
- **4.5 owner switch.** Card was assigned to `operator_dev`; run #74 hit a managed-DB tool-write restriction during its own acceptance probe and exited rc=0 without calling `kanban_complete` (protocol violation, 2 consecutive crashes → gave_up). Orchestrator finished the card directly since most acceptance work had already been executed live in the originating Discord thread. Documented in the kanban_complete summary.

## Verification artifacts

Lifted from worker scratch into `verification/phase4/`:

- `verification/phase4/test_43_webhook.py` — initial webhook probe; revealed wrong header name
- `verification/phase4/test_43_webhook_v2.py` — corrected probe with `x-kanban-signature-256` header → HTTP 202 + row landed
- `verification/phase4/test_42_tombstone.py` — tombstone-via-webhook probe; row archived <10s
- `verification/phase4/test_webhook.py` — direct upsert probe
- `verification/phase4/query_notion.py` — REST-side row-existence checker (uses `notion.dataSources.query` with v2025-09-03 header)
- `verification/phase4/DEPLOY_RUNBOOK.md` — deploy steps captured during the deploy-verification-gates skill authoring

## Open / deferred

- **`1.A` Architecture drift watch** — continuous card, by design. Tagged `[clean]` on all four Phase-4 children against SoT (worker source, env, cron registry, board_channel_map).
- **Notion → kanban write-back** (Phase 4 Tier B leftover) — still deferred. Needs `sync_dirty` checkbox + conflict arbitration; not in this phase.
- **Wire remaining notion-pmo DBs** (Areas, Sprints) — still deferred.

## Kanban board state at close

| Card | Status |
|---|---|
| `t_9c9308bd` 4.1 Custom Agent | ✅ done |
| `t_4413ecdc` 4.2 Tombstone-in-delta | ✅ done |
| `t_ba6cbfc9` 4.3 Webhook | ✅ done |
| `t_462da0a9` 4.4 Drift digest | ✅ done |
| `t_31e2acdf` 4.5 Acceptance/closeout | ✅ done |
| `t_d122e562` 1.A drift watch | ◻ todo (continuous, by design) |

Board clean except for the continuous drift-watch card.
