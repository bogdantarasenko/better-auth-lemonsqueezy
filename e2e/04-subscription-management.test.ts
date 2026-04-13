import { describe, it, expect, inject, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { getEnv } from "./fixtures/env";
import { ctx } from "./fixtures/context";
import { poll } from "./helpers/poll";

const DB_PATH = "e2e/test.db";

/**
 * Make an authenticated API call to the Better Auth server.
 */
async function apiCall(
	path: string,
	opts: {
		method?: string;
		body?: Record<string, unknown>;
		query?: Record<string, string>;
		sessionToken: string;
	},
) {
	const url = new URL(`${ctx.serverUrl}/api/auth${path}`);
	if (opts.query) {
		for (const [k, v] of Object.entries(opts.query)) {
			url.searchParams.set(k, v);
		}
	}

	const res = await fetch(url.toString(), {
		method: opts.method || "GET",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${opts.sessionToken}`,
		},
		body: opts.body ? JSON.stringify(opts.body) : undefined,
	});

	const data = await res.json();
	return { status: res.status, data };
}

describe("Suite 4: Subscription Management", () => {
	const env = getEnv();

	beforeAll(async () => {
		ctx.serverUrl = inject("serverUrl");
		ctx.tunnelUrl = inject("tunnelUrl");
	});

	it("4.1 — Get billing portal URL", async () => {
		expect(ctx.proLsSubscriptionId).toBeTruthy();

		const { status, data } = await apiCall("/lemonsqueezy/subscription/portal", {
			method: "POST",
			body: { subscriptionId: ctx.proLsSubscriptionId },
			sessionToken: ctx.testUser.sessionToken,
		});

		expect(status).toBe(200);
		expect(data.url).toBeTruthy();

		// Verify it's a valid URL
		const url = new URL(data.url);
		expect(url.protocol).toMatch(/^https?:$/);
	});

	it("4.2 — Sync subscription from API", async () => {
		expect(ctx.proLsSubscriptionId).toBeTruthy();

		const { status, data } = await apiCall("/lemonsqueezy/subscription/sync", {
			method: "POST",
			body: { subscriptionId: ctx.proLsSubscriptionId },
			sessionToken: ctx.testUser.sessionToken,
		});

		expect(status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.subscription).toBeTruthy();
		expect(data.subscription.status).toBe("active");
		expect(data.subscription.planName).toBe("pro");
		expect(data.subscription.interval).toBe("monthly");
		expect(data.subscription.variantId).toBe(env.LEMONSQUEEZY_PRO_MONTHLY_VARIANT_ID);
		expect(data.subscription.productId).toBe(env.LEMONSQUEEZY_PRO_PRODUCT_ID);
	});

	it("4.3 — Update subscription (change plan to max)", async () => {
		expect(ctx.proLsSubscriptionId).toBeTruthy();

		const { status, data } = await apiCall("/lemonsqueezy/subscription/update", {
			method: "POST",
			body: {
				subscriptionId: ctx.proLsSubscriptionId,
				plan: "max",
				interval: "monthly",
			},
			sessionToken: ctx.testUser.sessionToken,
		});

		expect(status).toBe(200);
		expect(data.success).toBe(true);
	});

	it("4.4 — Webhook updates subscription after plan change", async () => {
		const db = new Database(DB_PATH, { readonly: true });
		try {
			const row = await poll(
				async () => {
					const sub = db
						.prepare("SELECT * FROM lsSubscription WHERE lsSubscriptionId = ?")
						.get(ctx.proLsSubscriptionId) as Record<string, unknown> | undefined;

					// Wait until the variant has actually changed to the max monthly variant
					if (sub && sub.variantId === env.LEMONSQUEEZY_MAX_MONTHLY_VARIANT_ID) {
						return sub;
					}
					return undefined;
				},
				{ timeoutMs: 30_000, intervalMs: 1_000, label: "subscription plan update via webhook" },
			);

			expect(row).toBeTruthy();
			expect(row.variantId).toBe(env.LEMONSQUEEZY_MAX_MONTHLY_VARIANT_ID);
			expect(row.productId).toBe(env.LEMONSQUEEZY_MAX_PRODUCT_ID);
			expect(row.planName).toBe("max");
		} finally {
			db.close();
		}
	});

	it("4.5 — Cancel subscription", async () => {
		expect(ctx.proLsSubscriptionId).toBeTruthy();

		const { status, data } = await apiCall("/lemonsqueezy/subscription/cancel", {
			method: "POST",
			body: { subscriptionId: ctx.proLsSubscriptionId },
			sessionToken: ctx.testUser.sessionToken,
		});

		expect(status).toBe(200);
		expect(data.success).toBe(true);
	});

	it("4.6 — Webhook updates cancelled status", async () => {
		const db = new Database(DB_PATH, { readonly: true });
		try {
			const row = await poll(
				async () => {
					const sub = db
						.prepare("SELECT * FROM lsSubscription WHERE lsSubscriptionId = ?")
						.get(ctx.proLsSubscriptionId) as Record<string, unknown> | undefined;

					if (sub && sub.status === "cancelled") {
						return sub;
					}
					return undefined;
				},
				{ timeoutMs: 30_000, intervalMs: 1_000, label: "subscription cancelled status via webhook" },
			);

			expect(row).toBeTruthy();
			expect(row.status).toBe("cancelled");
		} finally {
			db.close();
		}
	});

	it("4.7 — Resume cancelled subscription", async () => {
		expect(ctx.proLsSubscriptionId).toBeTruthy();

		const { status, data } = await apiCall("/lemonsqueezy/subscription/resume", {
			method: "POST",
			body: { subscriptionId: ctx.proLsSubscriptionId },
			sessionToken: ctx.testUser.sessionToken,
		});

		expect(status).toBe(200);
		expect(data.success).toBe(true);
	});

	it("4.8 — Webhook restores active status", async () => {
		const db = new Database(DB_PATH, { readonly: true });
		try {
			const row = await poll(
				async () => {
					const sub = db
						.prepare("SELECT * FROM lsSubscription WHERE lsSubscriptionId = ?")
						.get(ctx.proLsSubscriptionId) as Record<string, unknown> | undefined;

					if (sub && sub.status === "active") {
						return sub;
					}
					return undefined;
				},
				{ timeoutMs: 30_000, intervalMs: 1_000, label: "subscription active status via webhook" },
			);

			expect(row).toBeTruthy();
			expect(row.status).toBe("active");
		} finally {
			db.close();
		}
	});
});
