# Test Plan: 1.5 worker.tool(rebindByChannelId)

## Overview
This tool re-anchors a Notion project row to its Discord channel using `discord_channel_id` (the stable key), detecting and syncing channel renames.

## Setup Requirements
1. DISCORD_BOT_TOKEN configured in environment
2. NOTION_API_TOKEN configured in environment  
3. NOTION_PROJECTS_DATABASE_ID configured (the managed database ID)
4. Two test Discord channels in PROJECTS category with existing Notion rows

## Test Procedure

### Test 1: Initial Rename → Rebind (Forward)
1. **Choose a test channel** — use one of the two channels verified to have a Notion row
   - Get its discord_channel_id (snowflake)
   - Note current Notion Name (should match Discord name initially)

2. **Rename the Discord channel** via Discord UI or Discord API
   - Example: "project-alpha" → "project-alpha-v2"

3. **Verify sync would pick it up**
   ```bash
   ntn workers exec projectsFromDiscord --preview
   ```
   - Confirm the preview output shows the channel name change (if a delta sync exists)

4. **Run rebindByChannelId tool BEFORE the next scheduled sync tick**
   ```bash
   ntn workers exec rebindByChannelId --local -d '{"discord_channel_id": "1234567890"}'
   # Or deployed:
   ntn workers exec rebindByChannelId -d '{"discord_channel_id": "1234567890"}'
   ```

5. **Verify the response**
   - `ok: true`
   - `action: "rebound"`
   - `before.Name`: old name (e.g., "project-alpha")
   - `after.Name`: new name (e.g., "project-alpha-v2")

6. **Check Notion database**
   - Open the projects database
   - Confirm the row's Name property now matches the new Discord name
   - Verify discord_topic, discord_category_id, discord_archived synced correctly

7. **Save forward evidence**
   - Document discord_channel_id, before/after names, and tool response
   - Append to `verification/1.5_rebind.json`

### Test 2: Rename Back → Rebind (Round-trip)
1. **Rename the Discord channel back** to the original name
   - Example: "project-alpha-v2" → "project-alpha"

2. **Run rebindByChannelId again** (same discord_channel_id)
   ```bash
   ntn workers exec rebindByChannelId -d '{"discord_channel_id": "1234567890"}'
   ```

3. **Verify the response**
   - `ok: true`
   - `action: "rebound"`
   - `before.Name`: "project-alpha-v2" (the intermediate state)
   - `after.Name`: "project-alpha" (back to original)

4. **Check Notion database**
   - Confirm the row's Name reverted to the original
   - All fields clean

5. **Save round-trip evidence**
   - Append to `verification/1.5_rebind.json`

## Expected Behavior

### Success Case
```json
{
  "ok": true,
  "action": "rebound",
  "error": null,
  "before": {
    "Name": "old-channel-name",
    "discord_topic": "old topic",
    "discord_category_id": "1503996476190097480",
    "discord_archived": false
  },
  "after": {
    "Name": "new-channel-name",
    "discord_topic": "new topic",
    "discord_category_id": "1503996476190097480",
    "discord_archived": false
  }
}
```

### Failure Cases
- **Discord channel not found**: `error: "Discord API error: 404"`
- **No matching Notion row**: `error: "no_notion_row_matches"`
- **Missing credentials**: `error: "DISCORD_BOT_TOKEN not configured"`
- **Notion API error**: `error: "Notion API query failed: 401"`

## Pitfalls
- The tool SKIPS `kanban_*` and `notes` columns — these are NOT touched
- The `discord_archived` field is computed from `parent_id === ARCHIVE_CATEGORY_ID`
- Environment variable `NOTION_PROJECTS_DATABASE_ID` must be set (the managed database ID)
- Token must have sufficient Notion API permissions to query and update the database

## Acceptance Criteria
✅ Forward rename → rebind → Notion Name reflects Discord change  
✅ Backward rename → rebind → Notion Name reverts cleanly  
✅ Evidence saved to `verification/1.5_rebind.json` with both test runs  
✅ No kanban_* or notes fields were modified  
✅ Tool handles errors gracefully (no throws, structured error responses)
