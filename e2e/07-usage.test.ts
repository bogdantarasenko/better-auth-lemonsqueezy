import Database from "better-sqlite3";
import { describe, it, expect, inject, beforeAll } from "vitest";
import { ctx } from "./fixtures/context";

const DB_PATH = "e2e/test.db";

/**
 * Check if any subscription for the test user has a subscriptionItemId.
 * If none do, the test products are not usage-based and the suite should skip.
 */
function getUsableSubscription(
	dbPath: string,
	userId: string,
): { lsSubscriptionId: string; subscriptionItemId: string } | null {
	const db = new Database(dbPath, { readonly: true });
	const row = db
		.prepare(
			`SELECT lsSubscriptionId, subscriptionItemId FROM lsSubscription
			 WHERE userId = ? AND subscriptionItemId IS NOT NULL AND subscriptionItemId != ''
			 LIMIT 1`,
		)
		.get(userId) as
		| { lsSubscriptionId: string; subscriptionItemId: string }
		| undefined;
	db.close();
	return row ?? null;
}

describe("Suite 7: Usage Reporting", () => {
	let usableSub: { lsSubscriptionId: string; subscriptionItemId: string } | null = null;
	let hasUsageBasedSub = false;

	beforeAll(() => {
		ctx.serverUrl = inject("serverUrl");
		ctx.tunnelUrl = inject("tunnelUrl");

		usableSub = getUsableSubscription(DB_PATH, ctx.testUser.id);
		hasUsageBasedSub = usableSub !== null;

		if (!hasUsageBasedSub) {
			console.warn(
				"[Suite 7] No usage-based subscriptions found (no subscriptionItemId). " +
					"Tests 7.1 will be skipped. Tests 7.2 and 7.3 still run (validation-only).",
			);
		}
	});

	it("7.1 — Report usage succeeds", async ({ skip }) => {
		if (!hasUsageBasedSub || !usableSub) {
			skip();
			return;
		}

		const res = await fetch(`${ctx.serverUrl}/api/auth/lemonsqueezy/usage`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				cookie: `better-auth.session_token=${ctx.testUser.sessionToken}`,
			},
			body: JSON.stringify({
				subscriptionId: usableSub.lsSubscriptionId,
				quantity: 100,
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
	});

	it("7.2 — Report usage with zero quantity returns error", async () => {
		// Zero is not a positive integer — endpoint should reject with 400
		const subscriptionId = usableSub?.lsSubscriptionId ?? "doesnt-matter";

		const res = await fetch(`${ctx.serverUrl}/api/auth/lemonsqueezy/usage`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				cookie: `better-auth.session_token=${ctx.testUser.sessionToken}`,
			},
			body: JSON.stringify({
				subscriptionId,
				quantity: 0,
			}),
		});

		// Zod validation rejects 0 or the endpoint's own check catches it
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(500);
	});

	it("7.3 — Report usage for invalid subscription returns error", async () => {
		const res = await fetch(`${ctx.serverUrl}/api/auth/lemonsqueezy/usage`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				cookie: `better-auth.session_token=${ctx.testUser.sessionToken}`,
			},
			body: JSON.stringify({
				subscriptionId: "999999999",
				quantity: 10,
			}),
		});

		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.code).toBe("subscription_not_found");
	});
});
