import { worker } from "./worker.js";

// ── Rate limiter: Discord API ───────────────────────────────────────
// Discord global rate limit floor is 50/s per the SDK docs.
export const discordPacer = worker.pacer("discord", {
	allowedRequests: 50,
	intervalMs: 1000,
});

// ── Rate limiter: GitHub API ────────────────────────────────────────
// Conservative: 30 requests per 60s (GitHub PAT allows much more,
// but this is the unauth floor — we stay conservative).
export const githubPacer = worker.pacer("github", {
	allowedRequests: 30,
	intervalMs: 60_000,
});
