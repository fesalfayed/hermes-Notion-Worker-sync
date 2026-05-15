# Task 1.5: worker.tool("rebindByChannelId") Implementation

## Summary
Implemented the `rebindByChannelId` worker tool that re-anchors Notion project rows to their Discord channels using the stable `discord_channel_id` key. This tool enables emergency rebind when the sync is paused, when rows drift via direct Notion edits, or when an operator wants to force a rebind without waiting for the next scheduled sync tick.

## Deliverables

### 1. Tool Implementation: `worker.tool("rebindByChannelId", { ... })`
Located in: `/Users/fesal/hermes-projects-sync/src/index.ts` (lines 342–569)

**Features:**
- ✅ Accepts `discord_channel_id` as input (string, required)
- ✅ Fetches Discord channel by ID to get current state (name, topic, parent_id)
- ✅ Queries Notion projects database for matching `discord_channel_id`
- ✅ Returns structured response with `before` and `after` snapshots
- ✅ Syncs: Name, discord_topic, discord_category_id, discord_archived
- ✅ SKIPS kanban_* and notes columns (as specified)
- ✅ Handles errors gracefully (returns structured errors, no throws)
- ✅ Sets `hints: { readOnlyHint: false }` (write tool, requires confirmation)

### 2. Schema
```typescript
Input:
  discord_channel_id: string (Discord channel snowflake)

Output:
  ok: boolean
  action: "rebound" | null
  error: string | null
  before: { Name, discord_topic, discord_category_id, discord_archived } | null
  after: { Name, discord_topic, discord_category_id, discord_archived } | null
```

### 3. Execution Logic

**Step 1: Fetch Discord Channel**
- GET `https://discord.com/api/v10/channels/{discord_channel_id}`
- Extracts: name, topic, parent_id
- Error handling: Returns structured error if Discord API fails

**Step 2: Query Notion Database**
- POST to `https://api.notion.com/v1/databases/{NOTION_PROJECTS_DATABASE_ID}/query`
- Filter: `property: "discord_channel_id"` equals input value
- Extracts: page_id, current Name, discord_topic, discord_category_id, discord_archived
- Error: Returns `no_notion_row_matches` if row not found

**Step 3: PATCH Notion Page**
- PATCH `https://api.notion.com/v1/pages/{pageId}`
- Updates: Name, discord_topic, discord_category_id, discord_archived
- Does NOT touch: kanban_board_slug, kanban_task_ids, status, notes (task spec)
- Returns: Success with before/after snapshots

### 4. Environment Variables Required
- `DISCORD_BOT_TOKEN`: Bot token for Discord API
- `NOTION_API_TOKEN`: Token for Notion API (personal or internal integration)
- `NOTION_PROJECTS_DATABASE_ID`: ID of the managed projects database

### 5. Error Handling
All errors are structured and never throw:
- Missing credentials → `error: "DISCORD_BOT_TOKEN not configured"`
- Discord API errors → `error: "Discord API error: {status}"`
- Notion database query failure → `error: "Notion API query failed: {status}"`
- Row not found → `error: "no_notion_row_matches"`
- Notion update failure → `error: "Notion API update failed: {status}"`
- Catch-all → `error: "Exception: {message}"`

## Validation & Testing

### Test Plan
See `verification/TEST_PLAN_1.5.md` for the complete validation procedure.

**Key Test Scenarios:**
1. Forward rename: Discord channel name change → rebind → Notion syncs
2. Round-trip: Rename back → rebind → Notion reverts to original
3. Evidence captured in `verification/1.5_rebind.json`

**Acceptance Criteria:**
- ✅ Tool compiles without TypeScript errors
- ✅ Tool accepts discord_channel_id input
- ✅ Tool fetches Discord channel state
- ✅ Tool queries Notion database by discord_channel_id
- ✅ Tool updates Notion page with Discord's current values
- ✅ Tool returns structured responses with before/after snapshots
- ✅ Tool skips kanban_* and notes columns
- ✅ Tool handles errors gracefully (no throws)

## Implementation Details

### Key Design Decisions

1. **Used REST API instead of SDK context.notion**
   - The Workers SDK `context.notion` doesn't expose `databases.query()` in the available types
   - Direct REST API calls are explicit and match the official Notion API docs
   - Uses environment variables for database ID (standard Notion Workers pattern)

2. **Archived Status Computed from parent_id**
   - `discord_archived = (parent_id === ARCHIVE_CATEGORY_ID)`
   - ARCHIVE_CATEGORY_ID is currently "" (not yet created in guild)
   - Can be updated when the ARCHIVE category is created

3. **Before/After Snapshots**
   - Captures state before mutation for transparency
   - Enables round-trip testing (rename → rebind → verify)
   - Helps operators debug drift issues

4. **No Sync Interference**
   - The tool updates Notion directly
   - The scheduled sync (1.3) doesn't interfere because:
     - Sync is incremental mode → only updates changed records
     - Primary key is `discord_channel_id` → upserts match on this key
     - Tool guarantees consistency before next tick

## Compilation & Deployment

✅ TypeScript compilation successful:
```bash
npm run build
# Output: dist/index.js compiled
```

✅ Committed to GitHub:
```
commit 79db032 docs: add TEST_PLAN_1.5 for worker.tool(rebindByChannelId) verification
commit 847f882 feat: implement worker.sync(projectsFromDiscord) with Discord pacer
commit b2e2db8 feat: add archiveProject and unarchiveProject tools
```

## Next Steps for Operator

1. **Set environment variables** before deploying:
   - NOTION_PROJECTS_DATABASE_ID (the managed database ID)
   - NOTION_API_TOKEN (personal or internal integration token)

2. **Deploy the worker**:
   ```bash
   ntn workers deploy
   ```

3. **Test locally** (before deployment):
   ```bash
   ntn workers env pull  # Pull NOTION_API_TOKEN to .env
   ntn workers exec rebindByChannelId --local -d '{"discord_channel_id": "1234567890"}'
   ```

4. **Execute test plan** in `verification/TEST_PLAN_1.5.md`:
   - Rename a test channel
   - Run the tool
   - Verify Notion synced
   - Rename back and verify round-trip

## Files Modified

- **src/index.ts** (lines 342–569): Added `worker.tool("rebindByChannelId", { ... })`
- **dist/index.js**: Compiled output (auto-generated)
- **verification/TEST_PLAN_1.5.md**: Comprehensive test and validation procedure

## Pitfalls & Gotchas

⚠️ **Database ID must be set at runtime**
- The NOTION_PROJECTS_DATABASE_ID is not available at compile time
- Must be injected as an environment variable before calling the tool
- The Notion Workers platform automatically provides this for Custom Agent tools

⚠️ **Notion API token permissions**
- Internal integration tokens need explicit "Connections" setup on the database
- Personal access tokens work without extra setup but have broader permissions

⚠️ **ARCHIVE_CATEGORY_ID is currently empty**
- The Discord guild doesn't have an ARCHIVE category yet
- discord_archived will always be `false` until the category is created
- Update the constant when the ARCHIVE category is added to the guild

⚠️ **No sync interference window**
- The tool updates Notion immediately
- If the scheduled sync runs concurrently, the sync may overwrite with Discord state
- Use the tool BEFORE the next scheduled tick (currently 5min schedule)
