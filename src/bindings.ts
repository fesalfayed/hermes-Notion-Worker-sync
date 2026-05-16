import { loadBoardChannelMap } from "./boardChannelMap.js";

// ── Kanban ↔ Discord-channel binding table ──────────────────────────
// Config-driven registry loaded from board_channel_map.yaml (project root).
// Maps kanban board slug → discord_channel_id of the project that owns it.
// Used by:
//   - projectsFromDiscord: to populate `kanban_board_slug` on the project row.
//   - tasksDelta: to resolve a task's `board_slug` to its project page (for
//     the two-way `project` relation).
//
// To add a new binding: edit board_channel_map.yaml, rebuild, and deploy.
// To discover mappings: npx tsx scripts/seed-board-map.ts
export const { boardToChannel: BOARD_TO_CHANNEL, channelToBoard: CHANNEL_TO_BOARD } =
	loadBoardChannelMap();
