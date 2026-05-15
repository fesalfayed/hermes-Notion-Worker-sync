import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";
import * as Builder from "@notionhq/workers/builder";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

// ── Managed database: Hermes Projects ──────────────────────────────
// Bidirectional sync target for Discord channels ↔ Notion rows.
// Primary key is the Discord channel snowflake (discord_channel_id).
const projects = worker.database("projects", {
	type: "managed",
	initialTitle: "Hermes Projects",
	primaryKeyProperty: "discord_channel_id",
	schema: {
		properties: {
			// Human-readable project name, sourced from Discord channel name
			Name: Schema.title(),

			// Discord channel snowflake — primary key
			discord_channel_id: Schema.richText(),

			// Discord channel topic text
			discord_topic: Schema.richText(),

			// Kanban board slug (orchestrator-verified)
			kanban_board_slug: Schema.richText(),

			// Comma-joined or JSON-encoded list of kanban task IDs
			kanban_task_ids: Schema.richText(),

			// Project lifecycle status (kanban-owned)
			status: Schema.select([
				{ name: "Backlog" },
				{ name: "Planning" },
				{ name: "In progress" },
				{ name: "Paused" },
				{ name: "Done" },
				{ name: "Cancelled" },
			]),

			// True when Discord channel is in the ARCHIVE category
			discord_archived: Schema.checkbox(),

			// Discord category snowflake (PROJECTS or ARCHIVE)
			discord_category_id: Schema.richText(),

			// Timestamp of last Discord-side edit, used for conflict resolution
			last_discord_edit: Schema.date(),

			// Notion-owned free-text field (user-editable, sync skips on upsert)
			notes: Schema.richText(),
		},
	},
});

// ── Constants ──────────────────────────────────────────────────────
// Discord guild and category IDs (verified 2026-05-15)
const GUILD_ID = "000000000000000007";
const PROJECTS_CATEGORY_ID = "000000000000000009"; // Real PROJECTS category (not template stub)
const ARCHIVE_CATEGORY_ID = ""; // No ARCHIVE category exists in this guild yet

// ── Tools ──────────────────────────────────────────────────────────

// Tool: archiveProject
// Moves a Discord channel from PROJECTS category to ARCHIVE category.
worker.tool("archiveProject", {
	title: "Archive Project",
	description: "Move a Discord channel to the ARCHIVE category",
	schema: j.object({
		discord_channel_id: j.string().describe("The Discord channel ID to archive"),
	}),
	outputSchema: j.object({
		ok: j.boolean(),
		error: j.string().nullable(),
		from_category: j.string().nullable(),
		to_category: j.string().nullable(),
	}),
	execute: async (input) => {
		const { discord_channel_id } = input;
		const discordToken = process.env.DISCORD_BOT_TOKEN;

		if (!discordToken) {
			return {
				ok: false,
				error: "DISCORD_BOT_TOKEN not configured",
				from_category: null,
				to_category: null,
			};
		}

		try {
			// Fetch channel to get current parent_id
			const channelResponse = await fetch(
				`https://discord.com/api/v10/channels/${discord_channel_id}`,
				{
					method: "GET",
					headers: { Authorization: `Bot ${discordToken}` },
				}
			);

			if (!channelResponse.ok) {
				return {
					ok: false,
					error: `Failed to fetch channel: ${channelResponse.status}`,
					from_category: null,
					to_category: null,
				};
			}

			const channel = await channelResponse.json();
			const currentParentId = channel.parent_id;

			// Verify channel is in PROJECTS category before archiving
			if (currentParentId !== PROJECTS_CATEGORY_ID) {
				return {
					ok: false,
					error: "channel_not_in_expected_category",
					from_category: currentParentId || "none",
					to_category: null,
				};
			}

			// Move channel to ARCHIVE category
			const moveResponse = await fetch(
				`https://discord.com/api/v10/channels/${discord_channel_id}`,
				{
					method: "PATCH",
					headers: {
						Authorization: `Bot ${discordToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ parent_id: ARCHIVE_CATEGORY_ID }),
				}
			);

			if (!moveResponse.ok) {
				return {
					ok: false,
					error: `Failed to move channel: ${moveResponse.status}`,
					from_category: currentParentId,
					to_category: null,
				};
			}

			return {
				ok: true,
				error: null,
				from_category: currentParentId,
				to_category: ARCHIVE_CATEGORY_ID,
			};
		} catch (err) {
			return {
				ok: false,
				error: `Exception: ${err instanceof Error ? err.message : String(err)}`,
				from_category: null,
				to_category: null,
			};
		}
	},
});

// Tool: unarchiveProject
// Moves a Discord channel from ARCHIVE category to PROJECTS category.
worker.tool("unarchiveProject", {
	title: "Unarchive Project",
	description: "Move a Discord channel from ARCHIVE back to PROJECTS category",
	schema: j.object({
		discord_channel_id: j.string().describe("The Discord channel ID to unarchive"),
	}),
	outputSchema: j.object({
		ok: j.boolean(),
		error: j.string().nullable(),
		from_category: j.string().nullable(),
		to_category: j.string().nullable(),
	}),
	execute: async (input) => {
		const { discord_channel_id } = input;
		const discordToken = process.env.DISCORD_BOT_TOKEN;

		if (!discordToken) {
			return {
				ok: false,
				error: "DISCORD_BOT_TOKEN not configured",
				from_category: null,
				to_category: null,
			};
		}

		try {
			// Fetch channel to get current parent_id
			const channelResponse = await fetch(
				`https://discord.com/api/v10/channels/${discord_channel_id}`,
				{
					method: "GET",
					headers: { Authorization: `Bot ${discordToken}` },
				}
			);

			if (!channelResponse.ok) {
				return {
					ok: false,
					error: `Failed to fetch channel: ${channelResponse.status}`,
					from_category: null,
					to_category: null,
				};
			}

			const channel = await channelResponse.json();
			const currentParentId = channel.parent_id;

			// Verify channel is in ARCHIVE category before unarchiving
			if (currentParentId !== ARCHIVE_CATEGORY_ID) {
				return {
					ok: false,
					error: "channel_not_in_expected_category",
					from_category: currentParentId || "none",
					to_category: null,
				};
			}

			// Move channel to PROJECTS category
			const moveResponse = await fetch(
				`https://discord.com/api/v10/channels/${discord_channel_id}`,
				{
					method: "PATCH",
					headers: {
						Authorization: `Bot ${discordToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ parent_id: PROJECTS_CATEGORY_ID }),
				}
			);

			if (!moveResponse.ok) {
				return {
					ok: false,
					error: `Failed to move channel: ${moveResponse.status}`,
					from_category: currentParentId,
					to_category: null,
				};
			}

			return {
				ok: true,
				error: null,
				from_category: currentParentId,
				to_category: PROJECTS_CATEGORY_ID,
			};
		} catch (err) {
			return {
				ok: false,
				error: `Exception: ${err instanceof Error ? err.message : String(err)}`,
				from_category: null,
				to_category: null,
			};
		}
	},
});
