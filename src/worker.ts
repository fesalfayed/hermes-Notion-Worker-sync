import { Worker } from "@notionhq/workers";

// Singleton Worker instance. Imported by databases.ts, pacers.ts, and the
// orchestrator in index.ts. Keeping it in its own module avoids circular
// imports between database/pacer declarations and the index that wires
// each capability into the same Worker.
export const worker = new Worker();
