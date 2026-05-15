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
const GUILD_ID = "1503993869572898826";
const PROJECTS_CATEGORY_ID = "1503996476190097480"; // Real PROJECTS category (not template stub)
const ARCHIVE_CATEGORY_ID = ""; // No ARCHIVE category exists in this guild yet

// ── Rate limiter: Discord API ───────────────────────────────────────
// Discord global rate limit floor is 50/s per the SDK docs.
const discordPacer = worker.pacer("discord", {
	allowedRequests: 50,
	intervalMs: 1000,
});

// ── Sync: projectsFromDiscord ───────────────────────────────────────
// Replace-mode sync that fetches Discord PROJECTS category channels and
// writes them into the Notion projects database. Channels removed from Discord
// are mark-and-swept (deleted from Notion).
worker.sync("projectsFromDiscord", {
	database: projects,
	mode: "replace",
	schedule: "5m",
	execute: async (state) => {
		const discordToken = process.env.DISCORD_BOT_TOKEN;
		if (!discordToken) {
			throw new Error("DISCORD_BOT_TOKEN not configured");
		}

		// Fetch all guild channels
		await discordPacer.wait();
		const channelsUrl = `https://discord.com/api/v10/guilds/${GUILD_ID}/channels`;
		const channelsRes = await fetch(channelsUrl, {
			method: "GET",
			headers: {
				Authorization: `Bot ${discordToken}`,
				"Content-Type": "application/json",
			},
		});

		if (!channelsRes.ok) {
			throw new Error(
				`Discord API error: ${channelsRes.status} ${channelsRes.statusText}`
			);
		}

		const allChannels = (await channelsRes.json()) as any[];

		// Filter to PROJECTS and ARCHIVE categories
		const projectChannels = allChannels.filter(
			(ch) =>
				ch.parent_id === PROJECTS_CATEGORY_ID ||
				ch.parent_id === ARCHIVE_CATEGORY_ID
		);

		// Guard: if we get fewer than 1 channel, abort to avoid mark-and-sweep deletes
		// on transient Discord API issues.
		if (projectChannels.length < 1) {
			throw new Error(
				`Discord returned ${projectChannels.length} project channels (expected ≥1). ` +
					`Aborting to prevent accidental mark-and-sweep deletes.`
			);
		}

		// Convert each channel to a Notion upsert record
		const changes = projectChannels.map((channel) => ({
			type: "upsert" as const,
			key: channel.id, // Primary key on discord_channel_id
			properties: {
				Name: Builder.title(channel.name),
				discord_channel_id: Builder.richText(channel.id),
				discord_topic: Builder.richText(channel.topic || ""),
				discord_category_id: Builder.richText(channel.parent_id || ""),
				discord_archived: Builder.checkbox(
					channel.parent_id === ARCHIVE_CATEGORY_ID
				),
			},
			// NOTE: We omit kanban_board_slug, kanban_task_ids, status, and notes
			// because these are Notion-owned and must not be modified by this sync.
		}));

		return {
			changes,
			hasMore: false,
		};
	},
});

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

// Tool: rebindByChannelId
// Re-anchors a Notion row to its Discord channel by discord_channel_id.
// Detects when a Discord channel was renamed (slug drift) and syncs current channel state.
worker.tool("rebindByChannelId", {
	title: "Rebind Project by Discord Channel ID",
	description:
		"Re-anchor a Notion project row to its Discord channel using discord_channel_id (the stable key). Syncs channel name, topic, and category to Notion. Use for emergency rebind when the sync is paused or drift occurred via direct Notion edits.",
	schema: j.object({
		discord_channel_id: j.string().describe("The Discord channel snowflake to rebind"),
	}),
	outputSchema: j.object({
		ok: j.boolean(),
		action: j.string().nullable(),
		error: j.string().nullable(),
		before: j
			.object({
				Name: j.string().nullable(),
				discord_topic: j.string().nullable(),
				discord_category_id: j.string().nullable(),
				discord_archived: j.boolean(),
			})
			.nullable(),
		after: j
			.object({
				Name: j.string().nullable(),
				discord_topic: j.string().nullable(),
				discord_category_id: j.string().nullable(),
				discord_archived: j.boolean(),
			})
			.nullable(),
	}),
	hints: { readOnlyHint: false },
	execute: async (input, { notion }) => {
		const { discord_channel_id } = input;
		const discordToken = process.env.DISCORD_BOT_TOKEN;

		if (!discordToken) {
			return {
				ok: false,
				action: null,
				error: "DISCORD_BOT_TOKEN not configured",
				before: null,
				after: null,
			};
		}

		try {
			// Step 1: Fetch Discord channel by ID to get current state
			const discordChannelResponse = await fetch(
				`https://discord.com/api/v10/channels/${discord_channel_id}`,
				{
					method: "GET",
					headers: { Authorization: `Bot ${discordToken}` },
				}
			);

			if (!discordChannelResponse.ok) {
				return {
					ok: false,
					action: null,
					error: `Discord API error: ${discordChannelResponse.status}`,
					before: null,
					after: null,
				};
			}

			const discordChannel = await discordChannelResponse.json();

			// Step 2: Query Notion projects database for the row matching discord_channel_id
			// Get the Notion API token and database ID
			const projectsDatabaseId = process.env.NOTION_PROJECTS_DATABASE_ID;
			const notionToken = process.env.NOTION_API_TOKEN;

			if (!projectsDatabaseId || !notionToken) {
				return {
					ok: false,
					action: null,
					error: !projectsDatabaseId ? "NOTION_PROJECTS_DATABASE_ID not configured" : "NOTION_API_TOKEN not configured",
					before: null,
					after: null,
				};
			}

			// Use REST API to query the Notion database
			const notionResponse = await fetch(
				`https://api.notion.com/v1/databases/${projectsDatabaseId}/query`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${notionToken}`,
						"Content-Type": "application/json",
						"Notion-Version": "2026-02-15",
					},
					body: JSON.stringify({
						filter: {
							property: "discord_channel_id",
							rich_text: {
								equals: discord_channel_id,
							},
						},
					}),
				}
			);

			if (!notionResponse.ok) {
				return {
					ok: false,
					action: null,
					error: `Notion API query failed: ${notionResponse.status}`,
					before: null,
					after: null,
				};
			}

			const notionData = await notionResponse.json();

			// If not found in Notion
			if (!notionData.results || notionData.results.length === 0) {
				return {
					ok: false,
					action: null,
					error: "no_notion_row_matches",
					before: null,
					after: null,
				};
			}

			const notionPage = notionData.results[0];
			const pageId = notionPage.id;

			// Extract current Notion values for the "before" snapshot
			const notionProperties = notionPage.properties;
			const beforeSnapshot = {
				Name:
					notionProperties.Name?.type === "title"
						? notionProperties.Name.title[0]?.plain_text || null
						: null,
				discord_topic:
					notionProperties.discord_topic?.type === "rich_text"
						? notionProperties.discord_topic.rich_text[0]?.plain_text || null
						: null,
				discord_category_id:
					notionProperties.discord_category_id?.type === "rich_text"
						? notionProperties.discord_category_id.rich_text[0]?.plain_text || null
						: null,
				discord_archived:
					notionProperties.discord_archived?.type === "checkbox"
						? notionProperties.discord_archived.checkbox
						: false,
			};

			// Prepare "after" snapshot with Discord's current values
			const currentArchived = discordChannel.parent_id === ARCHIVE_CATEGORY_ID;
			const afterSnapshot = {
				Name: discordChannel.name || null,
				discord_topic: discordChannel.topic || null,
				discord_category_id: discordChannel.parent_id || null,
				discord_archived: currentArchived,
			};

			// Step 3: PATCH the Notion page with Discord's current values via REST API
			// Skip kanban_* and notes columns per task specification
			const updateResponse = await fetch(
				`https://api.notion.com/v1/pages/${pageId}`,
				{
					method: "PATCH",
					headers: {
						Authorization: `Bearer ${notionToken}`,
						"Content-Type": "application/json",
						"Notion-Version": "2026-02-15",
					},
					body: JSON.stringify({
						properties: {
							Name: {
								title: [
									{
										text: {
											content: discordChannel.name || "(unnamed)",
										},
									},
								],
							},
							discord_topic: {
								rich_text: discordChannel.topic
									? [{ text: { content: discordChannel.topic } }]
									: [],
							},
							discord_category_id: {
								rich_text: discordChannel.parent_id
									? [{ text: { content: discordChannel.parent_id } }]
									: [],
							},
							discord_archived: {
								checkbox: currentArchived,
							},
						},
					}),
				}
			);

			if (!updateResponse.ok) {
				return {
					ok: false,
					action: null,
					error: `Notion API update failed: ${updateResponse.status}`,
					before: beforeSnapshot,
					after: null,
				};
			}

			return {
				ok: true,
				action: "rebound",
				error: null,
				before: beforeSnapshot,
				after: afterSnapshot,
			};
		} catch (err) {
			return {
				ok: false,
				action: null,
				error: `Exception: ${err instanceof Error ? err.message : String(err)}`,
				before: null,
				after: null,
			};
		}
	},
});
