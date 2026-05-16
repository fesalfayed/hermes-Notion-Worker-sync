# Repository Guidelines

## Project Structure
- `src/index.ts` — worker entry point, registers all capabilities (~67 LOC).
- `src/databases.ts` — `projects` + `kanban_tasks` database declarations.
- `src/syncs/` — `projectsFromDiscord`, `tasksBackfill`, `tasksDelta`.
- `src/tools/` — 7 tools for Discord channel management and task CRUD.
- `src/webhooks/` — `kanbanEvent` real-time bridge.
- `src/lib/` — shared utilities (HMAC verification, Notion helpers).
- `.examples/` — focused SDK samples (sync, tool, automation, OAuth, webhook).
- `board_channel_map.yaml` — kanban-board ↔ Discord-channel registry.

## Build & Development
- **Node ≥22**, npm ≥10.9.2
- `npm run build` — compile TypeScript to `dist/`
- `npm run check` — type-check only (no emit)
- `npm run onboard` — interactive setup (installs deps, writes `.env`, builds)
- `ntn workers deploy` — build and publish
- `ntn workers exec <capability> --local` — run locally

## Coding Style
- TypeScript with `strict` enabled.
- Tabs for indentation.
- Capability keys in lowerCamelCase.
- Environment variables for all secrets and IDs — never hardcode.

## Testing
- No test runner; validate with `npm run check` + `ntn workers exec` (see `docs/development.md`).

## Commits
- Convention: `feat(scope): ...`, `fix(scope): ...`, or `chore: ...`.
