import { Worker } from "@notionhq/workers";
import { verifyKanbanSignature } from "../lib/hmac.js";
import {
	GistTask,
	tombstoneTaskViaNotion,
	upsertTaskViaNotion,
} from "../lib/notionHelpers.js";

// ── Webhook: kanbanEvent ──────────────────────────────────────────────
// Receives real-time kanban task events from the local shell hook.
// Upserts or tombstones individual task rows in the Notion tasks DB
// using context.notion (direct API writes, NOT managed DB writes).
// This path provides <5s kanban→Notion latency, replacing the 15m gist
// + 1m delta polling chain for steady-state updates.
//
// Payload shape (sent by local hook):
//   { event_type: "upsert"|"tombstone"|"bulk_upsert",
//     kanban_id: string,
//     board_slug: string,
//     task_payload?: GistTask,       // present for upsert
//     tasks?: GistTask[],            // present for bulk_upsert
//     signature: string }            // HMAC-SHA256 hex of rawBody
//
// The gist publisher + tasksDelta sync remain as fallback/drift-correction
// until card 4.5 decommissions them.
export function register(worker: Worker) {
	worker.webhook("kanbanEvent", {
		title: "Kanban Event Webhook",
		description:
			"Receives real-time kanban task events (upsert/tombstone) from the local " +
			"shell hook. Verifies HMAC signature, then writes directly to the Notion " +
			"tasks database via context.notion. Provides <5s kanban→Notion latency.",
		execute: async (events, { notion }) => {
			const tasksDatabaseId = process.env.TASKS_DATABASE_ID;
			const tasksDataSourceId = process.env.TASKS_DATA_SOURCE_ID;
			if (!tasksDatabaseId || !tasksDataSourceId) {
				throw new Error("TASKS_DATABASE_ID / TASKS_DATA_SOURCE_ID not configured");
			}

			for (const event of events) {
				// Step 1: Verify HMAC signature
				verifyKanbanSignature(event.rawBody, event.headers);

				// Step 2: Parse and validate payload
				const payload = event.body as {
					event_type?: string;
					kanban_id?: string;
					board_slug?: string;
					task_payload?: GistTask;
					tasks?: GistTask[];
					signature?: string;
				};

				const eventType = payload.event_type;
				if (!eventType) {
					throw new Error("Missing event_type in webhook payload");
				}

				// Step 3: Dispatch based on event_type
				const results: Array<{
					action: string;
					task_id: string;
				}> = [];

				switch (eventType) {
					case "upsert": {
						if (!payload.task_payload) {
							throw new Error(
								"Missing task_payload for upsert event",
							);
						}
						const result = await upsertTaskViaNotion(
							notion,
							tasksDatabaseId,
							tasksDataSourceId,
							payload.task_payload,
						);
						results.push(result);
						console.log(
							`kanbanEvent: ${result.action} task ${result.task_id}`,
						);
						break;
					}

					case "tombstone": {
						if (!payload.kanban_id) {
							throw new Error(
								"Missing kanban_id for tombstone event",
							);
						}
						const result = await tombstoneTaskViaNotion(
							notion,
							tasksDataSourceId,
							payload.kanban_id,
						);
						results.push(result);
						console.log(
							`kanbanEvent: ${result.action} task ${result.task_id}`,
						);
						break;
					}

					case "bulk_upsert": {
						if (
							!payload.tasks ||
							!Array.isArray(payload.tasks) ||
							payload.tasks.length === 0
						) {
							throw new Error(
								"Missing or empty tasks array for bulk_upsert event",
							);
						}
						for (const task of payload.tasks) {
							const result = await upsertTaskViaNotion(
								notion,
								tasksDatabaseId,
								tasksDataSourceId,
								task,
							);
							results.push(result);
							console.log(
								`kanbanEvent: ${result.action} task ${result.task_id}`,
							);
						}
						break;
					}

					default:
						throw new Error(`Unknown event_type: ${eventType}`);
				}

				console.log(
					`kanbanEvent: processed ${results.length} task(s) for delivery ${event.deliveryId}`,
				);
			}
		},
	});
}
