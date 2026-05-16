import { worker } from "./worker.js";
import { loadRawConfig, validateBoardChannelMap } from "./boardChannelMap.js";

// Pull in database + pacer declarations (side-effect: registers with worker).
import "./databases.js";
import "./pacers.js";
// Pull in the binding lookup tables (side-effect: parses board_channel_map.yaml).
import "./bindings.js";

// Per-capability registration modules.
import { register as registerProjectsFromDiscord } from "./syncs/projectsFromDiscord.js";
import { register as registerTasksBackfill } from "./syncs/tasksBackfill.js";
import { register as registerTasksDelta } from "./syncs/tasksDelta.js";
import { register as registerRenameProjectChannel } from "./tools/renameProjectChannel.js";
import { register as registerArchiveProject } from "./tools/archiveProject.js";
import { register as registerUnarchiveProject } from "./tools/unarchiveProject.js";
import { register as registerRebindByChannelId } from "./tools/rebindByChannelId.js";
import { register as registerBindProjectToBoard } from "./tools/bindProjectToBoard.js";
import { register as registerUpsertTask } from "./tools/upsertTask.js";
import { register as registerTombstoneTask } from "./tools/tombstoneTask.js";
import { register as registerKanbanEvent } from "./webhooks/kanbanEvent.js";

// ── Strict-boot guard: validate board_channel_map.yaml against Discord ──
// Loads the raw config and verifies every channel ID resolves via the
// Discord API. Entries marked `required: true` cause boot to fail loudly
// when validation rejects them. Entries without `required` only emit
// warnings. Skipped when DISCORD_BOT_TOKEN is unset (e.g. local schema-only
// builds) so dev environments aren't blocked.
try {
	const rawConfig = loadRawConfig();
	const discordToken = process.env.DISCORD_BOT_TOKEN;
	if (discordToken) {
		// Fire-and-throw: validateBoardChannelMap is async but module load
		// is synchronous in CJS. Surfacing failures as an unhandled rejection
		// terminates the process so deploys fail loudly on bad config.
		validateBoardChannelMap(rawConfig, discordToken).catch((err) => {
			console.error(
				`[boot] validateBoardChannelMap failed: ${err instanceof Error ? err.message : String(err)}`
			);
			throw err;
		});
	} else {
		console.warn(
			"[boot] DISCORD_BOT_TOKEN not set — skipping board_channel_map validation"
		);
	}
} catch (err) {
	console.error(
		`[boot] board_channel_map validation could not start: ${err instanceof Error ? err.message : String(err)}`
	);
	throw err;
}

// ── Register every capability against the shared Worker ─────────────
registerProjectsFromDiscord(worker);
registerTasksBackfill(worker);
registerTasksDelta(worker);
registerRenameProjectChannel(worker);
registerArchiveProject(worker);
registerUnarchiveProject(worker);
registerRebindByChannelId(worker);
registerBindProjectToBoard(worker);
registerUpsertTask(worker);
registerTombstoneTask(worker);
registerKanbanEvent(worker);

export default worker;
