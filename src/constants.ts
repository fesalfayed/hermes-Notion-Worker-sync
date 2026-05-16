// ── Shared constants ────────────────────────────────────────────────
// Discord guild and category IDs — sourced from environment variables.
// Set these in your .env file (see .env.example).

export const GUILD_ID = process.env.DISCORD_GUILD_ID ?? "";
export const PROJECTS_CATEGORY_ID = process.env.DISCORD_PROJECTS_CATEGORY_ID ?? "";
export const ARCHIVE_CATEGORY_ID = process.env.DISCORD_ARCHIVE_CATEGORY_ID ?? "";
