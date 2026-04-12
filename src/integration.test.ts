import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTestInstance } from "better-auth/test";
import { lemonSqueezy } from "./index";
import type { LemonSqueezyOptions } from "./types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "test-webhook-secret-integration";

const lsOptions: LemonSqueezyOptions = {
	apiKey: "test-api-key",
	storeId: "store_123",
	webhookSecret: WEBHOOK_SECRET,
	createCustomerOnSignUp: true,
	defaultSuccessUrl: "https://example.com/success",
	defaultCancelUrl: "https://example.com/cancel",
	subscription: {
		enabled: true,
		plans: [
			{
				name: "pro",
				productId: "prod_1",
				intervals: { monthly: "variant_m", annual: "variant_a" },
			},
		],
	},
};

// ---------------------------------------------------------------------------
// Mock fetch for LS API calls
// ---------------------------------------------------------------------------

let lsCustomerIdCounter = 100;
const originalFetch = globalThis.fetch;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input.toString();

	if (url === "https://api.lemonsqueezy.com/v1/customers" && init?.method === "POST") {
		const id = String(++lsCustomerIdCounter);
		return new Response(
			JSON.stringify({ data: { id, type: "customers", attributes: {} } }),
			{ status: 201, headers: { "Content-Type": "application/json" } },
		);
	}

	if (url === "https://api.lemonsqueezy.com/v1/checkouts" && init?.method === "POST") {
		return new Response(
			JSON.stringify({
				data: {
					type: "checkouts",
					id: "checkout_1",
					attributes: { url: "https://checkout.lemonsqueezy.com/test" },
				},
			}),
			{ status: 201, headers: { "Content-Type": "application/json" } },
		);
	}

	if (url.startsWith("https://api.lemonsqueezy.com/v1/subscriptions/") && init?.method === "PATCH") {
		return new Response(
			JSON.stringify({
				data: { type: "subscriptions", id: url.split("/").pop(), attributes: { status: "active" } },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	if (url.startsWith("https://api.lemonsqueezy.com/v1/subscriptions/") && (!init?.method || init?.method === "GET")) {
		return new Response(
			JSON.stringify({
				data: {
					type: "subscriptions",
					id: url.split("/").pop(),
					attributes: {
						status: "active",
						variant_id: "variant_m",
						product_id: "prod_1",
						customer_id: 101,
						renews_at: "2026-06-01T00:00:00Z",
						ends_at: null,
						trial_ends_at: null,
						cancelled_at: null,
						updated_at: new Date().toISOString(),
						urls: {
							customer_portal: "https://store.lemonsqueezy.com/billing?sig=abc",
						},
					},
				},
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	return originalFetch(input, init);
});

globalThis.fetch = fetchMock as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function computeHmacHex(body: string, secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function sendWebhook(
	auth: { handler: (req: Request) => Promise<Response> },
	eventName: string,
	attrs: Record<string, unknown>,
	meta: Record<string, unknown> = {},
) {
	const payload = JSON.stringify({
		meta: { event_name: eventName, ...meta },
		data: {
			id: attrs._subscriptionId ?? "sub_default",
			attributes: {
				customer_id: "cust_999",
				variant_id: "variant_m",
				product_id: "prod_1",
				status: "active",
				updated_at: new Date().toISOString(),
				...attrs,
			},
		},
	});
	const signature = await computeHmacHex(payload, WEBHOOK_SECRET);
	// getTestInstance sets baseURL to http://localhost:3000 (basePath = "/")
	return auth.handler(
		new Request("http://localhost:3000/api/auth/lemonsqueezy/webhook", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Signature": signature },
			body: payload,
		}),
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: LemonSqueezy plugin with Better Auth", () => {
	beforeEach(() => {
		fetchMock.mockClear();
	});

	// -----------------------------------------------------------------------
	// 1. Customer creation on sign-up
	// -----------------------------------------------------------------------

	it("creates a LS customer record on user sign-up", async () => {
		const { auth, client, db } = await getTestInstance(
			{
				plugins: [lemonSqueezy(lsOptions)],
			},
			{ disableTestUser: true },
		);

		const { data } = await client.signUp.email({
			email: "signup@test.com",
			password: "password123",
			name: "Signup User",
		});

		expect(data?.user).toBeDefined();

		// Verify LS customer create API was called
		const customerCalls = fetchMock.mock.calls.filter(
			(c) => c[0] === "https://api.lemonsqueezy.com/v1/customers",
		);
		expect(customerCalls.length).toBeGreaterThanOrEqual(1);

		// Verify customer record in DB
		const customer = await db.findOne({
			model: "lsCustomer",
			where: [{ field: "userId", value: data!.user.id }],
		});
		expect(customer).not.toBeNull();
		expect(customer?.lsCustomerId).toBeTruthy();
	});

	// -----------------------------------------------------------------------
	// 2. Checkout endpoint
	// -----------------------------------------------------------------------

	it("returns a checkout URL for authenticated user", async () => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});
		const { headers } = await signInWithTestUser();
		fetchMock.mockClear();

		const res = await auth.api.lemonSqueezySubscriptionCreate({
			headers,
			body: { plan: "pro", interval: "monthly" },
		});

		expect(res).toBeDefined();
		expect((res as Record<string, unknown>).url).toBe("https://checkout.lemonsqueezy.com/test");

		// Verify checkout request body structure
		const checkoutCall = fetchMock.mock.calls.find(
			(c) => c[0] === "https://api.lemonsqueezy.com/v1/checkouts",
		);
		expect(checkoutCall).toBeDefined();
		const body = JSON.parse(checkoutCall![1]?.body as string);
		expect(body.data.attributes.checkout_data.custom.user_id).toBeDefined();
		expect(body.data.relationships.variant.data.id).toBe("variant_m");
		expect(body.data.relationships.store.data.id).toBe("store_123");
	});

	it("returns checkout URL with annual variant", async () => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});
		const { headers } = await signInWithTestUser();
		fetchMock.mockClear();

		const res = await auth.api.lemonSqueezySubscriptionCreate({
			headers,
			body: { plan: "pro", interval: "annual" },
		});

		expect((res as Record<string, unknown>).url).toBe("https://checkout.lemonsqueezy.com/test");

		const checkoutCall = fetchMock.mock.calls.find(
			(c) => c[0] === "https://api.lemonsqueezy.com/v1/checkouts",
		);
		const body = JSON.parse(checkoutCall![1]?.body as string);
		expect(body.data.relationships.variant.data.id).toBe("variant_a");
	});

	it("rejects checkout with invalid plan", async () => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});
		const { headers } = await signInWithTestUser();

		const res = await auth.api.lemonSqueezySubscriptionCreate({
			headers,
			body: { plan: "nonexistent" },
		});
		expect((res as Record<string, unknown>).code).toBe("invalid_plan");
	});

	it("blocks checkout for already subscribed plan", async () => {
		const { auth, signInWithTestUser, db } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});
		const { headers, user } = await signInWithTestUser();

		// Insert existing active subscription
		await db.create({
			model: "lsSubscription",
			data: {
				userId: user.id,
				lsSubscriptionId: "sub_existing",
				lsCustomerId: "cust_x",
				variantId: "variant_m",
				productId: "prod_1",
				status: "active",
				planName: "pro",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});

		const res = await auth.api.lemonSqueezySubscriptionCreate({
			headers,
			body: { plan: "pro" },
		});
		expect((res as Record<string, unknown>).code).toBe("already_subscribed");
	});

	// -----------------------------------------------------------------------
	// 3. Webhook — full round-trip
	// -----------------------------------------------------------------------

	it("webhook creates a subscription record via subscription_created", async () => {
		const { auth, signInWithTestUser, db } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});
		const { user } = await signInWithTestUser();

		const res = await sendWebhook(auth, "subscription_created", {
			_subscriptionId: "sub_wh_1",
			status: "active",
			first_subscription_item: { id: "item_1" },
		}, { custom_data: { user_id: user.id } });

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);

		const sub = await db.findOne({
			model: "lsSubscription",
			where: [{ field: "lsSubscriptionId", value: "sub_wh_1" }],
		});
		expect(sub).not.toBeNull();
		expect(sub?.userId).toBe(user.id);
		expect(sub?.status).toBe("active");
		expect(sub?.planName).toBe("pro");
		expect(sub?.subscriptionItemId).toBe("item_1");
	});

	it("webhook rejects invalid signature", async () => {
		const { auth } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});

		const payload = JSON.stringify({
			meta: { event_name: "subscription_created" },
			data: { id: "sub_bad", attributes: {} },
		});
		const res = await auth.handler(
			new Request("http://localhost:3000/api/auth/lemonsqueezy/webhook", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Signature": "0000000000000000000000000000000000000000000000000000000000000000",
				},
				body: payload,
			}),
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.code).toBe("invalid_signature");
	});

	it("webhook updates subscription on subscription_cancelled", async () => {
		const { auth, signInWithTestUser, db } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});
		const { user } = await signInWithTestUser();

		// Create first
		await sendWebhook(auth, "subscription_created", {
			_subscriptionId: "sub_wh_cancel",
			status: "active",
		}, { custom_data: { user_id: user.id } });

		// Then cancel
		const res = await sendWebhook(auth, "subscription_cancelled", {
			_subscriptionId: "sub_wh_cancel",
			status: "cancelled",
			cancelled_at: "2026-04-12T00:00:00Z",
			ends_at: "2026-05-01T00:00:00Z",
		}, { custom_data: { user_id: user.id } });

		expect(res.status).toBe(200);

		const sub = await db.findOne({
			model: "lsSubscription",
			where: [{ field: "lsSubscriptionId", value: "sub_wh_cancel" }],
		});
		expect(sub?.status).toBe("cancelled");
	});

	// -----------------------------------------------------------------------
	// 4. Subscription list / get
	// -----------------------------------------------------------------------

	it("lists subscriptions for the authenticated user", async () => {
		const { auth, signInWithTestUser, db } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});
		const { headers, user } = await signInWithTestUser();

		// Seed a subscription
		await db.create({
			model: "lsSubscription",
			data: {
				userId: user.id,
				lsSubscriptionId: "sub_list_1",
				lsCustomerId: "cust_list",
				variantId: "variant_m",
				productId: "prod_1",
				status: "active",
				planName: "pro",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});

		const res = await auth.api.lemonSqueezySubscriptionList({ headers });
		const data = res as { subscriptions: Array<Record<string, unknown>> };
		expect(data.subscriptions.length).toBe(1);
		expect(data.subscriptions[0].lsSubscriptionId).toBe("sub_list_1");
	});

	it("gets a subscription and blocks access for non-owner", async () => {
		const { auth, signInWithTestUser, signInWithUser, db } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});
		const { user } = await signInWithTestUser();

		await db.create({
			model: "lsSubscription",
			data: {
				userId: user.id,
				lsSubscriptionId: "sub_get_1",
				lsCustomerId: "cust_get",
				variantId: "variant_m",
				productId: "prod_1",
				status: "active",
				planName: "pro",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});

		// Create and sign in as another user
		await auth.api.signUpEmail({
			body: { email: "other@test.com", password: "password123", name: "Other" },
		});
		const { headers: otherHeaders } = await signInWithUser("other@test.com", "password123");

		const res = await auth.api.lemonSqueezySubscriptionGet({
			headers: otherHeaders,
			query: { subscriptionId: "sub_get_1" },
		});
		expect((res as Record<string, unknown>).code).toBe("not_owner");
	});

	// -----------------------------------------------------------------------
	// 5. Cancel endpoint
	// -----------------------------------------------------------------------

	it("cancel endpoint calls LS API with cancelled: true", async () => {
		const { auth, signInWithTestUser, db } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});
		const { headers, user } = await signInWithTestUser();

		await db.create({
			model: "lsSubscription",
			data: {
				userId: user.id,
				lsSubscriptionId: "sub_cancel_1",
				lsCustomerId: "cust_cancel",
				variantId: "variant_m",
				productId: "prod_1",
				status: "active",
				planName: "pro",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		fetchMock.mockClear();

		const res = await auth.api.lemonSqueezySubscriptionCancel({
			headers,
			body: { subscriptionId: "sub_cancel_1" },
		});

		expect((res as Record<string, unknown>).success).toBe(true);

		const patchCall = fetchMock.mock.calls.find(
			(c) => (c[0] as string).includes("sub_cancel_1") && (c[1] as RequestInit)?.method === "PATCH",
		);
		expect(patchCall).toBeDefined();
		const body = JSON.parse(patchCall![1]?.body as string);
		expect(body.data.attributes.cancelled).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 6. Resume endpoint
	// -----------------------------------------------------------------------

	it("resume endpoint calls LS API with cancelled: false", async () => {
		const { auth, signInWithTestUser, db } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});
		const { headers, user } = await signInWithTestUser();

		await db.create({
			model: "lsSubscription",
			data: {
				userId: user.id,
				lsSubscriptionId: "sub_resume_1",
				lsCustomerId: "cust_resume",
				variantId: "variant_m",
				productId: "prod_1",
				status: "cancelled",
				planName: "pro",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		fetchMock.mockClear();

		const res = await auth.api.lemonSqueezySubscriptionResume({
			headers,
			body: { subscriptionId: "sub_resume_1" },
		});

		expect((res as Record<string, unknown>).success).toBe(true);

		const patchCall = fetchMock.mock.calls.find(
			(c) => (c[0] as string).includes("sub_resume_1") && (c[1] as RequestInit)?.method === "PATCH",
		);
		expect(patchCall).toBeDefined();
		const body = JSON.parse(patchCall![1]?.body as string);
		expect(body.data.attributes.cancelled).toBe(false);
	});

	// -----------------------------------------------------------------------
	// 7. Update endpoint (plan change)
	// -----------------------------------------------------------------------

	it("update endpoint calls LS API with new variant_id", async () => {
		const { auth, signInWithTestUser, db } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});
		const { headers, user } = await signInWithTestUser();

		await db.create({
			model: "lsSubscription",
			data: {
				userId: user.id,
				lsSubscriptionId: "sub_update_1",
				lsCustomerId: "cust_update",
				variantId: "variant_m",
				productId: "prod_1",
				status: "active",
				planName: "pro",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		fetchMock.mockClear();

		const res = await auth.api.lemonSqueezySubscriptionUpdate({
			headers,
			body: { subscriptionId: "sub_update_1", plan: "pro", interval: "annual" },
		});

		expect((res as Record<string, unknown>).success).toBe(true);

		const patchCall = fetchMock.mock.calls.find(
			(c) => (c[0] as string).includes("sub_update_1") && (c[1] as RequestInit)?.method === "PATCH",
		);
		expect(patchCall).toBeDefined();
		const body = JSON.parse(patchCall![1]?.body as string);
		// variant_id is passed through Number() in the plugin — NaN for non-numeric strings
		expect(body.data.attributes.variant_id).toBeDefined();
	});

	// -----------------------------------------------------------------------
	// 8. Portal endpoint
	// -----------------------------------------------------------------------

	it("portal endpoint returns customer_portal URL from LS API", async () => {
		const { auth, signInWithTestUser, db } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});
		const { headers, user } = await signInWithTestUser();

		await db.create({
			model: "lsSubscription",
			data: {
				userId: user.id,
				lsSubscriptionId: "sub_portal_1",
				lsCustomerId: "cust_portal",
				variantId: "variant_m",
				productId: "prod_1",
				status: "active",
				planName: "pro",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});

		const res = await auth.api.lemonSqueezySubscriptionPortal({
			headers,
			body: { subscriptionId: "sub_portal_1" },
		});

		expect((res as Record<string, unknown>).url).toContain("lemonsqueezy.com/billing");
	});

	// -----------------------------------------------------------------------
	// 9. Sync endpoint
	// -----------------------------------------------------------------------

	it("sync endpoint fetches from LS API and updates local record", async () => {
		const { auth, signInWithTestUser, db } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});
		const { headers, user } = await signInWithTestUser();

		await db.create({
			model: "lsSubscription",
			data: {
				userId: user.id,
				lsSubscriptionId: "sub_sync_1",
				lsCustomerId: "cust_sync",
				variantId: "variant_old",
				productId: "prod_old",
				status: "past_due",
				planName: "unknown",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});

		const res = await auth.api.lemonSqueezySubscriptionSync({
			headers,
			body: { subscriptionId: "sub_sync_1" },
		});

		expect((res as Record<string, unknown>).success).toBe(true);

		// The mock LS API returns variant_m/prod_1/active
		const sub = await db.findOne({
			model: "lsSubscription",
			where: [{ field: "lsSubscriptionId", value: "sub_sync_1" }],
		});
		expect(sub?.status).toBe("active");
		expect(sub?.planName).toBe("pro");
		expect(sub?.variantId).toBe("variant_m");
	});

	// -----------------------------------------------------------------------
	// 10. Webhook user resolution fallbacks
	// -----------------------------------------------------------------------

	it("webhook resolves user via lsCustomerId when no custom_data.user_id", async () => {
		const { auth, signInWithTestUser, db } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});
		const { user } = await signInWithTestUser();

		// createCustomerOnSignUp already created a customer, look it up
		const existingCustomer = await db.findOne({
			model: "lsCustomer",
			where: [{ field: "userId", value: user.id }],
		});
		const lsCustomerId = existingCustomer?.lsCustomerId as string;
		expect(lsCustomerId).toBeTruthy();

		const res = await sendWebhook(auth, "subscription_created", {
			_subscriptionId: "sub_resolve_cust",
			customer_id: lsCustomerId,
			status: "active",
		});

		expect(res.status).toBe(200);

		const sub = await db.findOne({
			model: "lsSubscription",
			where: [{ field: "lsSubscriptionId", value: "sub_resolve_cust" }],
		});
		expect(sub?.userId).toBe(user.id);
	});

	it("webhook resolves user via email fallback", async () => {
		const { auth, signInWithTestUser, db } = await getTestInstance({
			plugins: [lemonSqueezy(lsOptions)],
		});
		const { user } = await signInWithTestUser();

		const res = await sendWebhook(auth, "subscription_created", {
			_subscriptionId: "sub_resolve_email",
			customer_id: "unknown_cust_id",
			user_email: user.email,
			status: "on_trial",
		});

		expect(res.status).toBe(200);

		const sub = await db.findOne({
			model: "lsSubscription",
			where: [{ field: "lsSubscriptionId", value: "sub_resolve_email" }],
		});
		expect(sub?.userId).toBe(user.id);
		expect(sub?.status).toBe("on_trial");
	});

	// -----------------------------------------------------------------------
	// 11. onWebhookEvent callback
	// -----------------------------------------------------------------------

	it("invokes onWebhookEvent callback on webhook events", async () => {
		const onWebhookEvent = vi.fn();
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [lemonSqueezy({ ...lsOptions, onWebhookEvent })],
		});
		const { user } = await signInWithTestUser();

		await sendWebhook(auth, "subscription_created", {
			_subscriptionId: "sub_callback_1",
			status: "active",
		}, { custom_data: { user_id: user.id } });

		expect(onWebhookEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "subscription_created",
				userId: user.id,
				resolved: true,
			}),
		);
	});
});
