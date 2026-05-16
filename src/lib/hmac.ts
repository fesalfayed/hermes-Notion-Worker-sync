import { WebhookVerificationError } from "@notionhq/workers";
import * as crypto from "node:crypto";

export function verifyKanbanSignature(
	rawBody: string,
	headers: Record<string, string>,
): void {
	const secret = process.env.KANBAN_WEBHOOK_SECRET;
	if (!secret) {
		throw new WebhookVerificationError("KANBAN_WEBHOOK_SECRET not configured");
	}

	const signature = headers["x-kanban-signature-256"];
	if (!signature?.startsWith("sha256=")) {
		throw new WebhookVerificationError(
			"Missing or malformed x-kanban-signature-256 header",
		);
	}

	const expected = `sha256=${crypto
		.createHmac("sha256", secret)
		.update(rawBody)
		.digest("hex")}`;

	if (signature.length !== expected.length) {
		throw new WebhookVerificationError("Invalid kanban webhook signature");
	}

	if (
		!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
	) {
		throw new WebhookVerificationError("Invalid kanban webhook signature");
	}
}
