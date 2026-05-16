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
// Sync target for the kanban → Notion mirror. Writes happen exclusively
// via the tasksBackfill + tasksDelta sync pair (gist as upstream).
// Primary key is the kanban task ID (task_id: t_...).
const tasks = worker.database("tasks", {
	type: "managed",
	initialTitle: "Hermes Tasks",
	primaryKeyProperty: "task_id",
	schema: {
		properties: {
			Name: Schema.title(),
			task_id: Schema.richText(),
			board_slug: Schema.richText(),
			status: Schema.select([
				{ name: "todo" },
				{ name: "running" },
				{ name: "blocked" },
				{ name: "done" },
				{ name: "cancelled" },
				{ name: "archived" },
			]),
			assignee: Schema.richText(),
			body: Schema.richText(),
			parents: Schema.richText(),
			children: Schema.richText(),
			created_at: Schema.date(),
			updated_at: Schema.date(),
			latest_summary: Schema.richText(),
			// Two-way relation to the projects DB.
			// Renamed to `parent_project` (was `project`) to force the Workers
			// platform to recreate a fresh dual relation pointed at the current
			// tasks data source — a previous stale `Tasks` back-relation got
			// pinned to a now-abandoned tasks DS and wouldn't auto-migrate.
			parent_project: Schema.relation("projects", {
				twoWay: true,
				relatedPropertyName: "kanban_tasks",
			}),
		},
	},
});

// ── Constants ──────────────────────────────────────────────────────
// Discord guild and category IDs (verified 2026-05-15)
const GUILD_ID = "000000000000000001"; // AGENTIC-OS council guild
const PROJECTS_CATEGORY_ID = "000000000000000002"; // PROJECTS category
const ARCHIVE_CATEGORY_ID = "000000000000000015"; // ARCHIVE category

// ── Kanban ↔ Discord-channel binding table ──────────────────────────
// Maps kanban board slug → discord_channel_id of the project that owns it.
// Used by:
//   - projectsFromDiscord: to populate `kanban_board_slug` on the project row.
//   - tasksDelta: to resolve a task's `board_slug` to its project page (for
//     the two-way `project` relation).
//
// To add a new binding: append here and `ntn workers deploy`. The next
// sync tick picks it up; run `ntn workers sync trigger tasksBackfill`
// once if you want the relation written on all existing rows immediately.
const BOARD_TO_CHANNEL: Record<string, string> = {
	"hermes-projects-sync": "000000000000000014",
};

const CHANNEL_TO_BOARD: Record<string, string> = Object.fromEntries(
	Object.entries(BOARD_TO_CHANNEL).map(([slug, ch]) => [ch, slug])
);

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
		const changes = projectChannels.map((channel) => {
			const isArchived = channel.parent_id === ARCHIVE_CATEGORY_ID;
			const slug = CHANNEL_TO_BOARD[channel.id];
			const props: Record<string, any> & { discord_channel_id: ReturnType<typeof Builder.richText> } = {
				Name: Builder.title(channel.name),
				discord_channel_id: Builder.richText(channel.id),
				discord_topic: Builder.richText(channel.topic || ""),
				discord_category_id: Builder.richText(channel.parent_id || ""),
				discord_archived: Builder.checkbox(isArchived),
			};
			// Auto-bind kanban_board_slug from the static binding table.
			// Writing here is safe because the field is only set when this
			// channel has a known board mapping — other channels leave it untouched.
			if (slug) {
				props.kanban_board_slug = Builder.richText(slug);
			}

			// Derive project status:
			//   - Archived Discord channels → "Cancelled"
			//   - Channel with a kanban board binding → "In progress"
			//   - Otherwise → "Backlog"
			// NOTE: This is a coarse heuristic. Fine-grained status
			// (Done, Paused, Planning) requires kanban board introspection
			// which the deployed worker can't do. Override manually in Notion
			// or via a future status-sync capability.
			if (isArchived) {
				props.status = Builder.select("Cancelled");
			} else if (slug) {
				props.status = Builder.select("In progress");
			} else {
				props.status = Builder.select("Backlog");
			}

			return {
				type: "upsert" as const,
				key: channel.id,
				properties: props,
			};
			// NOTE: We still omit kanban_task_ids and notes —
			// those are Notion-owned and must not be modified by this sync.
		});

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


// Tool: bindProjectToBoard
// One-shot: populates kanban_board_slug on the project row and re-links
// every task row in the board to the project via the `project` relation.
worker.tool("bindProjectToBoard", {
	title: "Bind Project to Kanban Board",
	description:
		"Populate kanban_board_slug on a project row and auto-relate all tasks " +
		"in that board to the project. Use after initial board creation or when " +
		"the binding drifts. Overwrites existing project relations on task rows.",
	schema: j.object({
		discord_channel_id: j
			.string()
			.describe("Discord channel ID identifying the project row"),
		board_slug: j
			.string()
			.describe("The kanban board slug to bind (e.g. 'hermes-projects-sync')"),
	}),
	outputSchema: j.object({
		ok: j.boolean(),
		project_page_id: j.string().nullable(),
		tasks_relinked: j.number().nullable(),
		error: j.string().nullable(),
	}),
	hints: { readOnlyHint: false },
	execute: async ({ discord_channel_id, board_slug }, { notion }) => {
		const notionToken = process.env.NOTION_API_TOKEN;
		const projectsDatabaseId = process.env.NOTION_PROJECTS_DATABASE_ID;
		const tasksDatabaseId = process.env.NOTION_TASKS_DATABASE_ID;

		if (!notionToken) {
			return { ok: false, project_page_id: null, tasks_relinked: null, error: "NOTION_API_TOKEN not configured" };
		}
		if (!projectsDatabaseId) {
			return { ok: false, project_page_id: null, tasks_relinked: null, error: "NOTION_PROJECTS_DATABASE_ID not configured" };
		}
		if (!tasksDatabaseId) {
			return { ok: false, project_page_id: null, tasks_relinked: null, error: "NOTION_TASKS_DATABASE_ID not configured" };
		}

		const notionHeaders = {
			Authorization: `Bearer ${notionToken}`,
			"Content-Type": "application/json",
			"Notion-Version": "2026-02-15",
		};

		try {
			// Step 1: Query projects DB for the row matching discord_channel_id -> get page ID.
			const projectQueryRes = await fetch(
				`https://api.notion.com/v1/databases/${projectsDatabaseId}/query`,
				{
					method: "POST",
					headers: notionHeaders,
					body: JSON.stringify({
						filter: {
							property: "discord_channel_id",
							rich_text: { equals: discord_channel_id },
						},
					}),
				}
			);

			if (!projectQueryRes.ok) {
				return {
					ok: false,
					project_page_id: null,
					tasks_relinked: null,
					error: `Projects DB query failed: ${projectQueryRes.status} ${await projectQueryRes.text()}`,
				};
			}

			const projectData = (await projectQueryRes.json()) as any;
			if (!projectData.results || projectData.results.length === 0) {
				return {
					ok: false,
					project_page_id: null,
					tasks_relinked: null,
					error: `No project row found with discord_channel_id=${discord_channel_id}`,
				};
			}

			const projectPageId = projectData.results[0].id as string;

			// Step 2: PATCH the project page with kanban_board_slug = board_slug.
			const patchProjectRes = await fetch(
				`https://api.notion.com/v1/pages/${projectPageId}`,
				{
					method: "PATCH",
					headers: notionHeaders,
					body: JSON.stringify({
						properties: {
							kanban_board_slug: {
								rich_text: [{ text: { content: board_slug } }],
							},
						},
					}),
				}
			);

			if (!patchProjectRes.ok) {
				return {
					ok: false,
					project_page_id: projectPageId,
					tasks_relinked: null,
					error: `Failed to patch project kanban_board_slug: ${patchProjectRes.status} ${await patchProjectRes.text()}`,
				};
			}

			// Step 3: Query tasks DB for ALL rows where board_slug == input.board_slug.
			// Paginate in case there are >100 tasks.
			const taskPages: any[] = [];
			let hasMore = true;
			let startCursor: string | undefined;

			while (hasMore) {
				const body: any = {
					filter: {
						property: "board_slug",
						rich_text: { equals: board_slug },
					},
					page_size: 100,
				};
				if (startCursor) body.start_cursor = startCursor;

				const tasksQueryRes = await fetch(
					`https://api.notion.com/v1/databases/${tasksDatabaseId}/query`,
					{
						method: "POST",
						headers: notionHeaders,
						body: JSON.stringify(body),
					}
				);

				if (!tasksQueryRes.ok) {
					return {
						ok: false,
						project_page_id: projectPageId,
						tasks_relinked: null,
						error: `Tasks DB query failed: ${tasksQueryRes.status} ${await tasksQueryRes.text()}`,
					};
				}

				const tasksData = (await tasksQueryRes.json()) as any;
				taskPages.push(...(tasksData.results ?? []));
				hasMore = tasksData.has_more ?? false;
				startCursor = tasksData.next_cursor ?? undefined;
			}

			// Step 4: For each task row, PATCH its project relation to point at the project page.
			let relinked = 0;
			for (const taskPage of taskPages) {
				const patchTaskRes = await fetch(
					`https://api.notion.com/v1/pages/${taskPage.id}`,
					{
						method: "PATCH",
						headers: notionHeaders,
						body: JSON.stringify({
							properties: {
								project: {
									relation: [{ id: projectPageId }],
								},
							},
						}),
					}
				);

				if (patchTaskRes.ok) {
					relinked++;
				} else {
					// Log but continue - partial success is better than aborting.
					console.warn(
						`bindProjectToBoard: failed to patch task ${taskPage.id}: ${patchTaskRes.status}`
					);
				}
			}

			return {
				ok: true,
				project_page_id: projectPageId,
				tasks_relinked: relinked,
				error: null,
			};
		} catch (err) {
			return {
				ok: false,
				project_page_id: null,
				tasks_relinked: null,
				error: `Exception: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	},
});


// ── Helpers for gist-backed task syncs ──────────────────────────────
type GistTask = {
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
};

type GistSnapshot = {
	version: number;
	board: string;
	generated_at: string;
	tasks: GistTask[];
};

function truncate(text: string | null | undefined, max = 2000): string {
	if (!text) return "";
	return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

async function fetchGistSnapshot(): Promise<GistSnapshot> {
	const gistUrl = process.env.KANBAN_GIST_URL;
	const githubToken = process.env.GITHUB_TOKEN;
	if (!gistUrl) throw new Error("KANBAN_GIST_URL not configured");
	if (!githubToken) throw new Error("GITHUB_TOKEN not configured");

	await githubPacer.wait();
	const res = await fetch(gistUrl, {
		headers: {
			Authorization: `token ${githubToken}`,
			Accept: "application/json",
		},
	});
	if (!res.ok) {
		throw new Error(`Gist fetch failed: ${res.status} ${res.statusText}`);
	}
	return (await res.json()) as GistSnapshot;
}

function taskToChange(t: GistTask) {
	const isGcd = t["gc'd"] === true;
	const channelId = BOARD_TO_CHANNEL[t.board_slug];
	return {
		type: "upsert" as const,
		key: t.task_id,
		properties: {
			Name: Builder.title(t.name),
			task_id: Builder.richText(t.task_id),
			board_slug: Builder.richText(t.board_slug),
			status: Builder.select(isGcd ? "archived" : t.status),
			assignee: Builder.richText(t.assignee ?? ""),
			body: Builder.richText(truncate(t.body)),
			parents: Builder.richText(t.parents.join(",")),
			children: Builder.richText(t.children.join(",")),
			created_at: Builder.date(t.created_at.slice(0, 10)),
			updated_at: Builder.date(t.updated_at.slice(0, 10)),
			latest_summary: Builder.richText(
				isGcd && !t.latest_summary
					? "tombstoned: kanban gc"
					: truncate(t.latest_summary)
			),
			// parent_project relation (renamed from `project` mid-build to force fresh dual relation).
			parent_project: channelId ? [Builder.relation(channelId)] : [],
		},
	};
}

// ── Sync: tasksBackfill ──────────────────────────────────────────────
// Replace-mode, manual trigger. Drains the full gist snapshot into the
// tasks DB. Run manually to recover from drift, backfill new properties,
// or sweep tombstones the delta path may have missed.
worker.sync("tasksBackfill", {
	database: tasks,
	mode: "replace",
	schedule: "manual",
	execute: async () => {
		const snapshot = await fetchGistSnapshot();
		if (!snapshot.tasks || snapshot.tasks.length < 1) {
			console.warn("tasksBackfill: empty gist — aborting to avoid mass-delete.");
			return { changes: [], hasMore: false };
		}
		return {
			changes: snapshot.tasks.map(taskToChange),
			hasMore: false,
		};
	},
});

// ── Sync: tasksDelta ─────────────────────────────────────────────────
// Incremental, 1m schedule. Filters to tasks whose updated_at > last
// snapshot generated_at we processed. Upserts only — deletes are
// handled out-of-band by tasksBackfill.
worker.sync("tasksDelta", {
	database: tasks,
	mode: "incremental",
	schedule: "1m",
	execute: async (state) => {
		const snapshot = await fetchGistSnapshot();
		if (!snapshot.tasks || snapshot.tasks.length < 1) {
			return { changes: [], hasMore: false };
		}
		const lastSeen = (state as { last_generated_at?: string } | undefined)
			?.last_generated_at;
		const changed = lastSeen
			? snapshot.tasks.filter((t) => t.updated_at > lastSeen)
			: snapshot.tasks;
		return {
			changes: changed.map(taskToChange),
			hasMore: false,
			nextState: { last_generated_at: snapshot.generated_at },
		};
	},
});