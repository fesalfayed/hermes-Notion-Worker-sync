import { Worker } from "@notionhq/workers";
import { tasks } from "../databases.js";
import { fetchGistSnapshot, taskToChange } from "../lib/notionHelpers.js";

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
			return {
				changes: snapshot.tasks.map(taskToChange),
				hasMore: false,
			};
		},
	});
}
