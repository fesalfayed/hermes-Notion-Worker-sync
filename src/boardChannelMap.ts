/**
 * Board-to-Channel Map Loader
 *
 * Reads board_channel_map.yaml and provides the BOARD_TO_CHANNEL and
 * CHANNEL_TO_BOARD lookups that were previously hard-coded in index.ts.
 *
 * Validation:
 *   - Warns on channels that 404 via Discord API (non-fatal).
 *   - Refuses boot ONLY if a `required: true` entry fails validation.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";

// ── Types ───────────────────────────────────────────────────────────

export interface BoardEntry {
	channel_id: string;
	required?: boolean;
}

export interface BoardChannelMapConfig {
	boards: Record<string, BoardEntry>;
}

export interface BoardChannelMap {
	/** board_slug → discord_channel_id */
	boardToChannel: Record<string, string>;
	/** discord_channel_id → board_slug (inverse) */
	channelToBoard: Record<string, string>;
}

// ── Default YAML path (project root) ────────────────────────────────
// Look for the YAML next to the compiled JS (dist/) first; fall back to repo
// root for `tsx`-based local dev. The build script copies the YAML into dist/
// so the deployed sandbox bundle includes it (otherwise module-init throws
// ENOENT inside the Workers runtime).
const DEFAULT_YAML_PATH = (() => {
	const bundled = resolve(__dirname, "board_channel_map.yaml");
	try {
		readFileSync(bundled, "utf-8");
		return bundled;
	} catch {
		return resolve(__dirname, "..", "board_channel_map.yaml");
	}
})();

// ── Loader ──────────────────────────────────────────────────────────

/**
 * Load and parse board_channel_map.yaml from the project root.
 * Returns the flat lookup maps.
 */
export function loadBoardChannelMap(yamlPath?: string): BoardChannelMap {
	const resolvedPath = yamlPath ?? DEFAULT_YAML_PATH;

	let raw: string;
	try {
		raw = readFileSync(resolvedPath, "utf-8");
	} catch (err: any) {
		throw new Error(
			`Failed to read board_channel_map.yaml at ${resolvedPath}: ${err.message}`
		);
	}

	const config = parseYaml(raw) as BoardChannelMapConfig;
	if (!config?.boards || typeof config.boards !== "object") {
		throw new Error(
			`Invalid board_channel_map.yaml: missing or invalid 'boards' key`
		);
	}

	const boardToChannel: Record<string, string> = {};
	const channelToBoard: Record<string, string> = {};

	for (const [slug, entry] of Object.entries(config.boards)) {
		if (!entry?.channel_id) {
			console.warn(
				`[board_channel_map] WARNING: board "${slug}" has no channel_id — skipping`
			);
			continue;
		}
		boardToChannel[slug] = entry.channel_id;
		channelToBoard[entry.channel_id] = slug;
	}

	if (Object.keys(boardToChannel).length === 0) {
		throw new Error(
			`board_channel_map.yaml contains no valid board entries`
		);
	}

	return { boardToChannel, channelToBoard };
}

/**
 * Validate channel IDs against the Discord API.
 * Returns a list of { slug, channel_id, ok, error? } results.
 *
 * - Channels that 404 or are unauthorized produce a warning (non-fatal).
 * - If any entry marked `required: true` fails, throws an Error to block boot.
 */
export async function validateBoardChannelMap(
	config: BoardChannelMapConfig,
	discordToken: string,
): Promise<{ slug: string; channel_id: string; ok: boolean; error?: string }[]> {
	const results: { slug: string; channel_id: string; ok: boolean; error?: string }[] = [];
	const requiredFailures: string[] = [];

	for (const [slug, entry] of Object.entries(config.boards)) {
		if (!entry?.channel_id) continue;

		try {
			const res = await fetch(
				`https://discord.com/api/v10/channels/${entry.channel_id}`,
				{
					headers: {
						Authorization: `Bot ${discordToken}`,
						"Content-Type": "application/json",
					},
				}
			);

			if (res.ok) {
				results.push({ slug, channel_id: entry.channel_id, ok: true });
			} else {
				const errMsg = `HTTP ${res.status} ${res.statusText}`;
				console.warn(
					`[board_channel_map] WARNING: channel ${entry.channel_id} for board "${slug}" failed validation: ${errMsg}`
				);
				results.push({ slug, channel_id: entry.channel_id, ok: false, error: errMsg });
				if (entry.required) {
					requiredFailures.push(`${slug} (${entry.channel_id}): ${errMsg}`);
				}
			}
		} catch (err: any) {
			const errMsg = err.message ?? String(err);
			console.warn(
				`[board_channel_map] WARNING: channel ${entry.channel_id} for board "${slug}" validation error: ${errMsg}`
			);
			results.push({ slug, channel_id: entry.channel_id, ok: false, error: errMsg });
			if (entry.required) {
				requiredFailures.push(`${slug} (${entry.channel_id}): ${errMsg}`);
			}
		}
	}

	if (requiredFailures.length > 0) {
		throw new Error(
			`FATAL: Required board-channel mappings failed validation:\n` +
			requiredFailures.map((f) => `  - ${f}`).join("\n") +
			`\nWorker refusing to boot. Fix the channel IDs or remove 'required: true'.`
		);
	}

	return results;
}

/**
 * Load the raw config (for validation purposes).
 */
export function loadRawConfig(yamlPath?: string): BoardChannelMapConfig {
	const resolvedPath = yamlPath ?? DEFAULT_YAML_PATH;
	const raw = readFileSync(resolvedPath, "utf-8");
	return parseYaml(raw) as BoardChannelMapConfig;
}
