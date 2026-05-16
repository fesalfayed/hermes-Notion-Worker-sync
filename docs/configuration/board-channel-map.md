# `board_channel_map.yaml`

The board ↔ Discord channel registry. Loaded at boot by [`src/boardChannelMap.ts`](../../src/boardChannelMap.ts) and exposed to the runtime as two lookup tables:

- `BOARD_TO_CHANNEL[board_slug] → discord_channel_id`
- `CHANNEL_TO_BOARD[discord_channel_id] → board_slug`

Used by:

- `projectsFromDiscord` — to auto-populate `kanban_board_slug` and derive `status` for known boards.
- `tasksBackfill` / `tasksDelta` / `kanbanEvent` (via `taskToChange` / `upsertTaskViaNotion`) — to resolve the `parent_project` relation.
- The boot-time validator in `src/index.ts` — to GET each channel against the Discord API.

## Schema

```yaml
boards:
  <board-slug>:
    channel_id: "<discord-channel-snowflake>"   # required
    required: true                                # optional, default false
```

### Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `boards` | map | yes | Top-level container. Empty map is rejected. |
| `boards.<slug>` | object | yes | Slug used by the kanban CLI and as the `board_slug` in tasks DB rows. |
| `boards.<slug>.channel_id` | string | yes | Discord channel snowflake. Entries without `channel_id` are skipped with a warning. |
| `boards.<slug>.required` | boolean | no | When `true`, the boot-time validator **fails the worker** if this channel id 404s or returns an unauthorized response from the Discord API. When `false` / absent, a failure only emits a warning. |

### Example

```yaml
boards:
  hermes-projects-sync:
    channel_id: "000000000000000014"
    required: true
  scratch-board:
    channel_id: "1500000000000000000"
    # no `required` flag → soft validation
```

## `required` flag semantics

Implemented by `validateBoardChannelMap` in [`src/boardChannelMap.ts`](../../src/boardChannelMap.ts):

- Every entry is hit with `GET /channels/{channel_id}` using `DISCORD_BOT_TOKEN`.
- Non-OK responses produce a `[board_channel_map] WARNING:` log.
- If **any** entry with `required: true` failed, the validator throws `FATAL: Required board-channel mappings failed validation: ...` and the worker process aborts.
- When `DISCORD_BOT_TOKEN` is unset (CI / build), validation is skipped entirely (warns).

Use `required: true` only for boards the worker cannot meaningfully run without. Optional bindings should stay loose so a single broken channel doesn't block deploys.

## Dual-path lookup (dist vs root)

YAML resolution order, computed once at module load (`DEFAULT_YAML_PATH`):

1. **`<dist>/board_channel_map.yaml`** — next to the compiled JS. This is the path the deployed worker uses. The build script copies the YAML into `dist/` during `npm run build`; without that copy, module init throws `ENOENT` inside the Workers sandbox.
2. **`<dist>/../board_channel_map.yaml`** — the repo root. Used by `tsx`-based local execution (`npm run check`, ad-hoc scripts) where there is no `dist/`.

Pass an explicit `yamlPath` to `loadBoardChannelMap()` / `loadRawConfig()` to override (tests use this).

## Adding a board

```bash
# 1. Edit the YAML
$EDITOR board_channel_map.yaml

# 2. Rebuild (re-copies the YAML into dist/)
npm run build

# 3. Deploy
ntn workers deploy

# 4. (Optional) Backfill the tasks DB now that parent_project can resolve
ntn workers exec tasksBackfill
```

## Discovering bindings

`scripts/seed-board-map.ts` can scaffold the YAML by enumerating channels in a guild. It reads `DISCORD_GUILD_ID` and `DISCORD_BOT_TOKEN` and writes YAML to stdout. Review before committing.

```bash
npx tsx scripts/seed-board-map.ts > board_channel_map.yaml.new
diff board_channel_map.yaml board_channel_map.yaml.new
```
