import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import { tombstoneTaskViaNotion } from "../lib/notionHelpers.js";

// Tool: tombstoneTask
// Manual override: mark a task as archived in the Notion tasks DB,
// bypassing the gist→sync pipeline. Uses context.notion (pre-authenticated
// when invoked via Custom Agent).
export function register(worker: Worker) {
	worker.tool("tombstoneTask", {
		title: "Archive (tombstone) a task",
		description:
			"Mark a task as archived in the Notion tasks database. Use when someone says " +
			"'remove task X' or 'tombstone task Y'. This sets the task's status to 'archived' " +
			"directly in Notion, bypassing the normal gist sync.",
		schema: j.object({
			task_id: j.string().describe("The kanban task ID to tombstone (e.g. 't_abcd1234')."),
		}),
		outputSchema: j.object({
			ok: j.boolean(),
			action: j.string().nullable(),
			task_id: j.string().nullable(),
			error: j.string().nullable(),
		}),
		hints: { readOnlyHint: false },
		execute: async ({ task_id }, { notion }) => {
			const tasksDatabaseId = process.env.TASKS_DATABASE_ID;
			const tasksDataSourceId = process.env.TASKS_DATA_SOURCE_ID;

			if (!tasksDatabaseId || !tasksDataSourceId) {
				return { ok: false, action: null, task_id: null, error: "TASKS_DATABASE_ID / TASKS_DATA_SOURCE_ID not configured" };
			}

			try {
				const result = await tombstoneTaskViaNotion(notion, tasksDataSourceId, task_id);
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
					task_id: task_id,
					error: `Exception: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		},
	});
}
