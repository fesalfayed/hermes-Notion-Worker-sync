import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

// Tool: renameProjectChannel
// Renames a Discord channel. Propagates a name change from Notion → Discord.
export function register(worker: Worker) {
	worker.tool("renameProjectChannel", {
		title: "Rename a project's Discord channel",
		description:
			"Rename a project's Discord channel. Use when someone says 'rename project X to Y' — this changes the Discord channel name to match.",
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
}
