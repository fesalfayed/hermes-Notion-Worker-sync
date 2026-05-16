import * as Schema from "@notionhq/workers/schema";
import { worker } from "./worker.js";

// ── Managed database: Hermes Projects ──────────────────────────────
// Bidirectional sync target for Discord channels ↔ Notion rows.
// Primary key is the Discord channel snowflake (discord_channel_id).
export const projects = worker.database("projects", {
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
export const tasks = worker.database("tasks", {
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
