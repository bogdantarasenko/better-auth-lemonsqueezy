import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { z } from "zod";
import { schema } from "./schema";
import type { LemonSqueezyOptions } from "./types";
import {
	verifyWebhookSignature,
	processWebhookEvent,
	HANDLED_EVENTS,
	type WebhookContext,
} from "./webhook";

export type { LemonSqueezyOptions } from "./types";
export type {
	LemonSqueezyPlan,
	BillingInterval,
	SubscriptionConfig,
	SubscriptionStatus,
	OnCustomerCreatedCallback,
	OnWebhookEventCallback,
	WebhookEventPayload,
} from "./types";
export { createAccessControlHelpers } from "./access-control";

/** In-memory checkout cache: key -> { url, expiresAt } */
const checkoutCache = new Map<string, { url: string; expiresAt: number }>();

/** In-memory checkout locks: key -> Promise that resolves with the checkout URL */
const checkoutLocks = new Map<string, Promise<string>>();

/**
 * Create a Lemon Squeezy customer via API.
 * Returns the customer ID string.
 */
async function createLsCustomer(
	apiKey: string,
	storeId: string,
	email: string,
	name: string,
): Promise<string> {
	const response = await fetch(
		"https://api.lemonsqueezy.com/v1/customers",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/vnd.api+json",
				"Content-Type": "application/vnd.api+json",
			},
			body: JSON.stringify({
				data: {
					type: "customers",
					attributes: { name, email },
					relationships: {
						store: {
							data: { type: "stores", id: storeId },
						},
					},
				},
			}),
		},
	);

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`Failed to create LS customer: ${response.status} ${errorText}`,
		);
	}

	const result = (await response.json()) as { data: { id: string } };
	return result.data.id;
}

export const lemonSqueezy = (options: LemonSqueezyOptions) => {
	return {
		id: "lemonsqueezy",
		schema,
		init(ctx) {
			return {
				options: {
					databaseHooks: {
						user: {
							create: {
								async after(user) {
									if (!options.createCustomerOnSignUp || !user) return;

									try {
										const lsCustomerId = await createLsCustomer(
											options.apiKey,
											options.storeId,
											user.email,
											user.name,
										);

										const now = new Date();
										await ctx.adapter.create({
											model: "lsCustomer",
											data: {
												userId: user.id,
												lsCustomerId,
												email: user.email,
												createdAt: now,
												updatedAt: now,
											},
										});

										if (options.onCustomerCreated) {
											await options.onCustomerCreated({
												userId: user.id,
												lsCustomerId,
											});
										}
									} catch (error) {
										ctx.logger.error(
											"Error creating Lemon Squeezy customer on sign-up",
											error,
										);
									}
								},
							},
						},
					},
				},
			};
		},
		endpoints: {
			lemonSqueezyWebhook: createAuthEndpoint(
				"/lemonsqueezy/webhook",
				{
					method: "POST",
					requireRequest: true,
					metadata: {
						SERVER_ONLY: true,
					},
				},
				async (ctx) => {
					const request = ctx.request;
					if (!request) {
						throw new Error("Request object is required");
					}

					const rawBody = await request.text();
					const signature = request.headers.get("x-signature") ?? "";

					// Verify webhook signature
					const isValid = await verifyWebhookSignature(
						rawBody,
						signature,
						options.webhookSecret,
					);
					if (!isValid) {
						return ctx.json(
							{ error: "Invalid signature" },
							{ status: 400 },
						);
					}

					const payload = JSON.parse(rawBody) as Record<string, unknown>;
					const meta = payload.meta as
						| Record<string, unknown>
						| undefined;
					const eventName = (meta?.event_name as string) ?? "";

					// Build webhook context
					const webhookCtx: WebhookContext = {
						adapter: ctx.context.adapter,
						internalAdapter: ctx.context.internalAdapter,
						logger: ctx.context.logger,
						options,
					};

					await processWebhookEvent(webhookCtx, eventName, payload);

					return ctx.json({ success: true });
				},
			),

			lemonSqueezySubscriptionCreate: createAuthEndpoint(
				"/lemonsqueezy/subscription/create",
				{
					method: "POST",
					use: [sessionMiddleware],
					body: z.object({
						plan: z.string(),
						interval: z.string().optional(),
						successUrl: z.string().optional(),
						cancelUrl: z.string().optional(),
					}),
				},
				async (ctx) => {
					const userId = ctx.context.session.user.id;
					const userEmail = ctx.context.session.user.email;
					const userName = ctx.context.session.user.name;

					const { plan: planName, interval: requestedInterval, successUrl: bodySuccessUrl, cancelUrl: bodyCancelUrl } = ctx.body;

					// Resolve plan from config
					const plans = options.subscription?.plans ?? [];
					const plan = plans.find((p) => p.name === planName);
					if (!plan) {
						return ctx.json(
							{ error: "Plan not found", code: "plan_not_found" },
							{ status: 400 },
						);
					}

					// Resolve interval — default to first key in plan.intervals
					const intervalKeys = Object.keys(plan.intervals) as Array<string>;
					const interval = requestedInterval ?? intervalKeys[0];
					if (!interval) {
						return ctx.json(
							{ error: "No intervals configured for plan", code: "no_intervals" },
							{ status: 400 },
						);
					}

					const variantId = plan.intervals[interval as keyof typeof plan.intervals];
					if (!variantId) {
						return ctx.json(
							{ error: "Invalid interval for plan", code: "invalid_interval" },
							{ status: 400 },
						);
					}

					// Resolve success/cancel URLs
					const successUrl = bodySuccessUrl ?? options.defaultSuccessUrl;
					const cancelUrl = bodyCancelUrl ?? options.defaultCancelUrl;
					if (!successUrl || !cancelUrl) {
						return ctx.json(
							{ error: "Missing successUrl or cancelUrl", code: "missing_url" },
							{ status: 400 },
						);
					}

					// Check for existing active subscription for this plan
					const existingSubs = await ctx.context.adapter.findMany({
						model: "lsSubscription",
						where: [{ field: "userId", value: userId }],
					});
					const activeSamePlan = (existingSubs as Array<Record<string, unknown>>).find(
						(s) =>
							s.planName === planName &&
							(s.status === "active" || s.status === "on_trial"),
					);
					if (activeSamePlan) {
						return ctx.json(
							{ error: "User already has an active subscription for this plan", code: "already_subscribed" },
							{ status: 400 },
						);
					}

					// Idempotency: derive key from userId + plan + interval
					const idempotencyKey = `${userId}:${planName}:${interval}`;

					// Check cache first
					const cached = checkoutCache.get(idempotencyKey);
					if (cached && cached.expiresAt > Date.now()) {
						return ctx.json({ url: cached.url });
					}

					// Check if there's an in-flight request for this key
					const existingLock = checkoutLocks.get(idempotencyKey);
					if (existingLock) {
						const url = await existingLock;
						return ctx.json({ url });
					}

					// Create a new lock
					let resolveLock: (url: string) => void;
					let rejectLock: (err: unknown) => void;
					const lockPromise = new Promise<string>((resolve, reject) => {
						resolveLock = resolve;
						rejectLock = reject;
					});
					checkoutLocks.set(idempotencyKey, lockPromise);

					try {
						// Ensure customer exists
						let customerRecord = await ctx.context.adapter.findOne({
							model: "lsCustomer",
							where: [{ field: "userId", value: userId }],
						}) as Record<string, unknown> | null;

						if (!customerRecord) {
							// Create customer on-demand
							const lsCustomerId = await createLsCustomer(
								options.apiKey,
								options.storeId,
								userEmail,
								userName,
							);

							const now = new Date();
							try {
								customerRecord = await ctx.context.adapter.create({
									model: "lsCustomer",
									data: {
										userId,
										lsCustomerId,
										email: userEmail,
										createdAt: now,
										updatedAt: now,
									},
								}) as Record<string, unknown>;
							} catch {
								// Insert-or-ignore: if unique constraint fails (concurrent creation),
								// fetch the existing record
								customerRecord = await ctx.context.adapter.findOne({
									model: "lsCustomer",
									where: [{ field: "userId", value: userId }],
								}) as Record<string, unknown> | null;
								if (!customerRecord) {
									throw new Error("Failed to create or find customer record");
								}
							}
						}

						const lsCustomerId = customerRecord.lsCustomerId as string;

						// Generate Lemon Squeezy checkout URL
						const checkoutResponse = await fetch(
							"https://api.lemonsqueezy.com/v1/checkouts",
							{
								method: "POST",
								headers: {
									Authorization: `Bearer ${options.apiKey}`,
									Accept: "application/vnd.api+json",
									"Content-Type": "application/vnd.api+json",
								},
								body: JSON.stringify({
									data: {
										type: "checkouts",
										attributes: {
											checkout_data: {
												email: userEmail,
												custom: {
													customer_id: lsCustomerId,
												},
											},
											custom_data: {
												userId,
											},
											product_options: {
												redirect_url: successUrl,
											},
											checkout_options: {
												cancel_url: cancelUrl,
											},
										},
										relationships: {
											store: {
												data: {
													type: "stores",
													id: options.storeId,
												},
											},
											variant: {
												data: {
													type: "variants",
													id: variantId,
												},
											},
										},
									},
								}),
							},
						);

						if (!checkoutResponse.ok) {
							const errorText = await checkoutResponse.text();
							throw new Error(
								`Lemon Squeezy checkout failed: ${checkoutResponse.status} ${errorText}`,
							);
						}

						const checkoutResult = (await checkoutResponse.json()) as {
							data: { attributes: { url: string } };
						};
						const checkoutUrl = checkoutResult.data.attributes.url;

						// Cache for 60 seconds
						checkoutCache.set(idempotencyKey, {
							url: checkoutUrl,
							expiresAt: Date.now() + 60_000,
						});

						resolveLock!(checkoutUrl);
						return ctx.json({ url: checkoutUrl });
					} catch (error) {
						rejectLock!(error);
						throw error;
					} finally {
						checkoutLocks.delete(idempotencyKey);
					}
				},
			),
			lemonSqueezySubscriptionCancel: createAuthEndpoint(
				"/lemonsqueezy/subscription/cancel",
				{
					method: "POST",
					use: [sessionMiddleware],
					body: z.object({
						subscriptionId: z.string(),
					}),
				},
				async (ctx) => {
					const userId = ctx.context.session.user.id;
					const subscriptionId = ctx.body.subscriptionId;

					const subscription = (await ctx.context.adapter.findOne({
						model: "lsSubscription",
						where: [{ field: "lsSubscriptionId", value: subscriptionId }],
					})) as Record<string, unknown> | null;

					if (!subscription) {
						return ctx.json(
							{ error: "Subscription not found", code: "subscription_not_found" },
							{ status: 404 },
						);
					}
					if (subscription.userId !== userId) {
						return ctx.json(
							{ error: "Not authorized", code: "not_owner" },
							{ status: 403 },
						);
					}

					// Idempotency: if already cancelled, return success without API call
					if (subscription.status === "cancelled") {
						return ctx.json({
							success: true,
							message:
								"Subscription is already cancelled. It will remain active until the end of the billing period.",
						});
					}

					// Call Lemon Squeezy API to cancel (cancels at period end)
					const cancelResponse = await fetch(
						`https://api.lemonsqueezy.com/v1/subscriptions/${subscriptionId}`,
						{
							method: "PATCH",
							headers: {
								Authorization: `Bearer ${options.apiKey}`,
								Accept: "application/vnd.api+json",
								"Content-Type": "application/vnd.api+json",
							},
							body: JSON.stringify({
								data: {
									type: "subscriptions",
									id: subscriptionId,
									attributes: {
										cancelled: true,
									},
								},
							}),
						},
					);

					if (!cancelResponse.ok) {
						const errorText = await cancelResponse.text();
						throw new Error(
							`Lemon Squeezy cancel failed: ${cancelResponse.status} ${errorText}`,
						);
					}

					// Do NOT update local status — webhook is the source of truth
					return ctx.json({
						success: true,
						message:
							"Subscription cancellation requested. It will remain active until the end of the billing period.",
					});
				},
			),

			lemonSqueezySubscriptionResume: createAuthEndpoint(
				"/lemonsqueezy/subscription/resume",
				{
					method: "POST",
					use: [sessionMiddleware],
					body: z.object({
						subscriptionId: z.string(),
					}),
				},
				async (ctx) => {
					const userId = ctx.context.session.user.id;
					const subscriptionId = ctx.body.subscriptionId;

					const subscription = (await ctx.context.adapter.findOne({
						model: "lsSubscription",
						where: [{ field: "lsSubscriptionId", value: subscriptionId }],
					})) as Record<string, unknown> | null;

					if (!subscription) {
						return ctx.json(
							{ error: "Subscription not found", code: "subscription_not_found" },
							{ status: 404 },
						);
					}
					if (subscription.userId !== userId) {
						return ctx.json(
							{ error: "Not authorized", code: "not_owner" },
							{ status: 403 },
						);
					}

					// Only cancelled subscriptions can be resumed
					if (subscription.status !== "cancelled" && subscription.status !== "active") {
						return ctx.json(
							{ error: "Subscription cannot be resumed", code: "invalid_status" },
							{ status: 400 },
						);
					}

					// Idempotency: if already active, return success without API call
					if (subscription.status === "active") {
						return ctx.json({
							success: true,
							message: "Subscription is already active.",
						});
					}

					// Call Lemon Squeezy API to resume (un-cancel)
					const resumeResponse = await fetch(
						`https://api.lemonsqueezy.com/v1/subscriptions/${subscriptionId}`,
						{
							method: "PATCH",
							headers: {
								Authorization: `Bearer ${options.apiKey}`,
								Accept: "application/vnd.api+json",
								"Content-Type": "application/vnd.api+json",
							},
							body: JSON.stringify({
								data: {
									type: "subscriptions",
									id: subscriptionId,
									attributes: {
										cancelled: false,
									},
								},
							}),
						},
					);

					if (!resumeResponse.ok) {
						const errorText = await resumeResponse.text();
						throw new Error(
							`Lemon Squeezy resume failed: ${resumeResponse.status} ${errorText}`,
						);
					}

					// Do NOT update local status — webhook is the source of truth
					return ctx.json({
						success: true,
						message: "Subscription resume requested.",
					});
				},
			),

			lemonSqueezySubscriptionUpdate: createAuthEndpoint(
				"/lemonsqueezy/subscription/update",
				{
					method: "POST",
					use: [sessionMiddleware],
					body: z.object({
						subscriptionId: z.string(),
						plan: z.string(),
						interval: z.string().optional(),
					}),
				},
				async (ctx) => {
					const userId = ctx.context.session.user.id;
					const { subscriptionId, plan: planName, interval: requestedInterval } = ctx.body;

					const subscription = (await ctx.context.adapter.findOne({
						model: "lsSubscription",
						where: [{ field: "lsSubscriptionId", value: subscriptionId }],
					})) as Record<string, unknown> | null;

					if (!subscription) {
						return ctx.json(
							{ error: "Subscription not found", code: "subscription_not_found" },
							{ status: 404 },
						);
					}
					if (subscription.userId !== userId) {
						return ctx.json(
							{ error: "Not authorized", code: "not_owner" },
							{ status: 403 },
						);
					}

					// Resolve target plan from config
					const plans = options.subscription?.plans ?? [];
					const plan = plans.find((p) => p.name === planName);
					if (!plan) {
						return ctx.json(
							{ error: "Plan not found", code: "plan_not_found" },
							{ status: 400 },
						);
					}

					// Resolve interval — default to first key in plan.intervals
					const intervalKeys = Object.keys(plan.intervals) as Array<string>;
					const interval = requestedInterval ?? intervalKeys[0];
					if (!interval) {
						return ctx.json(
							{ error: "No intervals configured for plan", code: "no_intervals" },
							{ status: 400 },
						);
					}

					const targetVariantId = plan.intervals[interval as keyof typeof plan.intervals];
					if (!targetVariantId) {
						return ctx.json(
							{ error: "Invalid interval for plan", code: "invalid_interval" },
							{ status: 400 },
						);
					}

					// Idempotency: if current variantId already matches target, return success
					if (subscription.variantId === targetVariantId) {
						return ctx.json({
							success: true,
							message: "Subscription is already on the requested plan and interval.",
						});
					}

					// Call Lemon Squeezy API to update variant
					const updateResponse = await fetch(
						`https://api.lemonsqueezy.com/v1/subscriptions/${subscriptionId}`,
						{
							method: "PATCH",
							headers: {
								Authorization: `Bearer ${options.apiKey}`,
								Accept: "application/vnd.api+json",
								"Content-Type": "application/vnd.api+json",
							},
							body: JSON.stringify({
								data: {
									type: "subscriptions",
									id: subscriptionId,
									attributes: {
										variant_id: Number(targetVariantId),
									},
								},
							}),
						},
					);

					if (!updateResponse.ok) {
						const errorText = await updateResponse.text();
						throw new Error(
							`Lemon Squeezy update failed: ${updateResponse.status} ${errorText}`,
						);
					}

					// Do NOT update local record — webhook (subscription_updated) is the source of truth
					return ctx.json({
						success: true,
						message: "Subscription update requested. Changes will be reflected after webhook processing.",
					});
				},
			),

			lemonSqueezySubscriptionList: createAuthEndpoint(
				"/lemonsqueezy/subscription/list",
				{
					method: "GET",
					use: [sessionMiddleware],
					query: z.object({
						cursor: z.string().optional(),
					}),
				},
				async (ctx) => {
					const userId = ctx.context.session.user.id;

					const subscriptions = (await ctx.context.adapter.findMany({
						model: "lsSubscription",
						where: [{ field: "userId", value: userId }],
					})) as Array<Record<string, unknown>>;

					return ctx.json({ subscriptions, cursor: null });
				},
			),

			lemonSqueezySubscriptionGet: createAuthEndpoint(
				"/lemonsqueezy/subscription/get",
				{
					method: "GET",
					use: [sessionMiddleware],
					query: z.object({
						subscriptionId: z.string(),
					}),
				},
				async (ctx) => {
					const userId = ctx.context.session.user.id;
					const subscriptionId = ctx.query.subscriptionId;

					const subscription = (await ctx.context.adapter.findOne({
						model: "lsSubscription",
						where: [{ field: "lsSubscriptionId", value: subscriptionId }],
					})) as Record<string, unknown> | null;

					if (!subscription) {
						return ctx.json(
							{ error: "Subscription not found", code: "subscription_not_found" },
							{ status: 404 },
						);
					}
					if (subscription.userId !== userId) {
						return ctx.json(
							{ error: "Not authorized", code: "not_owner" },
							{ status: 403 },
						);
					}

					return ctx.json({ subscription });
				},
			),

			lemonSqueezySubscriptionPortal: createAuthEndpoint(
				"/lemonsqueezy/subscription/portal",
				{
					method: "POST",
					use: [sessionMiddleware],
					body: z.object({
						subscriptionId: z.string(),
					}),
				},
				async (ctx) => {
					// Full implementation in US-012
					const userId = ctx.context.session.user.id;
					const subscriptionId = ctx.body.subscriptionId;

					const subscription = (await ctx.context.adapter.findOne({
						model: "lsSubscription",
						where: [{ field: "lsSubscriptionId", value: subscriptionId }],
					})) as Record<string, unknown> | null;

					if (!subscription) {
						return ctx.json(
							{ error: "Subscription not found", code: "subscription_not_found" },
							{ status: 404 },
						);
					}
					if (subscription.userId !== userId) {
						return ctx.json(
							{ error: "Not authorized", code: "not_owner" },
							{ status: 403 },
						);
					}

					return ctx.json({ url: "" });
				},
			),
		},
	} satisfies BetterAuthPlugin;
};
