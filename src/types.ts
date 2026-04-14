/**
 * Lemon Squeezy plugin types for Better Auth.
 */

/** Billing interval for a subscription plan */
export type BillingInterval = string;

/** A plan definition mapping intervals to Lemon Squeezy variant IDs */
export interface LemonSqueezyPlan {
	/** Display name of the plan */
	name: string;
	/** Lemon Squeezy product ID */
	productId: string;
	/** Mapping of billing intervals to Lemon Squeezy variant IDs */
	intervals: Record<string, string>;
}

/** Subscription configuration */
export interface SubscriptionConfig {
	/** Enable subscription management */
	enabled: boolean;
	/** Array of plan definitions */
	plans: LemonSqueezyPlan[];
}

/** Callback invoked after a Lemon Squeezy customer is created */
export type OnCustomerCreatedCallback = (data: {
	userId: string;
	lsCustomerId: string;
}) => Promise<void> | void;

/** Webhook event passed to the onWebhookEvent callback */
export interface WebhookEventPayload {
	/** Lemon Squeezy event name (e.g., "subscription_created") */
	type: string;
	/** Raw webhook payload data object */
	data: Record<string, unknown>;
	/** Resolved user ID, or null if unresolvable */
	userId: string | null;
	/** Whether user correlation succeeded */
	resolved: boolean;
	/** True if user already has an active subscription for the same plan */
	duplicatePlan?: boolean;
}

/** Callback invoked on any webhook event */
export type OnWebhookEventCallback = (
	event: WebhookEventPayload,
) => Promise<void> | void;

/** Plugin configuration options */
export interface LemonSqueezyOptions {
	/** Lemon Squeezy API key */
	apiKey: string;
	/** Lemon Squeezy store ID */
	storeId: string;
	/** Webhook signing secret for signature verification */
	webhookSigningSecret: string;
	/** Automatically create a Lemon Squeezy customer on user sign-up */
	createCustomerOnSignUp?: boolean;
	/** Callback after customer creation */
	onCustomerCreated?: OnCustomerCreatedCallback;
	/** Callback on any webhook event */
	onWebhookEvent?: OnWebhookEventCallback;
	/** Subscription configuration */
	subscription?: SubscriptionConfig;
	/** Default success URL for checkout (used as fallback) */
	defaultSuccessUrl?: string;
	/** Default cancel URL for checkout (used as fallback) */
	defaultCancelUrl?: string;
	/**
	 * When false, disables email-based webhook correlation entirely.
	 * Only meta.custom_data.userId and lsCustomerId lookup are used.
	 * Recommended for security-sensitive deployments.
	 * @default true
	 */
	allowEmailFallback?: boolean;
	/**
	 * Enable the usage reporting HTTP endpoint.
	 * WARNING: Do not expose in untrusted environments.
	 * @default false
	 */
	usageEndpoint?: boolean;
}

/** Subscription status values */
export type SubscriptionStatus =
	| "on_trial"
	| "active"
	| "paused"
	| "past_due"
	| "unpaid"
	| "cancelled"
	| "expired";
