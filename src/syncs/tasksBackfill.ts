import { Worker } from "@notionhq/workers";
import { tasks } from "../databases.js";
import {
	fetchGistSnapshot,
	resolveBoardChannelMap,
	taskToChange,
} from "../lib/notionHelpers.js";

// ── Sync: tasksBackfill ──────────────────────────────────────────────
// Replace-mode, manual trigger. Drains the full gist snapshot into the
// tasks DB. Run manually to recover from drift, backfill new properties,
// or sweep tombstones the delta path may have missed.
export function register(worker: Worker) {
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
			const boardMap = await resolveBoardChannelMap(snapshot);
			// Only sync tasks with a resolved channel — parent_project cannot be empty.
			const mappedTasks = snapshot.tasks.filter((t) => boardMap[t.board_slug]);
			if (mappedTasks.length < 1) {
				console.warn("tasksBackfill: no tasks with valid board mapping — aborting.");
				return { changes: [], hasMore: false };
			}
			return {
				changes: mappedTasks.map((t) => taskToChange(t, boardMap)),
				hasMore: false,
			};
		},
	});
}
