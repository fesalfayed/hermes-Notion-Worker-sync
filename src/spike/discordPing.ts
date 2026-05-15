/**
 * Spike 1.1: Discord egress feasibility test
 *
 * Self-contained spike tool registered on its own Worker instance.
 * NOT imported from src/index.ts.
 *
 * Run standalone:  DISCORD_BOT_TOKEN=<token> npx tsx src/spike/discordPing.ts
 * Run via ntn:     ntn workers exec discordPing --local --dotenv .env.spike
 *                  (requires importing this into index.ts — see README)
 */

const CHANNEL_ID = "000000000000000014";
const DISCORD_API = `https://discord.com/api/v10/channels/${CHANNEL_ID}`;

async function discordPing(): Promise<{
  status: number;
  statusText: string;
  bodyPreview: string;
  egress: string;
}> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN not set in environment");
  }

  const res = await fetch(DISCORD_API, {
    method: "GET",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
  });

  const body = await res.text();
  return {
    status: res.status,
    statusText: res.statusText,
    bodyPreview: body.slice(0, 200),
    egress: res.status < 500 ? "yes" : "unknown",
  };
}

// Standalone execution
(async () => {
  console.log("=== Spike 1.1: Discord Egress Test ===\n");

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("ERROR: DISCORD_BOT_TOKEN not set in environment");
    process.exit(1);
  }

  console.log(`GET ${DISCORD_API}`);
  console.log(`Authorization: Bot <redacted>\n`);

  try {
    const result = await discordPing();
    console.log(`Status: ${result.status} ${result.statusText}`);
    console.log(`Body (first 200 chars): ${result.bodyPreview}`);
    console.log(`\nEgress: ${result.egress.toUpperCase()}`);
  } catch (err) {
    console.error(`Fetch failed: ${err}`);
    console.log(`\nEgress: NO (fetch error)`);
    process.exit(1);
  }
})();
