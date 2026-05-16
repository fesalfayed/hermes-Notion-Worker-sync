import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import { projects } from "../databases.js";
import { discordPacer } from "../pacers.js";
import {
	GUILD_ID,
	PROJECTS_CATEGORY_ID,
	ARCHIVE_CATEGORY_ID,
} from "../constants.js";
import { CHANNEL_TO_BOARD } from "../bindings.js";

// ── Sync: projectsFromDiscord ───────────────────────────────────────
// Replace-mode sync that fetches Discord PROJECTS category channels and
// writes them into the Notion projects database. Channels removed from Discord
// are mark-and-swept (deleted from Notion).
export function register(worker: Worker) {
	worker.sync("projectsFromDiscord", {
		database: projects,
		mode: "replace",
		schedule: "5m",
		execute: async (_state) => {
			const discordToken = process.env.DISCORD_BOT_TOKEN;
			if (!discordToken) {
				throw new Error("DISCORD_BOT_TOKEN not configured");
			}

			// Fetch all guild channels
			await discordPacer.wait();
			const channelsUrl = `https://discord.com/api/v10/guilds/${GUILD_ID}/channels`;
			const channelsRes = await fetch(channelsUrl, {
				method: "GET",
				headers: {
					Authorization: `Bot ${discordToken}`,
					"Content-Type": "application/json",
				},
			});

			if (!channelsRes.ok) {
				throw new Error(
					`Discord API error: ${channelsRes.status} ${channelsRes.statusText}`
				);
			}

			const allChannels = (await channelsRes.json()) as any[];

			// Filter to PROJECTS and ARCHIVE categories
			const projectChannels = allChannels.filter(
				(ch) =>
					ch.parent_id === PROJECTS_CATEGORY_ID ||
					ch.parent_id === ARCHIVE_CATEGORY_ID
			);

			// Guard: if we get fewer than 1 channel, abort to avoid mark-and-sweep deletes
			// on transient Discord API issues.
			if (projectChannels.length < 1) {
				throw new Error(
					`Discord returned ${projectChannels.length} project channels (expected ≥1). ` +
						`Aborting to prevent accidental mark-and-sweep deletes.`
				);
			}

			// Convert each channel to a Notion upsert record
			const changes = projectChannels.map((channel) => {
				const isArchived = channel.parent_id === ARCHIVE_CATEGORY_ID;
				const slug = CHANNEL_TO_BOARD[channel.id];
				const props: Record<string, any> & { discord_channel_id: ReturnType<typeof Builder.richText> } = {
					Name: Builder.title(channel.name),
					discord_channel_id: Builder.richText(channel.id),
					discord_topic: Builder.richText(channel.topic || ""),
					discord_category_id: Builder.richText(channel.parent_id || ""),
					discord_archived: Builder.checkbox(isArchived),
				};
				// Auto-bind kanban_board_slug from the static binding table.
				// Writing here is safe because the field is only set when this
				// channel has a known board mapping — other channels leave it untouched.
				if (slug) {
					props.kanban_board_slug = Builder.richText(slug);
				}

				// Derive project status:
				//   - Archived Discord channels → "Cancelled"
				//   - Channel with a kanban board binding → "In progress"
				//   - Otherwise → "Backlog"
				// NOTE: This is a coarse heuristic. Fine-grained status
				// (Done, Paused, Planning) requires kanban board introspection
				// which the deployed worker can't do. Override manually in Notion
				// or via a future status-sync capability.
				if (isArchived) {
					props.status = Builder.select("Cancelled");
				} else if (slug) {
					props.status = Builder.select("In progress");
				} else {
					props.status = Builder.select("Backlog");
				}

				return {
					type: "upsert" as const,
					key: channel.id,
					properties: props,
				};
				// NOTE: We still omit kanban_task_ids and notes —
				// those are Notion-owned and must not be modified by this sync.
			});

			return {
				changes,
				hasMore: false,
			};
		},
	});
}
