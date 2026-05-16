# Deployment

The worker runs in Notion's managed sandbox. Deployment uses the `ntn` CLI.

## First deploy

```bash
npm run check
npm run build
ntn workers deploy
```

`workers.json` (committed) pins the worker UUID and workspace UUID. The first deploy from a fresh fork will create new IDs and overwrite this file — commit it back so future deploys land in the same worker.

## OAuth dance

`ntn login` performs a browser-based OAuth handshake with Notion and writes a session token to the OS credential store (macOS keychain, libsecret on Linux). Logged-in sessions are tied to your Notion user.

When the worker declares OAuth capabilities (none currently in this repo), `ntn workers oauth show-redirect-url` prints the URL you must configure in the upstream provider (Google, GitHub, etc.). After deploying, always check redirect URLs match.

## Pushing env vars

Local `.env` is **not** automatically uploaded. Sync it explicitly:

```bash
ntn workers env push          # uploads every key from .env
ntn workers env list          # confirm
ntn workers env unset KEY     # remove a stale var
```

See [configuration/env.md](./configuration/env.md) for the full env-var inventory. The boot-time validator in `src/index.ts` will surface missing required vars as deploy failures (look at the post-deploy logs).

## Sandboxed `HOME` pitfall

The `ntn` CLI reads credentials from your OS keychain via `HOME`. When invoked from a sub-process whose `HOME` has been re-mapped to a sandbox path (Claude Code, some IDEs, CI runners), the keychain rejects access and `ntn` errors out with `Could not access keychain` or similar.

Workaround — always set `HOME` to your real home for `ntn` invocations from non-interactive contexts:

```bash
HOME=/Users/<you> ntn login
HOME=/Users/<you> ntn workers deploy
HOME=/Users/<you> ntn workers env push
HOME=/Users/<you> ntn workers logs
```

## Viewing logs

```bash
ntn workers logs                 # streaming, current worker
ntn workers logs --since 1h      # backfill window
ntn workers logs --capability kanbanEvent  # filter
```

`console.log` / `console.warn` / `console.error` from any capability execution land here. The HMAC verifier emits no info logs by design — failures throw `WebhookVerificationError` which the platform surfaces as a 401 in the request log.

## Auto-disable on webhook failure

Notion disables a webhook after **5 consecutive failed deliveries**. Re-enable from the Notion worker UI after fixing the underlying cause (typically a bad `KANBAN_WEBHOOK_SECRET` rotation or a payload shape regression). The accompanying `tasksDelta` + gist path keeps Notion within ~1 minute of truth while the webhook is offline.
