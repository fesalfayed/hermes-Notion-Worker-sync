import { Worker } from "@notionhq/workers";
import { tasks } from "../databases.js";
import {
	buildTombstoneChanges,
	fetchGistSnapshot,
	taskToChange,
} from "../lib/notionHelpers.js";

// ── Sync: tasksDelta ─────────────────────────────────────────────────
// Incremental, 1m schedule. Filters to tasks whose updated_at > last
// snapshot generated_at we processed, then tombstones Notion rows that
// are absent from the snapshot (within the same cycle).
//
// Tombstone guarantees:
//   - Multi-board safety: only considers Notion rows whose board_slug
//     matches the snapshot's board field.
//   - Idempotency: only queries non-archived rows, so re-running after
//     a tombstone is a no-op (no status flap, no write churn).
//   - Defensive: if the Notion query fails or credentials are missing,
//     tombstoning is skipped — upserts still proceed normally.
//   - Empty snapshot guard: if the gist returns 0 tasks, the cycle
//     returns early with no changes — it does NOT tombstone everything.
export function register(worker: Worker) {
	worker.sync("tasksDelta", {
		database: tasks,
		mode: "incremental",
		schedule: "1m",
		execute: async (state) => {
			const snapshot = await fetchGistSnapshot();
			if (!snapshot.tasks || snapshot.tasks.length < 1) {
				// Empty or missing snapshot — return no changes.
				// IMPORTANT: do NOT tombstone here. An empty snapshot likely means
				// the gist publisher hasn't run yet or the fetch returned stale data.
				// Treating "0 tasks" as "delete everything" would be catastrophic.
				return { changes: [], hasMore: false };
			}
			const lastSeen = (state as { last_generated_at?: string } | undefined)
				?.last_generated_at;
			const changed = lastSeen
				? snapshot.tasks.filter((t) => t.updated_at > lastSeen)
				: snapshot.tasks;

			// Upsert pass: normal delta changes
			const upsertChanges = changed.map(taskToChange);

			// Tombstone pass: find Notion rows absent from the full snapshot
			// and mark them archived. Runs every cycle for consistency.
			const tombstoneChanges = await buildTombstoneChanges(snapshot);

			return {
				changes: [...upsertChanges, ...tombstoneChanges],
				hasMore: false,
				nextState: { last_generated_at: snapshot.generated_at },
			};
		},
	});
}
