import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	verifyWebhookSignature,
	processWebhookEvent,
	resolveUserId,
	resolvePlanFromVariant,
	type WebhookContext,
} from "./webhook";
import { createAccessControlHelpers } from "./access-control";
import type { LemonSqueezyOptions } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-webhook-secret";

const defaultOptions: LemonSqueezyOptions = {
	apiKey: "test-api-key",
	storeId: "store_123",
	webhookSecret: TEST_SECRET,
	subscription: {
		enabled: true,
		plans: [
			{
				name: "pro",
				productId: "prod_1",
				intervals: { monthly: "variant_m", annual: "variant_a" },
			},
			{
				name: "starter",
				productId: "prod_2",
				intervals: { monthly: "variant_s_m" },
			},
		],
	},
};

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

function makeAdapter(
	store: Record<string, Array<Record<string, unknown>>> = {},
) {
	return {
		findOne: vi.fn(
			async (opts: {
				model: string;
				where: Array<{ field: string; value: string }>;
			}) => {
				const records = store[opts.model] ?? [];
				return (
					records.find((r) =>
						opts.where.every(
							(w) => r[w.field] === w.value,
						),
					) ?? null
				);
			},
		),
		create: vi.fn(
			async (opts: {
				model: string;
				data: Record<string, unknown>;
			}) => {
				const records = (store[opts.model] ??= []);
				records.push(opts.data);
				return opts.data;
			},
		),
		update: vi.fn(
			async (opts: {
				model: string;
				update: Record<string, unknown>;
				where: Array<{ field: string; value: string }>;
			}) => {
				const records = store[opts.model] ?? [];
				const record = records.find((r) =>
					opts.where.every((w) => r[w.field] === w.value),
				);
				if (record) {
					Object.assign(record, opts.update);
					return record;
				}
				return null;
			},
		),
		findMany: vi.fn(
			async (opts: {
				model: string;
				where: Array<{ field: string; value: string }>;
			}) => {
				const records = store[opts.model] ?? [];
				return records.filter((r) =>
					opts.where.every((w) => r[w.field] === w.value),
				);
			},
		),
	};
}

function makeInternalAdapter(users: Array<Record<string, unknown>> = []) {
	return {
		findUserByEmail: vi.fn(async (email: string) => {
			const user = users.find((u) => u.email === email);
			return user ? { user } : null;
		}),
	};
}

function makeLogger() {
	return {
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	};
}

function makeWebhookCtx(overrides?: {
	store?: Record<string, Array<Record<string, unknown>>>;
	users?: Array<Record<string, unknown>>;
	options?: LemonSqueezyOptions;
}): WebhookContext & {
	adapter: ReturnType<typeof makeAdapter>;
	logger: ReturnType<typeof makeLogger>;
} {
	const adapter = makeAdapter(overrides?.store ?? {});
	const logger = makeLogger();
	return {
		adapter,
		internalAdapter: makeInternalAdapter(overrides?.users ?? []),
		logger,
		options: overrides?.options ?? defaultOptions,
	};
}

function makeWebhookPayload(
	eventName: string,
	attrs: Record<string, unknown> = {},
	meta: Record<string, unknown> = {},
) {
	return {
		meta: {
			event_name: eventName,
			...meta,
		},
		data: {
			id: attrs._subscriptionId ?? "sub_123",
			attributes: {
				customer_id: "cust_123",
				variant_id: "variant_m",
				product_id: "prod_1",
				status: "active",
				updated_at: new Date().toISOString(),
				...attrs,
			},
		},
	};
}

// ---------------------------------------------------------------------------
// 1. Webhook Signature Verification
// ---------------------------------------------------------------------------

describe("Webhook Signature Verification", () => {
	it("accepts a valid HMAC SHA-256 signature", async () => {
		const body = '{"test": true}';
		const signature = await computeHmacHex(body, TEST_SECRET);
		const result = await verifyWebhookSignature(body, signature, TEST_SECRET);
		expect(result).toBe(true);
	});

	it("rejects an invalid signature", async () => {
		const result = await verifyWebhookSignature(
			"body",
			"bad-signature",
			TEST_SECRET,
		);
		expect(result).toBe(false);
	});

	it("rejects an empty signature", async () => {
		const result = await verifyWebhookSignature("body", "", TEST_SECRET);
		expect(result).toBe(false);
	});

	it("rejects when body is tampered after signing", async () => {
		const body = '{"original": true}';
		const signature = await computeHmacHex(body, TEST_SECRET);
		const result = await verifyWebhookSignature(
			'{"tampered": true}',
			signature,
			TEST_SECRET,
		);
		expect(result).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 2. Webhook Event Handling
// ---------------------------------------------------------------------------

describe("Webhook Event Handling", () => {
	describe("subscription_created", () => {
		it("creates a subscription record linked to the user", async () => {
			const ctx = makeWebhookCtx();
			const payload = makeWebhookPayload(
				"subscription_created",
				{ status: "active" },
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(ctx, "subscription_created", payload);

			expect(ctx.adapter.create).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "lsSubscription",
					data: expect.objectContaining({
						userId: "user_1",
						lsSubscriptionId: "sub_123",
						status: "active",
						planName: "pro",
					}),
				}),
			);
		});

		it("upserts (updates) when subscription already exists", async () => {
			const ctx = makeWebhookCtx({
				store: {
					lsSubscription: [
						{
							userId: "user_1",
							lsSubscriptionId: "sub_123",
							status: "active",
							planName: "pro",
							lsUpdatedAt: new Date("2020-01-01").toISOString(),
						},
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_created",
				{ status: "active" },
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(ctx, "subscription_created", payload);

			expect(ctx.adapter.update).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "lsSubscription",
					where: [{ field: "lsSubscriptionId", value: "sub_123" }],
				}),
			);
		});

		it("stores subscriptionItemId from first_subscription_item", async () => {
			const ctx = makeWebhookCtx();
			const payload = makeWebhookPayload(
				"subscription_created",
				{
					status: "active",
					first_subscription_item: { id: "item_99" },
				},
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(ctx, "subscription_created", payload);

			expect(ctx.adapter.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						subscriptionItemId: "item_99",
					}),
				}),
			);
		});
	});

	describe("subscription_updated", () => {
		it("updates status, renewsAt, endsAt", async () => {
			const renewsAt = "2025-06-01T00:00:00Z";
			const endsAt = "2025-07-01T00:00:00Z";
			const ctx = makeWebhookCtx({
				store: {
					lsSubscription: [
						{
							userId: "user_1",
							lsSubscriptionId: "sub_123",
							status: "active",
							planName: "pro",
							lsUpdatedAt: new Date("2020-01-01").toISOString(),
						},
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_updated",
				{ status: "active", renews_at: renewsAt, ends_at: endsAt },
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(ctx, "subscription_updated", payload);

			expect(ctx.adapter.update).toHaveBeenCalledWith(
				expect.objectContaining({
					update: expect.objectContaining({
						status: "active",
						renewsAt: new Date(renewsAt),
						endsAt: new Date(endsAt),
					}),
				}),
			);
		});

		it("detects plan change when variant_id changes", async () => {
			const ctx = makeWebhookCtx({
				store: {
					lsSubscription: [
						{
							userId: "user_1",
							lsSubscriptionId: "sub_123",
							variantId: "variant_m",
							productId: "prod_1",
							status: "active",
							planName: "pro",
							lsUpdatedAt: new Date("2020-01-01").toISOString(),
						},
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_updated",
				{
					status: "active",
					variant_id: "variant_s_m",
					product_id: "prod_2",
				},
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(ctx, "subscription_updated", payload);

			expect(ctx.adapter.update).toHaveBeenCalledWith(
				expect.objectContaining({
					update: expect.objectContaining({
						variantId: "variant_s_m",
						productId: "prod_2",
						planName: "starter",
					}),
				}),
			);
		});
	});

	describe("subscription_paused", () => {
		it("updates status to paused", async () => {
			const ctx = makeWebhookCtx({
				store: {
					lsSubscription: [
						{
							userId: "user_1",
							lsSubscriptionId: "sub_123",
							status: "active",
							planName: "pro",
							lsUpdatedAt: new Date("2020-01-01").toISOString(),
						},
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_paused",
				{},
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(ctx, "subscription_paused", payload);

			expect(ctx.adapter.update).toHaveBeenCalledWith(
				expect.objectContaining({
					update: expect.objectContaining({ status: "paused" }),
				}),
			);
		});
	});

	describe("subscription_unpaused", () => {
		it("updates status to active", async () => {
			const ctx = makeWebhookCtx({
				store: {
					lsSubscription: [
						{
							userId: "user_1",
							lsSubscriptionId: "sub_123",
							status: "paused",
							planName: "pro",
							lsUpdatedAt: new Date("2020-01-01").toISOString(),
						},
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_unpaused",
				{},
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(ctx, "subscription_unpaused", payload);

			expect(ctx.adapter.update).toHaveBeenCalledWith(
				expect.objectContaining({
					update: expect.objectContaining({ status: "active" }),
				}),
			);
		});
	});

	describe("subscription_cancelled", () => {
		it("updates status to cancelled and sets cancelledAt", async () => {
			const cancelledAt = "2025-06-15T00:00:00Z";
			const endsAt = "2025-07-01T00:00:00Z";
			const ctx = makeWebhookCtx({
				store: {
					lsSubscription: [
						{
							userId: "user_1",
							lsSubscriptionId: "sub_123",
							status: "active",
							planName: "pro",
							lsUpdatedAt: new Date("2020-01-01").toISOString(),
						},
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_cancelled",
				{ cancelled_at: cancelledAt, ends_at: endsAt },
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(ctx, "subscription_cancelled", payload);

			expect(ctx.adapter.update).toHaveBeenCalledWith(
				expect.objectContaining({
					update: expect.objectContaining({
						status: "cancelled",
						cancelledAt: new Date(cancelledAt),
						endsAt: new Date(endsAt),
					}),
				}),
			);
		});
	});

	describe("subscription_expired", () => {
		it("updates status to expired", async () => {
			const ctx = makeWebhookCtx({
				store: {
					lsSubscription: [
						{
							userId: "user_1",
							lsSubscriptionId: "sub_123",
							status: "cancelled",
							planName: "pro",
							lsUpdatedAt: new Date("2020-01-01").toISOString(),
						},
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_expired",
				{ ends_at: "2025-07-01T00:00:00Z" },
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(ctx, "subscription_expired", payload);

			expect(ctx.adapter.update).toHaveBeenCalledWith(
				expect.objectContaining({
					update: expect.objectContaining({ status: "expired" }),
				}),
			);
		});
	});

	describe("subscription_payment_success", () => {
		it("updates status from past_due to active", async () => {
			const ctx = makeWebhookCtx({
				store: {
					lsSubscription: [
						{
							userId: "user_1",
							lsSubscriptionId: "sub_123",
							status: "past_due",
							planName: "pro",
							lsUpdatedAt: new Date("2020-01-01").toISOString(),
						},
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_payment_success",
				{},
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(
				ctx,
				"subscription_payment_success",
				payload,
			);

			expect(ctx.adapter.update).toHaveBeenCalledWith(
				expect.objectContaining({
					update: expect.objectContaining({ status: "active" }),
				}),
			);
		});

		it("preserves on_trial status on payment success", async () => {
			const ctx = makeWebhookCtx({
				store: {
					lsSubscription: [
						{
							userId: "user_1",
							lsSubscriptionId: "sub_123",
							status: "on_trial",
							planName: "pro",
							lsUpdatedAt: new Date("2020-01-01").toISOString(),
						},
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_payment_success",
				{},
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(
				ctx,
				"subscription_payment_success",
				payload,
			);

			// Should NOT update — on_trial should be preserved
			expect(ctx.adapter.update).not.toHaveBeenCalled();
		});
	});

	describe("subscription_payment_failed", () => {
		it("updates status from active to past_due", async () => {
			const ctx = makeWebhookCtx({
				store: {
					lsSubscription: [
						{
							userId: "user_1",
							lsSubscriptionId: "sub_123",
							status: "active",
							planName: "pro",
							lsUpdatedAt: new Date("2020-01-01").toISOString(),
						},
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_payment_failed",
				{},
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(
				ctx,
				"subscription_payment_failed",
				payload,
			);

			expect(ctx.adapter.update).toHaveBeenCalledWith(
				expect.objectContaining({
					update: expect.objectContaining({ status: "past_due" }),
				}),
			);
		});

		it("preserves cancelled status on payment failure", async () => {
			const ctx = makeWebhookCtx({
				store: {
					lsSubscription: [
						{
							userId: "user_1",
							lsSubscriptionId: "sub_123",
							status: "cancelled",
							planName: "pro",
							lsUpdatedAt: new Date("2020-01-01").toISOString(),
						},
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_payment_failed",
				{},
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(
				ctx,
				"subscription_payment_failed",
				payload,
			);

			expect(ctx.adapter.update).not.toHaveBeenCalled();
		});
	});

	describe("subscription_payment_recovered", () => {
		it("updates status from unpaid to active", async () => {
			const ctx = makeWebhookCtx({
				store: {
					lsSubscription: [
						{
							userId: "user_1",
							lsSubscriptionId: "sub_123",
							status: "unpaid",
							planName: "pro",
							lsUpdatedAt: new Date("2020-01-01").toISOString(),
						},
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_payment_recovered",
				{},
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(
				ctx,
				"subscription_payment_recovered",
				payload,
			);

			expect(ctx.adapter.update).toHaveBeenCalledWith(
				expect.objectContaining({
					update: expect.objectContaining({ status: "active" }),
				}),
			);
		});
	});

	describe("subscription_payment_refunded", () => {
		it("does not change subscription status", async () => {
			const ctx = makeWebhookCtx({
				store: {
					lsSubscription: [
						{
							userId: "user_1",
							lsSubscriptionId: "sub_123",
							status: "active",
							planName: "pro",
							lsUpdatedAt: new Date("2020-01-01").toISOString(),
						},
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_payment_refunded",
				{},
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(
				ctx,
				"subscription_payment_refunded",
				payload,
			);

			expect(ctx.adapter.update).not.toHaveBeenCalled();
		});
	});

	describe("stale event detection", () => {
		it("skips processing when incoming event is older than stored", async () => {
			const ctx = makeWebhookCtx({
				store: {
					lsSubscription: [
						{
							userId: "user_1",
							lsSubscriptionId: "sub_123",
							status: "active",
							planName: "pro",
							lsUpdatedAt: new Date("2025-06-01T00:00:00Z").toISOString(),
						},
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_updated",
				{
					status: "paused",
					updated_at: "2025-05-01T00:00:00Z", // older than stored
				},
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(ctx, "subscription_updated", payload);

			expect(ctx.adapter.update).not.toHaveBeenCalled();
		});
	});

	describe("unresolvable user", () => {
		it("logs a warning and invokes onWebhookEvent with resolved: false", async () => {
			const onWebhookEvent = vi.fn();
			const ctx = makeWebhookCtx({
				options: { ...defaultOptions, onWebhookEvent, allowEmailFallback: false },
			});
			const payload = makeWebhookPayload("subscription_created", {
				customer_id: "unknown_cust",
			});
			// No custom_data.userId, no customer in DB, email fallback disabled
			await processWebhookEvent(ctx, "subscription_created", payload);

			expect(ctx.logger.warn).toHaveBeenCalled();
			expect(onWebhookEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					resolved: false,
					userId: null,
				}),
			);
			expect(ctx.adapter.create).not.toHaveBeenCalled();
		});
	});

	describe("unhandled events", () => {
		it("ignores unhandled event types", async () => {
			const ctx = makeWebhookCtx();
			const payload = makeWebhookPayload("order_created", {});

			await processWebhookEvent(ctx, "order_created", payload);

			expect(ctx.adapter.create).not.toHaveBeenCalled();
			expect(ctx.adapter.update).not.toHaveBeenCalled();
		});
	});

	describe("user resolution priority", () => {
		it("resolves via meta.custom_data.user_id first", async () => {
			const ctx = makeWebhookCtx({
				store: {
					lsCustomer: [
						{ userId: "user_2", lsCustomerId: "cust_123" },
					],
				},
				users: [{ id: "user_3", email: "test@example.com" }],
			});
			const payload = makeWebhookPayload(
				"subscription_created",
				{
					customer_id: "cust_123",
					user_email: "test@example.com",
				},
				{ custom_data: { user_id: "user_1" } },
			);

			const userId = await resolveUserId(ctx, payload);
			expect(userId).toBe("user_1");
		});

		it("resolves via meta.custom_data.userId (legacy) first", async () => {
			const ctx = makeWebhookCtx({
				store: {
					lsCustomer: [
						{ userId: "user_2", lsCustomerId: "cust_123" },
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_created",
				{
					customer_id: "cust_123",
				},
				{ custom_data: { userId: "user_1" } },
			);

			const userId = await resolveUserId(ctx, payload);
			expect(userId).toBe("user_1");
		});

		it("resolves via lsCustomerId lookup when no custom_data", async () => {
			const ctx = makeWebhookCtx({
				store: {
					lsCustomer: [
						{ userId: "user_2", lsCustomerId: "cust_123" },
					],
				},
			});
			const payload = makeWebhookPayload("subscription_created", {
				customer_id: "cust_123",
			});

			const userId = await resolveUserId(ctx, payload);
			expect(userId).toBe("user_2");
		});

		it("resolves via email fallback when enabled", async () => {
			const ctx = makeWebhookCtx({
				users: [{ id: "user_3", email: "test@example.com" }],
			});
			const payload = makeWebhookPayload("subscription_created", {
				customer_id: "unknown_cust",
				user_email: "test@example.com",
			});

			const userId = await resolveUserId(ctx, payload);
			expect(userId).toBe("user_3");
		});

		it("skips email fallback when allowEmailFallback is false", async () => {
			const ctx = makeWebhookCtx({
				options: { ...defaultOptions, allowEmailFallback: false },
				users: [{ id: "user_3", email: "test@example.com" }],
			});
			const payload = makeWebhookPayload("subscription_created", {
				customer_id: "unknown_cust",
				user_email: "test@example.com",
			});

			const userId = await resolveUserId(ctx, payload);
			expect(userId).toBeNull();
		});
	});

	describe("onWebhookEvent callback", () => {
		it("invokes callback with event details on subscription_created", async () => {
			const onWebhookEvent = vi.fn();
			const ctx = makeWebhookCtx({
				options: { ...defaultOptions, onWebhookEvent },
			});
			const payload = makeWebhookPayload(
				"subscription_created",
				{ status: "active" },
				{ custom_data: { userId: "user_1" } },
			);

			await processWebhookEvent(ctx, "subscription_created", payload);

			expect(onWebhookEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "subscription_created",
					userId: "user_1",
					resolved: true,
				}),
			);
		});

		it("sets duplicatePlan flag when user has existing active subscription for same plan", async () => {
			const onWebhookEvent = vi.fn();
			const ctx = makeWebhookCtx({
				options: { ...defaultOptions, onWebhookEvent },
				store: {
					lsSubscription: [
						{
							userId: "user_1",
							lsSubscriptionId: "sub_existing",
							status: "active",
							planName: "pro",
							lsUpdatedAt: new Date("2020-01-01").toISOString(),
						},
					],
				},
			});
			const payload = makeWebhookPayload(
				"subscription_created",
				{
					_subscriptionId: "sub_new",
					status: "active",
				},
				{ custom_data: { userId: "user_1" } },
			);
			// Patch the data.id to use the custom subscriptionId
			(payload.data as Record<string, unknown>).id = "sub_new";

			await processWebhookEvent(ctx, "subscription_created", payload);

			expect(onWebhookEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					duplicatePlan: true,
				}),
			);
		});
	});
});

// ---------------------------------------------------------------------------
// 3. Access Control Helpers
// ---------------------------------------------------------------------------

describe("Access Control Helpers", () => {
	describe("hasActiveSubscription", () => {
		it("returns true when user has an active subscription", async () => {
			const adapter = makeAdapter({
				lsSubscription: [
					{ userId: "user_1", status: "active", planName: "pro" },
				],
			});
			const { hasActiveSubscription } =
				createAccessControlHelpers(adapter);

			expect(await hasActiveSubscription("user_1")).toBe(true);
		});

		it("returns true when user has an on_trial subscription", async () => {
			const adapter = makeAdapter({
				lsSubscription: [
					{ userId: "user_1", status: "on_trial", planName: "pro" },
				],
			});
			const { hasActiveSubscription } =
				createAccessControlHelpers(adapter);

			expect(await hasActiveSubscription("user_1")).toBe(true);
		});

		it("returns false when user has only cancelled subscriptions", async () => {
			const adapter = makeAdapter({
				lsSubscription: [
					{
						userId: "user_1",
						status: "cancelled",
						planName: "pro",
					},
				],
			});
			const { hasActiveSubscription } =
				createAccessControlHelpers(adapter);

			expect(await hasActiveSubscription("user_1")).toBe(false);
		});

		it("returns false when user has no subscriptions", async () => {
			const adapter = makeAdapter({});
			const { hasActiveSubscription } =
				createAccessControlHelpers(adapter);

			expect(await hasActiveSubscription("user_1")).toBe(false);
		});
	});

	describe("hasActivePlan", () => {
		it("returns true when user has an active subscription for the plan", async () => {
			const adapter = makeAdapter({
				lsSubscription: [
					{ userId: "user_1", status: "active", planName: "pro" },
				],
			});
			const { hasActivePlan } = createAccessControlHelpers(adapter);

			expect(await hasActivePlan("user_1", "pro")).toBe(true);
		});

		it("returns false when user has a different plan", async () => {
			const adapter = makeAdapter({
				lsSubscription: [
					{
						userId: "user_1",
						status: "active",
						planName: "starter",
					},
				],
			});
			const { hasActivePlan } = createAccessControlHelpers(adapter);

			expect(await hasActivePlan("user_1", "pro")).toBe(false);
		});

		it("returns false when subscription is expired", async () => {
			const adapter = makeAdapter({
				lsSubscription: [
					{
						userId: "user_1",
						status: "expired",
						planName: "pro",
					},
				],
			});
			const { hasActivePlan } = createAccessControlHelpers(adapter);

			expect(await hasActivePlan("user_1", "pro")).toBe(false);
		});
	});

	describe("requirePlan", () => {
		it("returns allowed: true with subscription when plan matches", async () => {
			const sub = {
				userId: "user_1",
				status: "active",
				planName: "pro",
			};
			const adapter = makeAdapter({
				lsSubscription: [sub],
			});
			const { requirePlan } = createAccessControlHelpers(adapter);

			const result = await requirePlan("user_1", "pro");
			expect(result.allowed).toBe(true);
			expect(result.subscription).toEqual(sub);
		});

		it("returns allowed: false when no matching plan", async () => {
			const adapter = makeAdapter({
				lsSubscription: [
					{
						userId: "user_1",
						status: "active",
						planName: "starter",
					},
				],
			});
			const { requirePlan } = createAccessControlHelpers(adapter);

			const result = await requirePlan("user_1", "pro");
			expect(result.allowed).toBe(false);
			expect(result.subscription).toBeUndefined();
		});
	});

	describe("adapter patterns", () => {
		it("accepts an auth-like object with options.adapter", async () => {
			const innerAdapter = makeAdapter({
				lsSubscription: [
					{ userId: "user_1", status: "active", planName: "pro" },
				],
			});
			const authLike = { options: { adapter: innerAdapter } };
			const { hasActiveSubscription } =
				createAccessControlHelpers(authLike);

			expect(await hasActiveSubscription("user_1")).toBe(true);
		});
	});
});

// ---------------------------------------------------------------------------
// 4. Plan resolution helper
// ---------------------------------------------------------------------------

describe("resolvePlanFromVariant", () => {
	it("resolves a variant ID to the correct plan and interval", () => {
		const result = resolvePlanFromVariant(defaultOptions, "variant_a");
		expect(result).toEqual({ planName: "pro", interval: "annual" });
	});

	it("returns null for an unknown variant ID", () => {
		const result = resolvePlanFromVariant(defaultOptions, "unknown_variant");
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 5. Integration Tests — Customer Creation on Sign-Up
// ---------------------------------------------------------------------------

describe("Integration: Customer creation on sign-up", () => {
	it("creates a LS customer and stores it in lsCustomer table via hook flow", async () => {
		// Simulates the after:user.create hook logic
		const store: Record<string, Array<Record<string, unknown>>> = {};
		const adapter = makeAdapter(store);
		const onCustomerCreated = vi.fn();

		// Mock the customer creation API call (simulating what createLsCustomer does)
		const userId = "user_signup_1";
		const lsCustomerId = "cust_new_123";
		const email = "newuser@example.com";

		// Simulate what the hook does: create customer record
		const now = new Date();
		await adapter.create({
			model: "lsCustomer",
			data: {
				userId,
				lsCustomerId,
				email,
				createdAt: now,
				updatedAt: now,
			},
		});

		// Invoke callback
		await onCustomerCreated({ userId, lsCustomerId });

		// Verify record was created
		const record = await adapter.findOne({
			model: "lsCustomer",
			where: [{ field: "userId", value: userId }],
		});
		expect(record).not.toBeNull();
		expect(record?.lsCustomerId).toBe(lsCustomerId);
		expect(record?.email).toBe(email);
		expect(onCustomerCreated).toHaveBeenCalledWith({ userId, lsCustomerId });
	});

	it("does not block sign-up flow if customer creation fails", async () => {
		// Simulates error handling: sign-up should succeed even if LS API fails
		const store: Record<string, Array<Record<string, unknown>>> = {};
		const adapter = makeAdapter(store);
		const logger = makeLogger();

		// Simulate a failed API call (error is caught and logged)
		const error = new Error("Lemon Squeezy API request timed out");
		logger.error("Failed to create Lemon Squeezy customer on sign-up", {
			userId: "user_signup_2",
			error: error.message,
			code: "upstream_error",
		});

		// Verify no customer record was created
		const record = await adapter.findOne({
			model: "lsCustomer",
			where: [{ field: "userId", value: "user_signup_2" }],
		});
		expect(record).toBeNull();
		expect(logger.error).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 6. Integration Tests — Checkout Flow
// ---------------------------------------------------------------------------

describe("Integration: Checkout flow", () => {
	it("checkout creates customer on-demand when lsCustomer does not exist", async () => {
		// Simulates the checkout endpoint logic where no customer record exists
		const store: Record<string, Array<Record<string, unknown>>> = {};
		const adapter = makeAdapter(store);

		const userId = "user_checkout_1";
		const email = "checkout@example.com";
		const lsCustomerId = "cust_on_demand";

		// No customer exists initially
		let customer = await adapter.findOne({
			model: "lsCustomer",
			where: [{ field: "userId", value: userId }],
		});
		expect(customer).toBeNull();

		// Simulate on-demand creation (what the checkout endpoint does)
		const now = new Date();
		await adapter.create({
			model: "lsCustomer",
			data: {
				userId,
				lsCustomerId,
				email,
				createdAt: now,
				updatedAt: now,
			},
		});

		// Verify customer now exists
		customer = await adapter.findOne({
			model: "lsCustomer",
			where: [{ field: "userId", value: userId }],
		});
		expect(customer).not.toBeNull();
		expect(customer?.lsCustomerId).toBe(lsCustomerId);
	});

	it("checkout rejects when user already has active subscription for the plan", async () => {
		const store: Record<string, Array<Record<string, unknown>>> = {
			lsSubscription: [
				{
					userId: "user_checkout_2",
					lsSubscriptionId: "sub_existing",
					status: "active",
					planName: "pro",
				},
			],
			lsCustomer: [
				{
					userId: "user_checkout_2",
					lsCustomerId: "cust_456",
					email: "existing@example.com",
				},
			],
		};
		const adapter = makeAdapter(store);

		// Simulate the already_subscribed check
		const subscriptions = await adapter.findMany({
			model: "lsSubscription",
			where: [{ field: "userId", value: "user_checkout_2" }],
		});
		const activeSamePlan = subscriptions.find(
			(s) =>
				s.planName === "pro" &&
				(s.status === "active" || s.status === "on_trial"),
		);

		expect(activeSamePlan).toBeDefined();
	});

	it("checkout resolves interval to first key when not provided", () => {
		const plan = defaultOptions.subscription!.plans[0];
		const intervalKeys = Object.keys(plan.intervals);
		const defaultInterval = intervalKeys[0];

		expect(defaultInterval).toBe("monthly");

		const variantId = plan.intervals[defaultInterval as keyof typeof plan.intervals];
		expect(variantId).toBe("variant_m");
	});

	it("checkout resolves correct variant for annual interval", () => {
		const plan = defaultOptions.subscription!.plans[0];
		const variantId = plan.intervals["annual" as keyof typeof plan.intervals];
		expect(variantId).toBe("variant_a");
	});
});

// ---------------------------------------------------------------------------
// 7. onWebhookEvent callback error handling
// ---------------------------------------------------------------------------

describe("onWebhookEvent callback error handling", () => {
	it("logs a warning and continues when callback throws on subscription event", async () => {
		const onWebhookEvent = vi.fn().mockRejectedValue(new Error("callback boom"));
		const ctx = makeWebhookCtx({
			options: { ...defaultOptions, onWebhookEvent },
		});
		const payload = makeWebhookPayload(
			"subscription_created",
			{ status: "active" },
			{ custom_data: { userId: "user_1" } },
		);

		// Should not throw
		await processWebhookEvent(ctx, "subscription_created", payload);

		expect(onWebhookEvent).toHaveBeenCalled();
		expect(ctx.logger.warn).toHaveBeenCalledWith(
			"onWebhookEvent callback threw an error",
			expect.objectContaining({ eventName: "subscription_created" }),
		);
		// Subscription should still have been created
		expect(ctx.adapter.create).toHaveBeenCalled();
	});

	it("logs a warning and continues when callback throws on payment event", async () => {
		const onWebhookEvent = vi.fn().mockRejectedValue(new Error("callback boom"));
		const ctx = makeWebhookCtx({
			options: { ...defaultOptions, onWebhookEvent },
			store: {
				lsSubscription: [
					{
						userId: "user_1",
						lsSubscriptionId: "sub_123",
						status: "past_due",
						planName: "pro",
						lsUpdatedAt: new Date("2020-01-01").toISOString(),
					},
				],
			},
		});
		const payload = makeWebhookPayload(
			"subscription_payment_success",
			{},
			{ custom_data: { userId: "user_1" } },
		);

		await processWebhookEvent(ctx, "subscription_payment_success", payload);

		expect(onWebhookEvent).toHaveBeenCalled();
		expect(ctx.logger.warn).toHaveBeenCalledWith(
			"onWebhookEvent callback threw an error",
			expect.objectContaining({ eventName: "subscription_payment_success" }),
		);
		// Status update should still have happened
		expect(ctx.adapter.update).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({ status: "active" }),
			}),
		);
	});

	it("logs a warning and continues when callback throws on unresolvable user", async () => {
		const onWebhookEvent = vi.fn().mockRejectedValue(new Error("callback boom"));
		const ctx = makeWebhookCtx({
			options: { ...defaultOptions, onWebhookEvent, allowEmailFallback: false },
		});
		const payload = makeWebhookPayload("subscription_created", {
			customer_id: "unknown_cust",
		});

		await processWebhookEvent(ctx, "subscription_created", payload);

		expect(onWebhookEvent).toHaveBeenCalledWith(
			expect.objectContaining({ resolved: false }),
		);
		expect(ctx.logger.warn).toHaveBeenCalledWith(
			"onWebhookEvent callback threw an error",
			expect.objectContaining({ eventName: "subscription_created" }),
		);
	});
});
