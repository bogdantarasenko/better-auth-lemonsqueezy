import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
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
										const response = await fetch(
											"https://api.lemonsqueezy.com/v1/customers",
											{
												method: "POST",
												headers: {
													Authorization: `Bearer ${options.apiKey}`,
													Accept: "application/vnd.api+json",
													"Content-Type": "application/vnd.api+json",
												},
												body: JSON.stringify({
													data: {
														type: "customers",
														attributes: {
															name: user.name,
															email: user.email,
														},
														relationships: {
															store: {
																data: {
																	type: "stores",
																	id: options.storeId,
																},
															},
														},
													},
												}),
											},
										);

										if (!response.ok) {
											const errorText = await response.text();
											ctx.logger.error(
												"Failed to create Lemon Squeezy customer",
												{ status: response.status, body: errorText },
											);
											return;
										}

										const result = (await response.json()) as {
											data: { id: string };
										};
										const lsCustomerId = result.data.id;

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
		},
	} satisfies BetterAuthPlugin;
};
