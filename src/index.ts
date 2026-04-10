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
		endpoints: {},
	} satisfies BetterAuthPlugin;
};
