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
import { fetchGistSnapshot } from "../lib/notionHelpers.js";

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

			// Runtime board auto-discovery: pull the gist snapshot to learn which
			// kanban boards exist right now. Any project channel whose `name`
			// equals an active board_slug is auto-promoted to "In progress" with
			// `kanban_board_slug` populated — no YAML edit or redeploy required.
			// This is what makes new project channels work out of the box.
			//
			// Falls back gracefully: if the gist is unreachable, we still honor
			// the static YAML map (CHANNEL_TO_BOARD), so bootstrap-time bindings
			// continue to work even if the host publisher is down.
			const activeBoardSlugs = new Set<string>();
			try {
				const snapshot = await fetchGistSnapshot();
				const slugs = snapshot.boards ?? [snapshot.board].filter(Boolean) as string[];
				for (const s of slugs) activeBoardSlugs.add(s);
				// Also union in slugs observed in tasks (defensive: snapshot.boards
				// is the publisher's declared set; tasks[].board_slug is ground truth).
				for (const t of snapshot.tasks ?? []) {
					if (t.board_slug) activeBoardSlugs.add(t.board_slug);
				}
			} catch (err: any) {
				console.warn(
					`projectsFromDiscord: gist snapshot fetch failed — falling back to ` +
						`static YAML bindings only: ${err.message ?? err}`,
				);
			}

			// Convert each channel to a Notion upsert record
			const changes = projectChannels.map((channel) => {
				const isArchived = channel.parent_id === ARCHIVE_CATEGORY_ID;
				// Slug resolution order:
				//   1. Static YAML binding (CHANNEL_TO_BOARD[channel.id]) —
				//      explicit override, useful when slug ≠ channel name.
				//   2. Runtime auto-discovery — channel name equals an active
				//      kanban board slug. Documented convention: slug == name.
				const staticSlug = CHANNEL_TO_BOARD[channel.id];
				const autoSlug = activeBoardSlugs.has(channel.name) ? channel.name : undefined;
				const slug = staticSlug ?? autoSlug;
				const props: Record<string, any> & { discord_channel_id: ReturnType<typeof Builder.richText> } = {
					Name: Builder.title(channel.name),
					discord_channel_id: Builder.richText(channel.id),
					discord_topic: Builder.richText(channel.topic || ""),
					discord_category_id: Builder.richText(channel.parent_id || ""),
					discord_archived: Builder.checkbox(isArchived),
				};
				// Auto-bind kanban_board_slug from the static binding table OR
				// runtime auto-discovery. Channels with no matching kanban board
				// leave the field untouched (NOT populated).
				if (slug) {
					props.kanban_board_slug = Builder.richText(slug);
				}

				// Derive project status:
				//   - Archived Discord channels → "Cancelled"
				//   - Channel with a kanban board binding (static OR auto) → "In progress"
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
