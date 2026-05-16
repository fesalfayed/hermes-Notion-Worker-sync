import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import { ARCHIVE_CATEGORY_ID } from "../constants.js";

// Tool: rebindByChannelId
// Re-anchors a Notion row to its Discord channel by discord_channel_id.
// Detects when a Discord channel was renamed (slug drift) and syncs current channel state.
export function register(worker: Worker) {
	worker.tool("rebindByChannelId", {
		title: "Rebind a project to its Discord channel",
		description:
			"Re-sync a project's Notion row with its Discord channel. Use when a project row drifted or was edited directly in Notion and needs to match Discord again. Fetches the latest channel name, topic, and category from Discord and patches the Notion row.",
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
		execute: async (input, { notion: _notion }) => {
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
				const projectsDatabaseId = process.env.PROJECTS_DATABASE_ID;

				const projectsDataSourceId = process.env.PROJECTS_DATA_SOURCE_ID;
				const notionToken = process.env.NOTION_API_TOKEN;

				if (!projectsDatabaseId || !notionToken) {
					return {
						ok: false,
						action: null,
						error: !projectsDatabaseId ? "PROJECTS_DATABASE_ID not configured" : "NOTION_API_TOKEN not configured",
						before: null,
						after: null,
					};
				}

				// Use REST API to query the Notion database
				const notionResponse = await fetch(
					`https://api.notion.com/v1/data_sources/${projectsDataSourceId}/query`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${notionToken}`,
							"Content-Type": "application/json",
							"Notion-Version": "2025-09-03",
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
							"Notion-Version": "2025-09-03",
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
}
