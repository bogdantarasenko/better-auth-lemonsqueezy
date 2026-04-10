import type { BetterAuthPlugin } from "better-auth";
import { schema } from "./schema";
import type { LemonSqueezyOptions } from "./types";

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
		endpoints: {},
	} satisfies BetterAuthPlugin;
};
