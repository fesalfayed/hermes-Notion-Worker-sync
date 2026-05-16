# Security Policy

## Reporting a vulnerability

Please **do not** open public issues for security vulnerabilities.

- Preferred: open a [GitHub Security Advisory](https://github.com/fesalfayed/hermes-projects-sync/security/advisories/new) on this repository.
- Alternative: email security@example.com  <!-- TODO: replace with real contact -->

We aim to acknowledge reports within 72 hours and provide a fix or mitigation timeline within 7 days.

## Supported versions

Only the latest release on `main` receives security updates.

## HMAC secret rotation (`KANBAN_WEBHOOK_SECRET`)

The `kanbanEvent` webhook authenticates payloads with an HMAC-SHA256 signature over the raw request body using `KANBAN_WEBHOOK_SECRET`. To rotate:

1. Generate a new secret: `openssl rand -hex 32`
2. Update the sender (your kanban hook) to sign with the **new** secret.
3. Push the new secret to the worker: `ntn workers env push KANBAN_WEBHOOK_SECRET`
4. Redeploy: `ntn workers deploy`
5. Verify the next webhook delivery succeeds, then retire the old secret.

If you suspect compromise, rotate immediately and audit recent webhook activity in worker logs.

## `NOTION_API_TOKEN` handling

- Use an **internal integration** scoped to only the databases this worker needs.
- Never commit tokens. `.env` is gitignored.
- Rotate at https://www.notion.so/profile/integrations/internal on suspected leak.
- Tool capabilities invoked through a Custom Agent receive a per-agent token automatically — no `NOTION_API_TOKEN` needed for those paths.
