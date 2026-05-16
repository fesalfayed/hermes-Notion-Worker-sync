import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

// Tool: bindProjectToBoard
// One-shot: populates kanban_board_slug on the project row and re-links
// every task row in the board to the project via the `project` relation.
export function register(worker: Worker) {
	worker.tool("bindProjectToBoard", {
		title: "Bind a project to a kanban board",
		description:
			"Connect a project to a kanban board so tasks show up under it. Use when someone says 'bind board X to channel Y' — " +
			"this sets the kanban_board_slug on the project and links all existing tasks in that board to the project.",
		schema: j.object({
			discord_channel_id: j
				.string()
				.describe("Discord channel ID identifying the project row"),
			board_slug: j
				.string()
				.describe("The kanban board slug to bind (e.g. 'hermes-projects-sync')"),
		}),
		outputSchema: j.object({
			ok: j.boolean(),
			project_page_id: j.string().nullable(),
			tasks_relinked: j.number().nullable(),
			error: j.string().nullable(),
		}),
		hints: { readOnlyHint: false },
		execute: async ({ discord_channel_id, board_slug }, { notion: _notion }) => {
			const notionToken = process.env.NOTION_API_TOKEN;
			const projectsDatabaseId = process.env.PROJECTS_DATABASE_ID;

			const projectsDataSourceId = process.env.PROJECTS_DATA_SOURCE_ID;
			const tasksDatabaseId = process.env.TASKS_DATABASE_ID;
			const tasksDataSourceId = process.env.TASKS_DATA_SOURCE_ID;

			if (!notionToken) {
				return { ok: false, project_page_id: null, tasks_relinked: null, error: "NOTION_API_TOKEN not configured" };
			}
			if (!projectsDatabaseId || !projectsDataSourceId) {
				return { ok: false, project_page_id: null, tasks_relinked: null, error: "PROJECTS_DATABASE_ID / PROJECTS_DATA_SOURCE_ID not configured" };
			}
			if (!tasksDatabaseId || !tasksDataSourceId) {
				return { ok: false, project_page_id: null, tasks_relinked: null, error: "TASKS_DATABASE_ID / TASKS_DATA_SOURCE_ID not configured" };
			}

			const notionHeaders = {
				Authorization: `Bearer ${notionToken}`,
				"Content-Type": "application/json",
				"Notion-Version": "2025-09-03",
			};

			try {
				// Step 1: Query projects DB for the row matching discord_channel_id -> get page ID.
				const projectQueryRes = await fetch(
					`https://api.notion.com/v1/data_sources/${projectsDataSourceId}/query`,
					{
						method: "POST",
						headers: notionHeaders,
						body: JSON.stringify({
							filter: {
								property: "discord_channel_id",
								rich_text: { equals: discord_channel_id },
							},
						}),
					}
				);

				if (!projectQueryRes.ok) {
					return {
						ok: false,
						project_page_id: null,
						tasks_relinked: null,
						error: `Projects DB query failed: ${projectQueryRes.status} ${await projectQueryRes.text()}`,
					};
				}

				const projectData = (await projectQueryRes.json()) as any;
				if (!projectData.results || projectData.results.length === 0) {
					return {
						ok: false,
						project_page_id: null,
						tasks_relinked: null,
						error: `No project row found with discord_channel_id=${discord_channel_id}`,
					};
				}

				const projectPageId = projectData.results[0].id as string;

				// Step 2: PATCH the project page with kanban_board_slug = board_slug.
				const patchProjectRes = await fetch(
					`https://api.notion.com/v1/pages/${projectPageId}`,
					{
						method: "PATCH",
						headers: notionHeaders,
						body: JSON.stringify({
							properties: {
								kanban_board_slug: {
									rich_text: [{ text: { content: board_slug } }],
								},
							},
						}),
					}
				);

				if (!patchProjectRes.ok) {
					return {
						ok: false,
						project_page_id: projectPageId,
						tasks_relinked: null,
						error: `Failed to patch project kanban_board_slug: ${patchProjectRes.status} ${await patchProjectRes.text()}`,
					};
				}

				// Step 3: Query tasks DB for ALL rows where board_slug == input.board_slug.
				// Paginate in case there are >100 tasks.
				const taskPages: any[] = [];
				let hasMore = true;
				let startCursor: string | undefined;

				while (hasMore) {
					const body: any = {
						filter: {
							property: "board_slug",
							rich_text: { equals: board_slug },
						},
						page_size: 100,
					};
					if (startCursor) body.start_cursor = startCursor;

					const tasksQueryRes = await fetch(
						`https://api.notion.com/v1/data_sources/${tasksDataSourceId}/query`,
						{
							method: "POST",
							headers: notionHeaders,
							body: JSON.stringify(body),
						}
					);

					if (!tasksQueryRes.ok) {
						return {
							ok: false,
							project_page_id: projectPageId,
							tasks_relinked: null,
							error: `Tasks DB query failed: ${tasksQueryRes.status} ${await tasksQueryRes.text()}`,
						};
					}

					const tasksData = (await tasksQueryRes.json()) as any;
					taskPages.push(...(tasksData.results ?? []));
					hasMore = tasksData.has_more ?? false;
					startCursor = tasksData.next_cursor ?? undefined;
				}

				// Step 4: For each task row, PATCH its project relation to point at the project page.
				let relinked = 0;
				for (const taskPage of taskPages) {
					const patchTaskRes = await fetch(
						`https://api.notion.com/v1/pages/${taskPage.id}`,
						{
							method: "PATCH",
							headers: notionHeaders,
							body: JSON.stringify({
								properties: {
									project: {
										relation: [{ id: projectPageId }],
									},
								},
							}),
						}
					);

					if (patchTaskRes.ok) {
						relinked++;
					} else {
						// Log but continue - partial success is better than aborting.
						console.warn(
							`bindProjectToBoard: failed to patch task ${taskPage.id}: ${patchTaskRes.status}`
						);
					}
				}

				return {
					ok: true,
					project_page_id: projectPageId,
					tasks_relinked: relinked,
					error: null,
				};
			} catch (err) {
				return {
					ok: false,
					project_page_id: null,
					tasks_relinked: null,
					error: `Exception: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		},
	});
}
