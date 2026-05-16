import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import { ARCHIVE_CATEGORY_ID, PROJECTS_CATEGORY_ID } from "../constants.js";

// Tool: unarchiveProject
// Moves a Discord channel from ARCHIVE category to PROJECTS category.
export function register(worker: Worker) {
	worker.tool("unarchiveProject", {
		title: "Unarchive a project",
		description: "Bring a project back from the archive by moving its Discord channel back to the active PROJECTS category. Use when someone says 'unarchive project X'.",
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
}
