import { createHmac } from "node:crypto";
import { describe, it, expect, inject, beforeAll } from "vitest";
import { getEnv } from "./fixtures/env";
import { ctx } from "./fixtures/context";

/**
 * Compute a valid HMAC-SHA256 signature for a given body using the webhook secret.
 */
function sign(body: string, secret: string): string {
	return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Send a raw POST to the webhook endpoint with arbitrary headers/body.
 */
async function sendWebhook(
	body: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
	const res = await fetch(`${ctx.serverUrl}/api/auth/lemonsqueezy/webhook`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...headers,
		},
		body,
	});
	const data = await res.json();
	return { status: res.status, data };
}

/**
 * Build a minimal valid webhook payload for testing.
 */
function buildPayload(eventName: string): string {
	return JSON.stringify({
		meta: {
			event_name: eventName,
			custom_data: {},
		},
		data: {
			id: "999999",
			type: "subscriptions",
			attributes: {
				store_id: 12345,
				customer_id: 999999,
				order_id: 999999,
				product_id: 999999,
				variant_id: 999999,
				status: "active",
				card_brand: "visa",
				card_last_four: "4242",
				renews_at: new Date().toISOString(),
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		},
	});
}

describe("Suite 5: Webhook Verification", () => {
	const env = getEnv();

	beforeAll(async () => {
		ctx.serverUrl = inject("serverUrl");
		ctx.tunnelUrl = inject("tunnelUrl");
	});

	it("5.1 — Invalid signature is rejected", async () => {
		const body = buildPayload("subscription_created");
		const wrongSignature = sign(body, "wrong-secret-that-does-not-match");

		const { status, data } = await sendWebhook(body, {
			"X-Signature": wrongSignature,
		});

		expect(status).toBe(400);
		expect(data.code).toBe("invalid_signature");
	});

	it("5.2 — Missing signature is rejected", async () => {
		const body = buildPayload("subscription_created");

		// No X-Signature header at all
		const { status, data } = await sendWebhook(body);

		expect(status).toBe(400);
		expect(data.code).toBe("invalid_signature");
	});

	it("5.3 — Malformed body is rejected", async () => {
		const malformedBody = "this is not valid JSON {{{";
		const validSignature = sign(malformedBody, env.LEMONSQUEEZY_WEBHOOK_SIGNING_SECRET);

		const { status, data } = await sendWebhook(malformedBody, {
			"X-Signature": validSignature,
		});

		expect(status).toBe(400);
		expect(data.code).toBe("invalid_body");
	});

	it("5.4 — Unknown event type is handled gracefully", async () => {
		const body = buildPayload("order_created");
		const validSignature = sign(body, env.LEMONSQUEEZY_WEBHOOK_SIGNING_SECRET);

		const { status, data } = await sendWebhook(body, {
			"X-Signature": validSignature,
		});

		expect(status).toBe(200);
		expect(data.success).toBe(true);
	});
});
