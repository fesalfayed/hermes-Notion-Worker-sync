import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import { GistTask, upsertTaskViaNotion } from "../lib/notionHelpers.js";

// Tool: upsertTask
// Manual override: create or update a single task row in the Notion tasks DB,
// bypassing the gist→sync pipeline. Uses context.notion (pre-authenticated
// when invoked via Custom Agent).
export function register(worker: Worker) {
	worker.tool("upsertTask", {
		title: "Create or update a task",
		description:
			"Manually create or update a task in the Notion tasks database. Use when someone says " +
			"'add task X' or 'update task Y's status to Z'. This writes directly to Notion, " +
			"bypassing the normal gist sync — handy for one-off corrections or urgent updates.",
		schema: j.object({
			task_id: j.string().describe("The kanban task ID (e.g. 't_abcd1234'). Used as the primary key."),
			name: j.string().describe("Task title / name."),
			board_slug: j.string().describe("The kanban board slug (e.g. 'hermes-projects-sync')."),
			status: j
				.enum("todo", "running", "blocked", "done", "cancelled", "archived")
				.describe("Task status."),
			assignee: j.string().nullable().describe("Profile name of the assignee, or null."),
			body: j.string().nullable().describe("Task body / description (truncated to 2000 chars). Null to leave empty."),
			parents: j.string().nullable().describe("Comma-separated parent task IDs, or null."),
			children: j.string().nullable().describe("Comma-separated child task IDs, or null."),
			latest_summary: j.string().nullable().describe("Most recent run summary, or null."),
		}),
		outputSchema: j.object({
			ok: j.boolean(),
			action: j.string().nullable(),
			task_id: j.string().nullable(),
			error: j.string().nullable(),
		}),
		hints: { readOnlyHint: false },
		execute: async (input, { notion }) => {
			const tasksDatabaseId = process.env.TASKS_DATABASE_ID;
			const tasksDataSourceId = process.env.TASKS_DATA_SOURCE_ID;

			if (!tasksDatabaseId || !tasksDataSourceId) {
				return { ok: false, action: null, task_id: null, error: "TASKS_DATABASE_ID / TASKS_DATA_SOURCE_ID not configured" };
			}

			try {
				const now = new Date().toISOString();
				const gistTask: GistTask = {
					task_id: input.task_id,
					name: input.name,
					board_slug: input.board_slug,
					status: input.status,
					assignee: input.assignee ?? null,
					body: input.body ?? "",
					parents: input.parents ? input.parents.split(",").map((s: string) => s.trim()).filter(Boolean) : [],
					children: input.children ? input.children.split(",").map((s: string) => s.trim()).filter(Boolean) : [],
					created_at: now,
					updated_at: now,
					latest_summary: input.latest_summary ?? null,
				};

				const result = await upsertTaskViaNotion(notion, tasksDatabaseId, tasksDataSourceId, gistTask);
				return {
					ok: true,
					action: result.action,
					task_id: result.task_id,
					error: null,
				};
			} catch (err) {
				return {
					ok: false,
					action: null,
					task_id: input.task_id,
					error: `Exception: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		},
	});
}
