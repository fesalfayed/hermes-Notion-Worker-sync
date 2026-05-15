# hermes-projects-sync

Discord ↔ Notion projects sync. A Notion Worker that synchronizes project data
between Discord and Notion, keeping both platforms in sync automatically.

## Architecture

Built on `@notionhq/workers` — Notion's TypeScript Worker SDK. The worker
runs as a deployed Notion Worker with capabilities (syncs, tools, webhooks)
that bridge Discord and Notion.

## Source of Truth (SoT) Documentation

All implementation decisions must trace back to these 13 spec files:

```
/home/user/Desktop/Notion CLI Docs/quickstart.md
/home/user/Desktop/Notion CLI Docs/sdk.md
/home/user/Desktop/Notion CLI Docs/commands.md
/home/user/Desktop/Notion CLI Docs/syncs.md
/home/user/Desktop/Notion CLI Docs/schema.md
/home/user/Desktop/Notion CLI Docs/tools.md
/home/user/Desktop/Notion CLI Docs/webhooks.md
/home/user/Desktop/Notion CLI Docs/api-client.md
/home/user/Desktop/Notion CLI Docs/api-requests.md
/home/user/Desktop/Notion CLI Docs/oauth.md
/home/user/Desktop/Notion CLI Docs/secrets.md
/home/user/Desktop/Notion CLI Docs/file-uploads.md
/home/user/Desktop/Notion CLI Docs/data-sources.md
```

Index pointer: https://developers.notion.com/llms.txt

## Dev Loop

### Local development

1. Edit `src/index.ts` (or add new files under `src/`)
2. Run a capability locally:
   ```bash
   ntn workers exec sayHello -d '{"name": "World"}' --local
   ```
3. The `--local` flag runs via `tsx` — no deploy needed for iteration.

### Deploy to Notion

```bash
ntn workers deploy
```

This builds and uploads the worker. On first deploy it creates the worker
record and writes `workers.json` with `workspaceId` and `workerId`.
Subsequent deploys update the existing worker.

### Remote execution

```bash
ntn workers exec sayHello -d '{"name": "World"}'
```

Without `--local`, this runs against the deployed worker in the cloud.

## Environment Variables

| Variable             | Purpose                                              |
|:---------------------|:-----------------------------------------------------|
| `NOTION_API_TOKEN`   | Internal integration token — overrides keychain auth |
| `DISCORD_BOT_TOKEN`  | Discord bot token for the sync integration           |
| `NOTION_WORKSPACE_ID`| Workspace ID — skips the workspace selection prompt  |
| `NOTION_KEYRING`     | Set to `0` for file-based auth instead of OS keychain|

Secrets are managed via `ntn workers env set KEY=value` for deployed workers,
and `.env` files for local development. Never commit `.env` to source control.

## Project Structure

```
src/index.ts       — Worker definition and capabilities
workers.json       — CLI config (workspaceId, workerId) — gitignored
.env               — Local secrets — gitignored
verification/      — Phase verification artifacts
```

## Phases

- **Phase 1.0**: Scaffold, auth, and dev-loop proof (this commit)
- Phase 1.1+: Discord sync capabilities, webhook handlers, etc.
