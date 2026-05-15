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

// ── Managed database: Hermes Tasks ─────────────────────────────────
// Stores kanban task state for the Notion ↔ Hermes sync pipeline.
// Primary key is the kanban task ID (task_id: t_...).
const tasks = worker.database("tasks", {
	type: "managed",
	initialTitle: "Hermes Tasks",
	primaryKeyProperty: "task_id",
	schema: {
		properties: {
			// Human-readable task title
			Name: Schema.title(),

			// Kanban task ID (t_...) — primary key
			task_id: Schema.richText(),

			// Kanban board slug, used for relation lookup to projects
			board_slug: Schema.richText(),

			// Task lifecycle status — must cover every kanban state
			status: Schema.select([
				{ name: "todo" },
				{ name: "running" },
				{ name: "blocked" },
				{ name: "done" },
				{ name: "cancelled" },
				{ name: "archived" },
			]),

			// Assignee handle (profile name)
			assignee: Schema.richText(),

			// Full task body (markdown, may be long)
			body: Schema.richText(),

			// Comma-joined parent task IDs
			parents: Schema.richText(),

			// Comma-joined child task IDs
			children: Schema.richText(),

			// Task creation timestamp
			created_at: Schema.date(),

			// Last update timestamp
			updated_at: Schema.date(),

			// Most recent kanban_complete/block summary
			latest_summary: Schema.richText(),

			// Dual-property relation to the projects database
			// Populated via board_slug ↔ projects.kanban_board_slug lookup (see task 2.7)
			project: Schema.relation("projects", {
				twoWay: true,
				relatedPropertyName: "Tasks",
			}),
		},
	},
});

// ── Constants ──────────────────────────────────────────────────────
// Discord guild and category IDs (verified 2026-05-15)
const GUILD_ID = "000000000000000001"; // AGENTIC-OS council guild
const PROJECTS_CATEGORY_ID = "000000000000000002"; // PROJECTS category
const ARCHIVE_CATEGORY_ID = "000000000000000015"; // ARCHIVE category

// ── Rate limiter: Discord API ───────────────────────────────────────
// Discord global rate limit floor is 50/s per the SDK docs.
const discordPacer = worker.pacer("discord", {
	allowedRequests: 50,
	intervalMs: 1000,
});

// ── Rate limiter: GitHub API ────────────────────────────────────────
// Conservative: 30 requests per 60s (GitHub PAT allows much more,
// but this is the unauth floor — we stay conservative).
const githubPacer = worker.pacer("github", {
	allowedRequests: 30,
	intervalMs: 60_000,
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

// Tool: renameProjectChannel
// Renames a Discord channel. Propagates a name change from Notion → Discord.
worker.tool("renameProjectChannel", {
	title: "Rename Project Channel",
	description:
		"Rename a Discord channel. Fired when a user renames the project in Notion. Propagates the change to Discord.",
	schema: j.object({
		discord_channel_id: j
			.string()
			.describe("The Discord channel ID (snowflake) to rename."),
		new_name: j
			.string()
			.describe("The new channel name (lowercase, hyphens, 1-100 chars)."),
	}),
	outputSchema: j.object({
		ok: j.boolean(),
		old_name: j.string().nullable(),
		new_name: j.string().nullable(),
		channel_id: j.string().nullable(),
		error: j.string().nullable(),
	}),
	hints: { readOnlyHint: false },
	execute: async ({ discord_channel_id, new_name }) => {
		const discordToken = process.env.DISCORD_BOT_TOKEN;

		if (!discordToken) {
			return {
				ok: false,
				old_name: null,
				new_name: null,
				channel_id: null,
				error: "DISCORD_BOT_TOKEN not configured",
			};
		}

		try {
			// Get current channel info (for old name)
			const getRes = await fetch(
				`https://discord.com/api/v10/channels/${discord_channel_id}`,
				{
					method: "GET",
					headers: { Authorization: `Bot ${discordToken}` },
				}
			);

			let old_name = "unknown";
			if (getRes.ok) {
				const channelData = (await getRes.json()) as { name?: string };
				old_name = channelData.name ?? "unknown";
			}

			// Patch the channel name
			const patchRes = await fetch(
				`https://discord.com/api/v10/channels/${discord_channel_id}`,
				{
					method: "PATCH",
					headers: {
						Authorization: `Bot ${discordToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ name: new_name }),
				}
			);

			if (patchRes.ok) {
				const result = (await patchRes.json()) as { name?: string };
				return {
					ok: true,
					old_name,
					new_name: result.name ?? new_name,
					channel_id: discord_channel_id,
					error: null,
				};
			} else {
				const body = await patchRes.text();
				return {
					ok: false,
					old_name,
					new_name: null,
					channel_id: discord_channel_id,
					error: `Discord API error: ${patchRes.status} ${body}`,
				};
			}
		} catch (err) {
			return {
				ok: false,
				old_name: null,
				new_name: null,
				channel_id: discord_channel_id,
				error: `Exception: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	},
});

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

// Tool: upsertTask
// Accepts full task JSON from local kanban hook, creates or updates a row in the Notion tasks database.
// This is the real-time delta path — local kanban hook (card 2.3) fires this on every state transition.
worker.tool("upsertTask", {
	title: "Upsert Kanban Task",
	description:
		"Create or update a kanban task row in the Hermes Tasks database. " +
		"Fired by the local kanban hook on every task state transition.",
	schema: j.object({
		task_id: j
			.string()
			.describe("Kanban task ID in t_xxxx format (must match /^t_[a-f0-9]+$/)."),
		board_slug: j.string().describe("Kanban board slug."),
		name: j
			.string()
			.describe("Task title (1-2000 chars)."),
		status: j
			.enum("todo", "running", "blocked", "done", "cancelled", "archived")
			.describe("Task lifecycle status."),
		assignee: j.string().nullable().describe("Assignee profile handle."),
		body: j
			.string()
			.describe("Full task body (markdown, may be long, max 50000 chars)."),
		parents: j
			.array(j.string())
			.describe("Array of parent task IDs (empty if none)."),
		children: j
			.array(j.string())
			.describe("Array of child task IDs (empty if none)."),
		created_at: j.string().describe("ISO 8601 creation timestamp."),
		updated_at: j.string().describe("ISO 8601 last-update timestamp."),
		latest_summary: j
			.string()
			.nullable()
			.describe("Most recent kanban_complete/block summary."),
	}),
	outputSchema: j.object({
		ok: j.boolean(),
		action: j.string().nullable(),
		task_id: j.string(),
		page_id: j.string().nullable(),
		error: j.string().nullable(),
	}),
	hints: { readOnlyHint: false },
	execute: async (input, { notion }) => {
		const tasksDatabaseId = process.env.NOTION_TASKS_DATABASE_ID;
		const notionToken = process.env.NOTION_API_TOKEN;

		// Validate task_id format
		if (!/^t_[a-f0-9]+$/.test(input.task_id)) {
			return {
				ok: false,
				action: null,
				task_id: input.task_id,
				page_id: null,
				error: `Invalid task_id format: must match /^t_[a-f0-9]+$/`,
			};
		}

		if (!tasksDatabaseId) {
			return {
				ok: false,
				action: null,
				task_id: input.task_id,
				page_id: null,
				error: "NOTION_TASKS_DATABASE_ID not configured",
			};
		}

		// Notion richText has a 2000-char limit per text block.
		// Truncate body if it exceeds this to avoid API errors.
		const MAX_RICH_TEXT = 2000;
		const truncatedBody =
			input.body.length > MAX_RICH_TEXT
				? input.body.slice(0, MAX_RICH_TEXT - 3) + "..."
				: input.body;

		// Convert arrays to comma-joined strings for richText storage
		const parentsStr = input.parents.join(",");
		const childrenStr = input.children.join(",");

		// Helper: build Notion richText property value
		const richText = (text: string) => ({
			rich_text: text
				? [{ text: { content: text } }]
				: [],
		});

		// Helper: build Notion title property value
		const title = (text: string) => ({
			title: [{ text: { content: text } }],
		});

		// Helper: build Notion select property value
		const select = (name: string) => ({
			select: { name },
		});

		// Helper: build Notion date property value from ISO string
		const date = (iso: string) => ({
			date: iso ? { start: iso } : null,
		});

		// Build the properties payload (excluding 'project' relation — owned by 2.7)
		const properties: Record<string, any> = {
			Name: title(input.name),
			task_id: richText(input.task_id),
			board_slug: richText(input.board_slug),
			status: select(input.status),
			assignee: richText(input.assignee ?? ""),
			body: richText(truncatedBody),
			parents: richText(parentsStr),
			children: richText(childrenStr),
			created_at: date(input.created_at),
			updated_at: date(input.updated_at),
			latest_summary: richText(input.latest_summary ?? ""),
		};

		try {
			// Build auth headers — use context.notion if available (deployed), fall back to env var
			const authHeaders: Record<string, string> = {
				"Content-Type": "application/json",
				"Notion-Version": "2022-06-28",
			};
			if (notionToken) {
				authHeaders["Authorization"] = `Bearer ${notionToken}`;
			}

			// Step 1: Query tasks database for existing row with this task_id
			const queryResponse = await fetch(
				`https://api.notion.com/v1/databases/${tasksDatabaseId}/query`,
				{
					method: "POST",
					headers: authHeaders,
					body: JSON.stringify({
						filter: {
							property: "task_id",
							rich_text: {
								equals: input.task_id,
							},
						},
					}),
				}
			);

			if (!queryResponse.ok) {
				const errBody = await queryResponse.text();
				return {
					ok: false,
					action: null,
					task_id: input.task_id,
					page_id: null,
					error: `Notion query failed: ${queryResponse.status} ${errBody}`,
				};
			}

			const queryData = (await queryResponse.json()) as {
				results: Array<{ id: string; properties: Record<string, any> }>;
			};

			if (queryData.results.length > 0) {
				// ── UPDATE existing page ──
				const existingPage = queryData.results[0];
				const pageId = existingPage.id;

				// Preserve existing 'project' relation if set — don't clobber it
				// (project binding is owned by task 2.7)

				const updateResponse = await fetch(
					`https://api.notion.com/v1/pages/${pageId}`,
					{
						method: "PATCH",
						headers: authHeaders,
						body: JSON.stringify({ properties }),
					}
				);

				if (!updateResponse.ok) {
					const errBody = await updateResponse.text();
					return {
						ok: false,
						action: "updated",
						task_id: input.task_id,
						page_id: pageId,
						error: `Notion update failed: ${updateResponse.status} ${errBody}`,
					};
				}

				return {
					ok: true,
					action: "updated",
					task_id: input.task_id,
					page_id: pageId,
					error: null,
				};
			} else {
				// ── CREATE new page ──
				// Leave 'project' relation empty — binding happens in 2.7
				const createResponse = await fetch(
					"https://api.notion.com/v1/pages",
					{
						method: "POST",
						headers: authHeaders,
						body: JSON.stringify({
							parent: { database_id: tasksDatabaseId },
							properties,
						}),
					}
				);

				if (!createResponse.ok) {
					const errBody = await createResponse.text();
					return {
						ok: false,
						action: "created",
						task_id: input.task_id,
						page_id: null,
						error: `Notion create failed: ${createResponse.status} ${errBody}`,
					};
				}

				const createdPage = (await createResponse.json()) as { id: string };
				return {
					ok: true,
					action: "created",
					task_id: input.task_id,
					page_id: createdPage.id,
					error: null,
				};
			}
		} catch (err) {
			return {
				ok: false,
				action: null,
				task_id: input.task_id,
				page_id: null,
				error: `Exception: ${err instanceof Error ? err.message : String(err)}`,
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

// ── Sync: tasksReconciliation ───────────────────────────────────────
// 30-min backstop that pulls the full kanban snapshot from a private
// GitHub gist and upserts every task into the Notion tasks database.
//
// Mode: incremental (NOT replace — we preserve history and only emit
// explicit deletes when the gist marks a task as gc'd).
// This catches drift missed by the real-time delta path (2.3).
//
// Gist shape: { version, board, generated_at, tasks: [{ task_id, board_slug,
//   name, status, assignee, body, parents, children, created_at, updated_at,
//   latest_summary }] }

// Helper: truncate richText to Notion's 2000-char limit per block
function truncate(text: string | null | undefined, max = 2000): string {
	if (!text) return "";
	return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

worker.sync("tasksReconciliation", {
	database: tasks,
	mode: "incremental",
	schedule: "30m",
	execute: async (state) => {
		// ── 1. Validate env ──────────────────────────────────────────
		const gistUrl = process.env.KANBAN_GIST_URL;
		const githubToken = process.env.GITHUB_TOKEN;

		if (!gistUrl) {
			throw new Error(
				"KANBAN_GIST_URL not configured — push via `ntn workers env push`"
			);
		}
		if (!githubToken) {
			throw new Error(
				"GITHUB_TOKEN not configured — push via `ntn workers env push`"
			);
		}

		// ── 2. Fetch gist snapshot ───────────────────────────────────
		await githubPacer.wait();
		const gistRes = await fetch(gistUrl, {
			method: "GET",
			headers: {
				Authorization: `token ${githubToken}`,
				Accept: "application/json",
			},
		});

		if (!gistRes.ok) {
			throw new Error(
				`GitHub gist fetch failed: ${gistRes.status} ${gistRes.statusText}`
			);
		}

		const snapshot = (await gistRes.json()) as {
			version: number;
			board: string;
			generated_at: string;
			tasks: Array<{
				task_id: string;
				board_slug: string;
				name: string;
				status: string;
				assignee: string | null;
				body: string;
				parents: string[];
				children: string[];
				created_at: string;
				updated_at: string;
				latest_summary: string | null;
				"gc'd"?: boolean;
			}>;
		};

		// ── 3. Safety guard: abort on empty/corrupt gist ─────────────
		if (!snapshot.tasks || snapshot.tasks.length < 1) {
			// Return no changes — do NOT throw. Throwing would retry
			// indefinitely; returning empty changes is a safe no-op.
			console.warn(
				`tasksReconciliation: gist has ${snapshot.tasks?.length ?? 0} tasks — aborting (possible corruption).`
			);
			return { changes: [], hasMore: false };
		}

		// ── 4. Map tasks to sync changes ─────────────────────────────
		const changes = [];

		for (const task of snapshot.tasks) {
			// If the gist marks this task as gc'd, emit a delete
			if (task["gc'd"] === true) {
				changes.push({
					type: "delete" as const,
					key: task.task_id,
				});
				continue;
			}

			// Map to Notion properties — same schema as tasks database
			changes.push({
				type: "upsert" as const,
				key: task.task_id,
				properties: {
					Name: Builder.title(truncate(task.name, 2000)),
					task_id: Builder.richText(task.task_id),
					board_slug: Builder.richText(task.board_slug || ""),
					status: Builder.select(task.status),
					assignee: Builder.richText(task.assignee || ""),
					body: Builder.richText(truncate(task.body, 2000)),
					parents: Builder.richText(
						Array.isArray(task.parents)
							? task.parents.join(",")
							: ""
					),
					children: Builder.richText(
						Array.isArray(task.children)
							? task.children.join(",")
							: ""
					),
					created_at: Builder.dateTime(task.created_at),
					updated_at: Builder.dateTime(task.updated_at),
					latest_summary: Builder.richText(
						truncate(task.latest_summary, 2000)
					),
				},
				// Use updated_at for conflict resolution when the delta
				// sync (2.3) writes to the same row. The most recent
				// upstreamUpdatedAt wins.
				upstreamUpdatedAt: task.updated_at,
			});
		}

		return {
			changes,
			hasMore: false,
		};
	},
});


// Tool: tombstoneTask
// Soft-deletes a task row in Notion by flipping status to "archived" and
// stamping a tombstone message. Preserves the row for historical queries.
worker.tool("tombstoneTask", {
	title: "Tombstone Task",
	description:
		"Soft-delete a task in Notion by setting status to archived and stamping a tombstone reason. Preserves the audit trail — does NOT delete the Notion page.",
	schema: j.object({
		task_id: j.string().describe("The kanban task ID (t_...) to tombstone"),
		reason: j
			.string()
			.nullable()
			.describe(
				"Optional human-readable reason for tombstoning (default: 'kanban gc')"
			),
	}),
	outputSchema: j.object({
		ok: j.boolean(),
		action: j.string().nullable(),
		error: j.string().nullable(),
		task_id: j.string(),
		page_id: j.string().nullable(),
	}),
	hints: { readOnlyHint: false },
	execute: async ({ task_id, reason }) => {
		const notionToken = process.env.NOTION_API_TOKEN;
		const tasksDatabaseId = process.env.NOTION_TASKS_DATABASE_ID;

		if (!notionToken) {
			return {
				ok: false,
				action: null,
				error: "NOTION_API_TOKEN not configured",
				task_id,
				page_id: null,
			};
		}

		if (!tasksDatabaseId) {
			return {
				ok: false,
				action: null,
				error: "NOTION_TASKS_DATABASE_ID not configured",
				task_id,
				page_id: null,
			};
		}

		try {
			// Step 1: Query the tasks database for the row matching task_id
			const queryResponse = await fetch(
				`https://api.notion.com/v1/databases/${tasksDatabaseId}/query`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${notionToken}`,
						"Content-Type": "application/json",
						"Notion-Version": "2026-02-15",
					},
					body: JSON.stringify({
						filter: {
							property: "task_id",
							rich_text: {
								equals: task_id,
							},
						},
					}),
				}
			);

			if (!queryResponse.ok) {
				return {
					ok: false,
					action: null,
					error: `Notion API query failed: ${queryResponse.status}`,
					task_id,
					page_id: null,
				};
			}

			const queryData = await queryResponse.json();

			// Step 2: If not found, return error
			if (!queryData.results || queryData.results.length === 0) {
				return {
					ok: false,
					action: null,
					error: "no_task_row_matches",
					task_id,
					page_id: null,
				};
			}

			const page = queryData.results[0];
			const pageId = page.id;

			// Step 3: Check if already archived (idempotent)
			const currentStatus = page.properties?.status;
			if (
				currentStatus?.type === "select" &&
				currentStatus.select?.name === "archived"
			) {
				return {
					ok: true,
					action: "already_tombstoned",
					error: null,
					task_id,
					page_id: pageId,
				};
			}

			// Step 4: PATCH the page — status → archived, latest_summary → tombstoned reason, updated_at → now
			const tombstoneMessage = `tombstoned: ${reason ?? "kanban gc"}`;
			const now = new Date().toISOString();

			const patchResponse = await fetch(
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
							status: {
								select: {
									name: "archived",
								},
							},
							latest_summary: {
								rich_text: [
									{
										text: {
											content: tombstoneMessage,
										},
									},
								],
							},
							updated_at: {
								date: {
									start: now,
								},
							},
						},
					}),
				}
			);

			if (!patchResponse.ok) {
				const body = await patchResponse.text();
				return {
					ok: false,
					action: null,
					error: `Notion API patch failed: ${patchResponse.status} ${body}`,
					task_id,
					page_id: pageId,
				};
			}

			return {
				ok: true,
				action: "tombstoned",
				error: null,
				task_id,
				page_id: pageId,
			};
		} catch (err) {
			return {
				ok: false,
				action: null,
				error: `Exception: ${err instanceof Error ? err.message : String(err)}`,
				task_id,
				page_id: null,
			};
		}
	},
});
