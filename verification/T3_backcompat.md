# T3 Back-Compat Verification

## Summary

Verified that the config-driven `board_channel_map.yaml` produces identical
routing to the previous hard-coded `BOARD_TO_CHANNEL` dict.

## Pre-change state (hard-coded)

```typescript
const BOARD_TO_CHANNEL: Record<string, string> = {
    "hermes-projects-sync": "1504266202506199272",
};
```

## Post-change state (config-driven)

```yaml
# board_channel_map.yaml
boards:
  hermes-projects-sync:
    channel_id: "1504266202506199272"
    required: true
```

## Verification steps

### 1. Loader output matches hard-coded value

```
$ node -e "const {loadBoardChannelMap} = require('./dist/boardChannelMap.js'); console.log(JSON.stringify(loadBoardChannelMap()))"

{
  "boardToChannel": {"hermes-projects-sync": "1504266202506199272"},
  "channelToBoard": {"1504266202506199272": "hermes-projects-sync"}
}
```

**Result: PASS** — `hermes-projects-sync` → `1504266202506199272` (identical to pre-change)

### 2. Discord API channel validation

```
$ node -e "... validateBoardChannelMap(config, token) ..."

{
  "results": [
    {"slug": "hermes-projects-sync", "channel_id": "1504266202506199272", "ok": true}
  ]
}
```

**Result: PASS** — Channel ID resolves to a valid Discord channel via API

### 3. Non-required 404 channels warn, don't crash

```
Tested with fake channel_id "0000000000000000000", required: false
→ stderr: [board_channel_map] WARNING: channel ... failed validation: HTTP 404 Not Found
→ Process continues normally
```

**Result: PASS** — Warn-on-miss, non-fatal

### 4. Required 404 channels block boot

```
Tested with fake channel_id "9999999999999999999", required: true
→ Throws: "FATAL: Required board-channel mappings failed validation..."
```

**Result: PASS** — Fatal on required failures

### 5. No stale hard-coded dict

```
$ rg -n "BOARD_TO_CHANNEL" src/
src/boardChannelMap.ts:4: * Reads board_channel_map.yaml and provides the BOARD_TO_CHANNEL and
src/index.ts:116:const { boardToChannel: BOARD_TO_CHANNEL, channelToBoard: CHANNEL_TO_BOARD } =
src/index.ts:999:   const channelId = BOARD_TO_CHANNEL[t.board_slug];
```

**Result: PASS** — No hard-coded dict. All references go through config-driven loader.

### 6. Build passes

```
$ npm run build
> tsc
(exit 0, no errors)
```

**Result: PASS**

### 7. --seed script runs without error

```
$ npx tsx scripts/seed-board-map.ts --boards-dir ~/.hermes/kanban/boards
# Board-to-Channel Mapping Registry
# Boards scanned: 7
# Matched: 0, Unmatched: 7
# (hermes-projects-sync unmatched because Discord channel is named "notion-infra")
boards:
# unmatched: discord-hygiene
# unmatched: hermes-projects-sync
...
```

**Result: PASS** — Emits valid YAML to stdout. No matches are expected since
board slugs don't case-insensitively equal channel names for existing boards
(the manual mapping in board_channel_map.yaml handles this).

## Conclusion

All self-validation gates pass. The migration from hard-coded to config-driven
is transparent — `hermes-projects-sync` resolves to `1504266202506199272`
identically in both implementations.
