# Development

## Prerequisites

- Node ≥ 20.
- The `ntn` CLI (`npm i -g @notionhq/cli` or use the project-local one via `npx ntn`).
- A `.env` populated from [`.env.example`](../.env.example). See [configuration/env.md](./configuration/env.md).

## Local loop

```bash
npm install
npm run check     # tsc --noEmit + lint
npm run build     # tsc → dist/, plus copies board_channel_map.yaml into dist/
```

`board_channel_map.yaml` must be present next to the compiled JS at runtime. The loader (`src/boardChannelMap.ts`) tries `dist/board_channel_map.yaml` first, then falls back to the repo root for `tsx`-based dev. The build script handles the copy; don't skip `npm run build` before deploying.

## Run a single capability

`ntn workers exec` invokes a capability against your local environment using the credentials in `.env`. Useful for iterating without redeploying:

```bash
# Syncs
ntn workers exec projectsFromDiscord
ntn workers exec tasksBackfill           # manual schedule; only runs on demand
ntn workers exec tasksDelta

# Tools — pass JSON input via --input
ntn workers exec renameProjectChannel --input '{"discord_channel_id":"123","new_name":"foo-bar"}'
ntn workers exec archiveProject       --input '{"discord_channel_id":"123"}'
ntn workers exec unarchiveProject     --input '{"discord_channel_id":"123"}'
ntn workers exec rebindByChannelId    --input '{"discord_channel_id":"123"}'
ntn workers exec bindProjectToBoard   --input '{"discord_channel_id":"123","board_slug":"my-board"}'
ntn workers exec upsertTask           --input '{"task_id":"t_abcd","name":"foo","board_slug":"my-board","status":"todo","assignee":null,"body":null,"parents":null,"children":null,"latest_summary":null}'
ntn workers exec tombstoneTask        --input '{"task_id":"t_abcd"}'
```

Webhooks cannot be invoked via `exec`. Trigger them with a signed `curl` (see [capabilities/webhooks.md](./capabilities/webhooks.md)) against the deployed worker URL.

## Adding a new capability

Each kind lives in its own subdirectory and exports a `register(worker)` function. Wire it into `src/index.ts`.

### Add a sync

1. Create `src/syncs/<name>.ts`. Use one of the existing files as a template.
2. Pick a mode: `replace` (full snapshot, mark-and-sweep) or `incremental` (delta + explicit tombstones).
3. Declare any new pacer in `src/pacers.ts`; share existing ones (`discordPacer`, `githubPacer`) when calling the same API.
4. Always `await pacer.wait()` before every external HTTP call.
5. Guard against empty upstream responses if the sync runs in `replace` mode — silent zero-result returns can wipe the DB.
6. Wire it into `src/index.ts` with `registerXxx(worker)`.

### Add a tool

1. Create `src/tools/<name>.ts`. Use `j` from `@notionhq/workers/schema-builder` for input/output schemas.
2. Tools receive `context.notion` pre-authenticated when invoked via a Custom Agent. For environments where it isn't, fall back to `process.env.NOTION_API_TOKEN`.
3. Return a typed object matching `outputSchema`; never throw to surface errors — return `{ ok: false, error: "..." }`.
4. Wire it into `src/index.ts`.

### Add a webhook

1. Create `src/webhooks/<name>.ts`.
2. Verify signatures with a helper in `src/lib/`. See `src/lib/hmac.ts` for the canonical HMAC-SHA256 pattern (constant-time compare).
3. Use `context.notion` for writes to managed databases — direct property writes from non-sync paths are rejected; tombstones must use `pages.update({ archived: true })`.
4. Wire it into `src/index.ts`.

### Add a board to the channel map

1. Edit `board_channel_map.yaml` (repo root). See [configuration/board-channel-map.md](./configuration/board-channel-map.md).
2. `npm run build` (copies the YAML into `dist/`).
3. `ntn workers deploy`.

## Troubleshooting

### `ntn` login keychain errors on macOS

The `ntn` CLI stores its session in the macOS keychain. When invoked from a sandboxed shell (some IDEs, Claude Code, sub-agents), the sandboxed `HOME` is rejected by the keychain. Symptoms: `Could not access keychain`, `SecKeychain*` errors, or hangs on `ntn login`.

Workaround: force the real home directory:

```bash
HOME=/Users/<you> ntn login
HOME=/Users/<you> ntn workers deploy
```

### `Cannot modify read-only property` from a tool

The target database is `type: "managed"`. Tools cannot set arbitrary properties via `context.notion` — only the platform-managed `archived` flag on the page is mutable. Use `pages.update({ archived: true })` for tombstones (see `tombstoneTaskViaNotion` in `src/lib/notionHelpers.ts`).

### `board_channel_map.yaml` ENOENT at boot

The build script didn't copy the YAML into `dist/`. Re-run `npm run build`, or check the `prebuild`/`postbuild` step.

### `FATAL: Required board-channel mappings failed validation`

A `required: true` entry in `board_channel_map.yaml` points at a Discord channel that 404s with the current `DISCORD_BOT_TOKEN`. Either fix the channel id, grant the bot access, or drop the `required` flag.

### Empty gist / `Gist fetch failed: 404`

`KANBAN_GIST_URL` is wrong or `GITHUB_TOKEN` lacks `gist` scope. The two `tasks*` syncs exit early with no changes when the snapshot is empty — they will *not* mass-delete.
