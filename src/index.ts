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
export { createUsageReporter } from "./usage";
export { schema } from "./schema";

/** Default timeout for outbound Lemon Squeezy API requests (10 seconds) */
const LS_API_TIMEOUT = 10_000;

/**
 * Make a fetch request to the Lemon Squeezy API with a 10-second timeout.
 * Handles rate limiting (429) and upstream errors (5xx/network) with structured error responses.
 * Returns { data } on success, or { error, code } on failure.
 */
async function lsFetch(
	url: string,
	init: RequestInit & { headers: Record<string, string> },
): Promise<{ data?: unknown; error?: string; code?: string; status?: number }> {
	try {
		const response = await fetch(url, {
			...init,
			signal: AbortSignal.timeout(LS_API_TIMEOUT),
		});

		if (response.status === 429) {
			return {
				error: "Lemon Squeezy API rate limit exceeded",
				code: "rate_limited",
				status: 429,
			};
		}

		if (!response.ok) {
			const errorText = await response.text();
			if (response.status >= 500) {
				return {
					error: "Lemon Squeezy upstream service unavailable",
					code: "upstream_error",
					status: response.status,
				};
			}
			return {
				error: `Lemon Squeezy API error: ${response.status} ${errorText}`,
				code: "upstream_error",
				status: response.status,
			};
		}

		const data = await response.json();
		return { data };
	} catch (err) {
		if (err instanceof DOMException && err.name === "TimeoutError") {
			return {
				error: "Lemon Squeezy API request timed out",
				code: "upstream_error",
			};
		}
		if (err instanceof TypeError) {
			// Network error
			return {
				error: "Lemon Squeezy upstream service unavailable",
				code: "upstream_error",
			};
		}
		throw err;
	}
}

/**
 * Simple per-user rate limiter (best-effort, in-memory).
 * Allows `maxRequests` per `windowMs` per user.
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;

function checkRateLimit(userId: string): boolean {
	const now = Date.now();
	const entry = rateLimitMap.get(userId);
	if (!entry || entry.resetAt <= now) {
		rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
		return true;
	}
	entry.count++;
	return entry.count <= RATE_LIMIT_MAX_REQUESTS;
}

/**
 * In-memory checkout cache: key -> { url, expiresAt }.
 * Best-effort deduplication — not shared across serverless instances.
 */
const checkoutCache = new Map<string, { url: string; expiresAt: number }>();

/** In-memory checkout locks: key -> Promise that resolves with the checkout URL */
const checkoutLocks = new Map<string, Promise<string>>();

/** Evict expired entries from the checkout cache (called before each lookup). */
function pruneCheckoutCache() {
	const now = Date.now();
	for (const [key, entry] of checkoutCache) {
		if (entry.expiresAt <= now) {
			checkoutCache.delete(key);
		}
	}
}

/**
 * Create a Lemon Squeezy customer via API.
 * Returns the customer ID string, or throws with structured error info.
 */
async function createLsCustomer(
	apiKey: string,
	storeId: string,
	email: string,
	name: string,
): Promise<{ customerId?: string; error?: string; code?: string }> {
	const result = await lsFetch(
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

	if (result.error) {
		return { error: result.error, code: result.code };
	}

	const data = result.data as { data: { id: string } };
	return { customerId: data.data.id };
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
										const result = await createLsCustomer(
											options.apiKey,
											options.storeId,
											user.email,
											user.name,
										);

										if (result.error || !result.customerId) {
											ctx.logger.error(
												"Failed to create Lemon Squeezy customer on sign-up",
												{ userId: user.id, error: result.error, code: result.code },
											);
											return;
										}

										const lsCustomerId = result.customerId;
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
											{ userId: user.id, error },
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
							{ error: "Invalid signature", code: "invalid_signature" },
							{ status: 400 },
						);
					}

					let payload: Record<string, unknown>;
				try {
					payload = JSON.parse(rawBody) as Record<string, unknown>;
				} catch {
					return ctx.json(
						{ error: "Invalid JSON body", code: "invalid_body" },
						{ status: 400 },
					);
				}
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

					try {
						await processWebhookEvent(webhookCtx, eventName, payload);
					} catch (error) {
						ctx.context.logger.error(
							"Webhook processing failed",
							{ eventName, error },
						);
						return ctx.json(
							{ error: "Webhook processing failed", code: "processing_error" },
							{ status: 500 },
						);
					}

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
						interval: z.enum(["monthly", "annual"]).optional(),
						successUrl: z.string().optional(),
						cancelUrl: z.string().optional(),
					}),
				},
				async (ctx) => {
					const userId = ctx.context.session.user.id;
					if (!checkRateLimit(userId)) {
						return ctx.json(
							{ error: "Too many requests", code: "rate_limited" },
							{ status: 429 },
						);
					}
					const userEmail = ctx.context.session.user.email;
					const userName = ctx.context.session.user.name;

					const { plan: planName, interval: requestedInterval, successUrl: bodySuccessUrl, cancelUrl: bodyCancelUrl } = ctx.body;

					// Resolve plan from config
					const plans = options.subscription?.plans ?? [];
					const plan = plans.find((p) => p.name === planName);
					if (!plan) {
						return ctx.json(
							{ error: "Plan not found", code: "invalid_plan" },
							{ status: 400 },
						);
					}

					// Resolve interval — default to first key in plan.intervals
					const intervalKeys = Object.keys(plan.intervals) as Array<string>;
					const interval = requestedInterval ?? intervalKeys[0];
					if (!interval) {
						return ctx.json(
							{ error: "No intervals configured for plan", code: "invalid_interval" },
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
					const resolvedSuccessUrl = bodySuccessUrl ?? options.defaultSuccessUrl;
					const resolvedCancelUrl = bodyCancelUrl ?? options.defaultCancelUrl;
					if (!resolvedSuccessUrl || !resolvedCancelUrl) {
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

					// Idempotency: derive key from userId + plan + interval + URLs
					const idempotencyKey = `${userId}:${planName}:${interval}:${resolvedSuccessUrl}:${resolvedCancelUrl}`;

					// Check cache first (prune expired entries)
					pruneCheckoutCache();
					const cached = checkoutCache.get(idempotencyKey);
					if (cached && cached.expiresAt > Date.now()) {
						return ctx.json({ url: cached.url });
					}

					// Check if there's an in-flight request for this key
					const existingLock = checkoutLocks.get(idempotencyKey);
					if (existingLock) {
						try {
							const url = await existingLock;
							return ctx.json({ url });
						} catch {
							// The in-flight request failed — fall through to create a new one
						}
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
							const customerResult = await createLsCustomer(
								options.apiKey,
								options.storeId,
								userEmail,
								userName,
							);

							if (customerResult.error || !customerResult.customerId) {
								const err = new Error(customerResult.error ?? "Failed to create customer");
								rejectLock!(err);
								return ctx.json(
									{ error: customerResult.error ?? "Failed to create customer", code: customerResult.code ?? "upstream_error" },
									{ status: 502 },
								);
							}

							const lsCustomerId = customerResult.customerId;
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
									const err = new Error("Failed to create or find customer record");
									rejectLock!(err);
									return ctx.json(
										{ error: "Failed to create or find customer record", code: "upstream_error" },
										{ status: 500 },
									);
								}
							}
						}

						const lsCustomerId = customerRecord.lsCustomerId as string;

						// Keep customer email in sync with session
						if (customerRecord.email !== userEmail) {
							await ctx.context.adapter.update({
								model: "lsCustomer",
								update: { email: userEmail, updatedAt: new Date() },
								where: [{ field: "userId", value: userId }],
							});
						}

						// Generate Lemon Squeezy checkout URL
						const checkoutResult = await lsFetch(
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
												redirect_url: resolvedSuccessUrl,
											},
											checkout_options: {
												cancel_url: resolvedCancelUrl,
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

						if (checkoutResult.error) {
							const err = new Error(checkoutResult.error);
							rejectLock!(err);
							return ctx.json(
								{ error: checkoutResult.error, code: checkoutResult.code ?? "upstream_error" },
								{ status: checkoutResult.code === "rate_limited" ? 429 : 502 },
							);
						}

						const checkoutData = checkoutResult.data as {
							data: { attributes: { url: string } };
						};
						const checkoutUrl = checkoutData.data.attributes.url;

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
					if (!checkRateLimit(userId)) {
						return ctx.json(
							{ error: "Too many requests", code: "rate_limited" },
							{ status: 429 },
						);
					}
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
					const cancelResult = await lsFetch(
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

					if (cancelResult.error) {
						return ctx.json(
							{ error: cancelResult.error, code: cancelResult.code ?? "upstream_error" },
							{ status: cancelResult.code === "rate_limited" ? 429 : 502 },
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
					if (!checkRateLimit(userId)) {
						return ctx.json(
							{ error: "Too many requests", code: "rate_limited" },
							{ status: 429 },
						);
					}
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

					// Idempotency: if already active, return success without API call
					if (subscription.status === "active") {
						return ctx.json({
							success: true,
							message: "Subscription is already active.",
						});
					}

					// Only cancelled subscriptions can be resumed
					if (subscription.status !== "cancelled") {
						return ctx.json(
							{ error: "Subscription is not in cancelled status", code: "not_cancelled" },
							{ status: 400 },
						);
					}

					// Call Lemon Squeezy API to resume (un-cancel)
					const resumeResult = await lsFetch(
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

					if (resumeResult.error) {
						return ctx.json(
							{ error: resumeResult.error, code: resumeResult.code ?? "upstream_error" },
							{ status: resumeResult.code === "rate_limited" ? 429 : 502 },
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
						interval: z.enum(["monthly", "annual"]).optional(),
					}),
				},
				async (ctx) => {
					const userId = ctx.context.session.user.id;
					if (!checkRateLimit(userId)) {
						return ctx.json(
							{ error: "Too many requests", code: "rate_limited" },
							{ status: 429 },
						);
					}
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
							{ error: "Plan not found", code: "invalid_plan" },
							{ status: 400 },
						);
					}

					// Resolve interval — default to first key in plan.intervals
					const intervalKeys = Object.keys(plan.intervals) as Array<string>;
					const interval = requestedInterval ?? intervalKeys[0];
					if (!interval) {
						return ctx.json(
							{ error: "No intervals configured for plan", code: "invalid_interval" },
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
					const updateResult = await lsFetch(
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

					if (updateResult.error) {
						return ctx.json(
							{ error: updateResult.error, code: updateResult.code ?? "upstream_error" },
							{ status: updateResult.code === "rate_limited" ? 429 : 502 },
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
				},
				async (ctx) => {
					const userId = ctx.context.session.user.id;
					if (!checkRateLimit(userId)) {
						return ctx.json(
							{ error: "Too many requests", code: "rate_limited" },
							{ status: 429 },
						);
					}

					const subscriptions = (await ctx.context.adapter.findMany({
						model: "lsSubscription",
						where: [{ field: "userId", value: userId }],
					})) as Array<Record<string, unknown>>;

					return ctx.json({ subscriptions });
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
					if (!checkRateLimit(userId)) {
						return ctx.json(
							{ error: "Too many requests", code: "rate_limited" },
							{ status: 429 },
						);
					}
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
					const userId = ctx.context.session.user.id;
					if (!checkRateLimit(userId)) {
						return ctx.json(
							{ error: "Too many requests", code: "rate_limited" },
							{ status: 429 },
						);
					}
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

					// Fetch fresh subscription from Lemon Squeezy API to get portal URL
					const portalResult = await lsFetch(
						`https://api.lemonsqueezy.com/v1/subscriptions/${subscriptionId}`,
						{
							method: "GET",
							headers: {
								Authorization: `Bearer ${options.apiKey}`,
								Accept: "application/vnd.api+json",
							},
						},
					);

					if (portalResult.error) {
						return ctx.json(
							{ error: portalResult.error, code: portalResult.code ?? "upstream_error" },
							{ status: portalResult.code === "rate_limited" ? 429 : 502 },
						);
					}

					const portalData = portalResult.data as {
						data: { attributes: { urls: { customer_portal: string } } };
					};
					const portalUrl = portalData.data.attributes.urls.customer_portal;

					return ctx.json({ url: portalUrl });
				},
			),
		lemonSqueezySubscriptionSync: createAuthEndpoint(
				"/lemonsqueezy/subscription/sync",
				{
					method: "POST",
					use: [sessionMiddleware],
					body: z.object({
						subscriptionId: z.string(),
					}),
				},
				async (ctx) => {
					const userId = ctx.context.session.user.id;
					if (!checkRateLimit(userId)) {
						return ctx.json(
							{ error: "Too many requests", code: "rate_limited" },
							{ status: 429 },
						);
					}
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

					// Fetch latest subscription state from Lemon Squeezy API
					const syncResult = await lsFetch(
						`https://api.lemonsqueezy.com/v1/subscriptions/${subscriptionId}`,
						{
							method: "GET",
							headers: {
								Authorization: `Bearer ${options.apiKey}`,
								Accept: "application/vnd.api+json",
							},
						},
					);

					if (syncResult.error) {
						return ctx.json(
							{ error: syncResult.error, code: syncResult.code ?? "upstream_error" },
							{ status: syncResult.code === "rate_limited" ? 429 : 502 },
						);
					}

					const syncData = syncResult.data as {
						data: {
							attributes: Record<string, unknown>;
						};
					};
					const attrs = syncData.data.attributes;

					// Resolve plan from variant
					const variantId = String(attrs.variant_id ?? "");
					const productId = String(attrs.product_id ?? "");
					const plans = options.subscription?.plans ?? [];
					let planName = "unknown";
					let interval: string | null = null;
					for (const plan of plans) {
						for (const [intv, vid] of Object.entries(plan.intervals)) {
							if (vid === variantId) {
								planName = plan.name;
								interval = intv;
								break;
							}
						}
						if (planName !== "unknown") break;
					}

					const now = new Date();
					const updateData: Record<string, unknown> = {
						status: attrs.status as string,
						variantId,
						productId,
						planName,
						interval,
						renewsAt: attrs.renews_at ? new Date(attrs.renews_at as string) : null,
						endsAt: attrs.ends_at ? new Date(attrs.ends_at as string) : null,
						trialEndsAt: attrs.trial_ends_at ? new Date(attrs.trial_ends_at as string) : null,
						cancelledAt: attrs.cancelled_at ? new Date(attrs.cancelled_at as string) : null,
						lsUpdatedAt: attrs.updated_at ? new Date(attrs.updated_at as string) : null,
						updatedAt: now,
					};

					await ctx.context.adapter.update({
						model: "lsSubscription",
						update: updateData,
						where: [{ field: "lsSubscriptionId", value: subscriptionId }],
					});

					return ctx.json({
						success: true,
						subscription: { ...subscription, ...updateData },
					});
				},
			),

		...(options.usageEndpoint
			? {
					lemonSqueezyUsage: createAuthEndpoint(
						"/lemonsqueezy/usage",
						{
							method: "POST",
							use: [sessionMiddleware],
							body: z.object({
								subscriptionId: z.string(),
								quantity: z.number(),
							}),
						},
						async (ctx) => {
							const userId = ctx.context.session.user.id;
							if (!checkRateLimit(userId)) {
								return ctx.json(
									{ error: "Too many requests", code: "rate_limited" },
									{ status: 429 },
								);
							}
							const { subscriptionId, quantity } = ctx.body;

							// Validate quantity: must be a positive integer
							if (!Number.isInteger(quantity) || quantity <= 0) {
								return ctx.json(
									{
										error: "Quantity must be a positive integer",
										code: "invalid_quantity",
									},
									{ status: 400 },
								);
							}

							const subscription =
								(await ctx.context.adapter.findOne({
									model: "lsSubscription",
									where: [
										{
											field: "lsSubscriptionId",
											value: subscriptionId,
										},
									],
								})) as Record<string, unknown> | null;

							if (!subscription) {
								return ctx.json(
									{
										error: "Subscription not found",
										code: "subscription_not_found",
									},
									{ status: 404 },
								);
							}
							if (subscription.userId !== userId) {
								return ctx.json(
									{
										error: "Not authorized",
										code: "not_owner",
									},
									{ status: 403 },
								);
							}

							const subscriptionItemId =
								subscription.subscriptionItemId as
									| string
									| null;
							if (!subscriptionItemId) {
								return ctx.json(
									{
										error: "No subscription item ID found — usage reporting requires a usage-based subscription",
										code: "no_subscription_item",
									},
									{ status: 400 },
								);
							}

							// Call Lemon Squeezy API to create usage record
							const usageResult = await lsFetch(
								"https://api.lemonsqueezy.com/v1/usage-records",
								{
									method: "POST",
									headers: {
										Authorization: `Bearer ${options.apiKey}`,
										Accept: "application/vnd.api+json",
										"Content-Type":
											"application/vnd.api+json",
									},
									body: JSON.stringify({
										data: {
											type: "usage-records",
											attributes: {
												quantity,
												action: "increment",
											},
											relationships: {
												"subscription-item": {
													data: {
														type: "subscription-items",
														id: subscriptionItemId,
													},
												},
											},
										},
									}),
								},
							);

							if (usageResult.error) {
								return ctx.json(
									{ error: usageResult.error, code: usageResult.code ?? "upstream_error" },
									{ status: usageResult.code === "rate_limited" ? 429 : 502 },
								);
							}

							return ctx.json({ success: true });
						},
					),
				}
			: {}),
		},
	} satisfies BetterAuthPlugin;
};
