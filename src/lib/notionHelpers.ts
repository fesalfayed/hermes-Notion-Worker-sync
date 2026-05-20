import * as Builder from "@notionhq/workers/builder";
import { BOARD_TO_CHANNEL } from "../bindings.js";
import { githubPacer } from "../pacers.js";

// ── Helpers for gist-backed task syncs ──────────────────────────────
export type GistTask = {
	task_id: string;
	board_slug: string;
	name: string;
	status: string;
	assignee: string | null;
	body: string;
	parents: string[];
	children: string[];
	created_at: string;
	updated_at: string;
	latest_summary: string | null;
	"gc'd"?: boolean;
};

export type GistSnapshot = {
	version: number;
	/** v2: list of board_slugs included in this snapshot. v1: single `board` field. */
	boards?: string[];
	board?: string;
	generated_at: string;
	tasks: GistTask[];
};

/**
 * Resolve board_slug → discord_channel_id for every board present in the
 * snapshot. Strategy:
 *   1. Start with the static BOARD_TO_CHANNEL map (loaded from YAML at boot).
 *   2. For every board_slug NOT in the static map, query the Notion projects
 *      DB by Name == board_slug. If a row exists, its `discord_channel_id`
 *      (the primaryKey) is the binding.
 * This makes new Discord channels auto-bind their kanban boards to Notion
 * with zero YAML edits or worker redeploys.
 */
export async function resolveBoardChannelMap(
	snapshot: GistSnapshot,
): Promise<Record<string, string>> {
	const map: Record<string, string> = { ...BOARD_TO_CHANNEL };

	const allSlugs = new Set(
		(snapshot.boards ?? [snapshot.board].filter(Boolean) as string[]).concat(
			snapshot.tasks.map((t) => t.board_slug),
		),
	);
	const unresolved = [...allSlugs].filter((s) => s && !map[s]);
	if (unresolved.length === 0) return map;

	const notionToken = process.env.NOTION_API_TOKEN;
	const projectsDataSourceId = process.env.PROJECTS_DATA_SOURCE_ID;
	if (!notionToken || !projectsDataSourceId) {
		// Without credentials we can only honour the static YAML map.
		console.warn(
			`board-resolver: NOTION_API_TOKEN or PROJECTS_DATA_SOURCE_ID not set — ` +
				`cannot auto-bind boards: ${unresolved.join(", ")}`,
		);
		return map;
	}

	const headers = {
		Authorization: `Bearer ${notionToken}`,
		"Content-Type": "application/json",
		"Notion-Version": "2025-09-03",
	};

	for (const slug of unresolved) {
		try {
			const res = await fetch(
				`https://api.notion.com/v1/data_sources/${projectsDataSourceId}/query`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						filter: { property: "Name", title: { equals: slug } },
						page_size: 1,
					}),
				},
			);
			if (!res.ok) continue;
			const data = (await res.json()) as any;
			const page = data.results?.[0];
			if (!page) continue;
			const channelId =
				page.properties?.discord_channel_id?.rich_text?.[0]?.plain_text;
			if (channelId) {
				map[slug] = channelId;
				console.log(`board-resolver: auto-bound ${slug} → ${channelId}`);
			}
		} catch (err: any) {
			console.warn(
				`board-resolver: lookup failed for ${slug}: ${err.message ?? err}`,
			);
		}
	}

	return map;
}

export function truncate(text: string | null | undefined, max = 2000): string {
	if (!text) return "";
	return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

export async function fetchGistSnapshot(): Promise<GistSnapshot> {
	const rawGist = process.env.KANBAN_GIST_URL ?? process.env.KANBAN_TASKS_GIST_ID;
	const githubToken = process.env.GITHUB_TOKEN;
	if (!rawGist) throw new Error("KANBAN_TASKS_GIST_ID (or KANBAN_GIST_URL) not configured");
	if (!githubToken) throw new Error("GITHUB_TOKEN not configured");
	// Accept a bare gist ID (no slashes) or a full API URL
	const gistUrl = rawGist.startsWith("http")
		? rawGist
		: `https://api.github.com/gists/${rawGist}`;

	await githubPacer.wait();
	const res = await fetch(gistUrl, {
		headers: {
			Authorization: `token ${githubToken}`,
			Accept: "application/json",
		},
	});
	if (!res.ok) {
		throw new Error(`Gist fetch failed: ${res.status} ${res.statusText}`);
	}
	return (await res.json()) as GistSnapshot;
}

export function taskToChange(
	t: GistTask,
	boardMap: Record<string, string> = BOARD_TO_CHANNEL,
) {
	const isGcd = t["gc'd"] === true;
	const channelId = boardMap[t.board_slug];
	return {
		type: "upsert" as const,
		key: t.task_id,
		properties: {
			Name: Builder.title(t.name),
			task_id: Builder.richText(t.task_id),
			board_slug: Builder.richText(t.board_slug),
			status: Builder.select(isGcd ? "archived" : t.status),
			assignee: Builder.richText(t.assignee ?? ""),
			body: Builder.richText(truncate(t.body)),
			parents: Builder.richText(t.parents.join(",")),
			children: Builder.richText(t.children.join(",")),
			created_at: Builder.date(t.created_at.slice(0, 10)),
			updated_at: Builder.date(t.updated_at.slice(0, 10)),
			latest_summary: Builder.richText(
				isGcd && !t.latest_summary
					? "tombstoned: kanban gc"
					: truncate(t.latest_summary)
			),
			// parent_project relation (renamed from `project` mid-build to force fresh dual relation).
			parent_project: channelId ? [Builder.relation(channelId)] : [],
		},
	};
}

// ── Tombstone helpers ────────────────────────────────────────────────
// Query the Notion tasks database for all non-archived rows belonging to
// a specific board_slug. Returns a set of task_id strings.
// Used by tasksDelta to detect orphaned Notion rows that no longer exist
// in the kanban snapshot and should be tombstoned.

async function fetchNotionTaskIdsForBoards(
	boardSlugs: string[],
): Promise<Set<string>> {
	const notionToken = process.env.NOTION_API_TOKEN;
	const tasksDataSourceId = process.env.TASKS_DATA_SOURCE_ID;

	if (!notionToken || !tasksDataSourceId || boardSlugs.length === 0) {
		console.warn(
			"tombstone: NOTION_API_TOKEN or TASKS_DATABASE_ID not configured — skipping tombstone pass",
		);
		return new Set();
	}

	const notionHeaders = {
		Authorization: `Bearer ${notionToken}`,
		"Content-Type": "application/json",
		"Notion-Version": "2025-09-03",
	};

	const taskIds = new Set<string>();
	let hasMore = true;
	let startCursor: string | undefined;

	while (hasMore) {
		const body: any = {
			filter: {
				and: [
					{
						or: boardSlugs.map((s) => ({
							property: "board_slug",
							rich_text: { equals: s },
						})),
					},
					{
						property: "status",
						select: { does_not_equal: "archived" },
					},
				],
			},
			page_size: 100,
		};
		if (startCursor) body.start_cursor = startCursor;

		const res = await fetch(
			`https://api.notion.com/v1/data_sources/${tasksDataSourceId}/query`,
			{
				method: "POST",
				headers: notionHeaders,
				body: JSON.stringify(body),
			}
		);

		if (!res.ok) {
			console.warn(
				`tombstone: Notion query failed (${res.status}) — skipping tombstone pass`
			);
			return new Set();
		}

		const data = (await res.json()) as any;
		for (const page of data.results ?? []) {
			const props = page.properties;
			const tid =
				props?.task_id?.type === "rich_text"
					? props.task_id.rich_text[0]?.plain_text
					: undefined;
			if (tid) taskIds.add(tid);
		}

		hasMore = data.has_more ?? false;
		startCursor = data.next_cursor ?? undefined;
	}

	return taskIds;
}

/**
 * Build tombstone changes for Notion rows that exist in the tasks DB but
 * are absent from the kanban gist snapshot.
 *
 * Guarantees:
 *   - Multi-board safety: only queries Notion for the snapshot's board_slug.
 *   - Idempotency: only considers non-archived rows, so re-running after
 *     a tombstone cycle is a no-op (no status flap, no write churn).
 *   - Defensive: if Notion query fails, returns [] (no false tombstones).
 */
export async function buildTombstoneChanges(
	snapshot: GistSnapshot
): Promise<Array<{ type: "upsert"; key: string; properties: any }>> {
	const snapshotTaskIds = new Set(snapshot.tasks.map((t) => t.task_id));
	const boardSlugs =
		snapshot.boards ?? [snapshot.board].filter(Boolean) as string[];
	const notionTaskIds = await fetchNotionTaskIdsForBoards(boardSlugs);

	if (notionTaskIds.size === 0) {
		// Either no rows in Notion yet, or the query failed/was skipped.
		return [];
	}

	const tombstones: Array<{ type: "upsert"; key: string; properties: any }> = [];
	const today = new Date().toISOString().slice(0, 10);

	for (const notionTaskId of notionTaskIds) {
		if (!snapshotTaskIds.has(notionTaskId)) {
			// This task exists in Notion (non-archived) but is absent from the
			// kanban snapshot → tombstone it.
			tombstones.push({
				type: "upsert" as const,
				key: notionTaskId,
				properties: {
					// IMPORTANT: include task_id so the managed-DB primaryKey lookup
					// can match this upsert to the existing row. Without it the
					// Workers SDK has no way to bind `key` to the row and the
					// change is silently dropped (or worse, creates a duplicate).
					task_id: Builder.richText(notionTaskId),
					status: Builder.select("archived"),
					latest_summary: Builder.richText("tombstoned: absent from kanban snapshot"),
					updated_at: Builder.date(today),
				},
			});
		}
	}

	if (tombstones.length > 0) {
		console.log(
			`tombstone: ${tombstones.length} task(s) absent from snapshot — marking archived: ${tombstones.map((t) => t.key).join(", ")}`
		);
	}

	return tombstones;
}

// ── Notion direct-write helpers (used by webhook + tools) ───────────

/** Build Notion page properties from a GistTask for direct API writes. */
function taskToNotionProperties(t: GistTask, projectPageId?: string | null) {
	const isGcd = t["gc'd"] === true;

	const properties: Record<string, any> = {
		Name: {
			title: [{ text: { content: t.name } }],
		},
		task_id: {
			rich_text: [{ text: { content: t.task_id } }],
		},
		board_slug: {
			rich_text: [{ text: { content: t.board_slug } }],
		},
		status: {
			select: { name: isGcd ? "archived" : t.status },
		},
		assignee: {
			rich_text: [{ text: { content: t.assignee ?? "" } }],
		},
		body: {
			rich_text: [{ text: { content: truncate(t.body) } }],
		},
		parents: {
			rich_text: [{ text: { content: t.parents.join(",") } }],
		},
		children: {
			rich_text: [{ text: { content: t.children.join(",") } }],
		},
		created_at: {
			date: { start: t.created_at.slice(0, 10) },
		},
		updated_at: {
			date: { start: t.updated_at.slice(0, 10) },
		},
		latest_summary: {
			rich_text: [
				{
					text: {
						content:
							isGcd && !t.latest_summary
								? "tombstoned: kanban gc"
								: truncate(t.latest_summary),
					},
				},
			],
		},
	};

	// Set the parent_project relation if we have the resolved Notion page ID.
	// NOTE: Unlike the sync path (which uses Builder.relation with the primary key
	// and the platform auto-resolves), the webhook uses context.notion directly
	// and must pass the actual Notion page UUID.
	if (projectPageId) {
		properties.parent_project = {
			relation: [{ id: projectPageId }],
		};
	}

	return properties;
}

/** Find Notion page ID by task_id in the tasks database. Returns null if not found. */
async function findTaskPageId(
	notion: any,
	tasksDataSourceId: string,
	taskId: string,
): Promise<string | null> {
	const response = await notion.dataSources.query({
		data_source_id: tasksDataSourceId,
		filter: {
			property: "task_id",
			rich_text: { equals: taskId },
		},
		page_size: 1,
	});
	if (response.results && response.results.length > 0) {
		return response.results[0].id;
	}
	return null;
}

/**
 * Resolve a discord_channel_id to a Notion page ID in the projects database.
 * Uses PROJECTS_DATABASE_ID env var. Returns null if not found or not configured.
 */
async function resolveProjectPageId(
	notion: any,
	channelId: string,
): Promise<string | null> {
	const projectsDataSourceId = process.env.PROJECTS_DATA_SOURCE_ID;
	if (!projectsDataSourceId) return null;
	try {
		const response = await notion.dataSources.query({
			data_source_id: projectsDataSourceId,
			filter: {
				property: "discord_channel_id",
				rich_text: { equals: channelId },
			},
			page_size: 1,
		});
		if (response.results && response.results.length > 0) {
			return response.results[0].id;
		}
	} catch (err) {
		console.warn(`resolveProjectPageId: failed for ${channelId}: ${err}`);
	}
	return null;
}

/** Upsert a single task: update existing page or create new one. */
export async function upsertTaskViaNotion(
	notion: any,
	tasksDatabaseId: string,
	tasksDataSourceId: string,
	task: GistTask,
): Promise<{ action: "created" | "updated"; task_id: string }> {
	// Resolve the project page ID for the parent_project relation
	const channelId = BOARD_TO_CHANNEL[task.board_slug];
	let projectPageId: string | null = null;
	if (channelId) {
		projectPageId = await resolveProjectPageId(notion, channelId);
	}

	const properties = taskToNotionProperties(task, projectPageId);
	const existingPageId = await findTaskPageId(
		notion,
		tasksDataSourceId,
		task.task_id,
	);

	if (existingPageId) {
		await notion.pages.update({
			page_id: existingPageId,
			properties,
		});
		return { action: "updated", task_id: task.task_id };
	} else {
		await notion.pages.create({
			parent: { database_id: tasksDatabaseId },
			properties,
		});
		return { action: "created", task_id: task.task_id };
	}
}

/** Tombstone a task: set status to "archived" if the page exists. */
export async function tombstoneTaskViaNotion(
	notion: any,
	tasksDataSourceId: string,
	taskId: string,
): Promise<{ action: "tombstoned" | "not_found"; task_id: string }> {
	const existingPageId = await findTaskPageId(
		notion,
		tasksDataSourceId,
		taskId,
	);

	if (!existingPageId) {
		return { action: "not_found", task_id: taskId };
	}

	// Use page archive (in_trash) rather than setting a `status` property —
	// the tasks DB is `worker.database({type:"managed"})`, which rejects direct
	// property writes from tools (`Cannot modify read-only property`). The
	// page-level `archived` flag IS mutable and behaves as our tombstone.
	await notion.pages.update({
		page_id: existingPageId,
		archived: true,
	});
	return { action: "tombstoned", task_id: taskId };
}
