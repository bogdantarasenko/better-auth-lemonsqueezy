import type { LemonSqueezyOptions, SubscriptionStatus } from "./types";

/**
 * Verify the webhook signature using HMAC SHA-256.
 */
export async function verifyWebhookSignature(
	rawBody: string,
	signature: string,
	secret: string,
): Promise<boolean> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
	const hexDigest = Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return hexDigest === signature;
}

/**
 * Resolve a variant ID to a plan name and interval from configured plans.
 */
export function resolvePlanFromVariant(
	options: LemonSqueezyOptions,
	variantId: string,
): { planName: string; interval: string | null } | null {
	const plans = options.subscription?.plans ?? [];
	for (const plan of plans) {
		for (const [interval, vid] of Object.entries(plan.intervals)) {
			if (vid === variantId) {
				return { planName: plan.name, interval };
			}
		}
	}
	return null;
}

/** Subscription event types we handle */
export const HANDLED_EVENTS = new Set([
	"subscription_created",
	"subscription_updated",
	"subscription_paused",
	"subscription_unpaused",
	"subscription_cancelled",
	"subscription_expired",
	"subscription_payment_success",
	"subscription_payment_failed",
	"subscription_payment_recovered",
	"subscription_payment_refunded",
]);

/** Payment events that only trigger conditional status updates */
export const PAYMENT_EVENTS = new Set([
	"subscription_payment_success",
	"subscription_payment_failed",
	"subscription_payment_recovered",
	"subscription_payment_refunded",
]);

interface WebhookAdapter {
	findOne: (opts: {
		model: string;
		where: Array<{ field: string; value: string }>;
	}) => Promise<Record<string, unknown> | null>;
	create: (opts: {
		model: string;
		data: Record<string, unknown>;
	}) => Promise<Record<string, unknown>>;
	update: (opts: {
		model: string;
		update: Record<string, unknown>;
		where: Array<{ field: string; value: string }>;
	}) => Promise<Record<string, unknown> | null>;
	findMany: (opts: {
		model: string;
		where: Array<{ field: string; value: string }>;
	}) => Promise<Array<Record<string, unknown>>>;
}

interface WebhookLogger {
	warn: (msg: string, ...args: unknown[]) => void;
	error: (msg: string, ...args: unknown[]) => void;
	info: (msg: string, ...args: unknown[]) => void;
}

interface InternalAdapter {
	findUserByEmail: (
		email: string,
	) => Promise<{ user: Record<string, unknown> } | null>;
}

export interface WebhookContext {
	adapter: WebhookAdapter;
	internalAdapter: InternalAdapter;
	logger: WebhookLogger;
	options: LemonSqueezyOptions;
}

/**
 * Resolve the user ID from a webhook event payload.
 * Priority: (1) meta.custom_data.userId, (2) lsCustomerId lookup, (3) email fallback
 */
export async function resolveUserId(
	ctx: WebhookContext,
	data: Record<string, unknown>,
): Promise<string | null> {
	// 1. Check meta.custom_data.userId
	const meta = data.meta as Record<string, unknown> | undefined;
	const customData = meta?.custom_data as Record<string, unknown> | undefined;
	if (customData?.userId && typeof customData.userId === "string") {
		return customData.userId;
	}

	// 2. Look up by lsCustomerId
	const attributes = data.data as Record<string, unknown> | undefined;
	const lsCustomerId = String(
		attributes?.attributes
			? (attributes.attributes as Record<string, unknown>).customer_id
			: "",
	);
	if (lsCustomerId) {
		const customer = await ctx.adapter.findOne({
			model: "lsCustomer",
			where: [{ field: "lsCustomerId", value: lsCustomerId }],
		});
		if (customer?.userId) {
			return customer.userId as string;
		}
	}

	// 3. Email fallback (if enabled)
	if (ctx.options.allowEmailFallback !== false) {
		const userEmail =
			attributes?.attributes
				? (attributes.attributes as Record<string, unknown>).user_email
				: undefined;
		if (userEmail && typeof userEmail === "string") {
			const userResult =
				await ctx.internalAdapter.findUserByEmail(userEmail);
			if (userResult?.user?.id) {
				return userResult.user.id as string;
			}
		}
	}

	return null;
}

/**
 * Extract subscription fields from webhook payload attributes.
 */
function extractAttributes(data: Record<string, unknown>): Record<string, unknown> {
	const innerData = data.data as Record<string, unknown> | undefined;
	return (innerData?.attributes as Record<string, unknown>) ?? {};
}

function extractLsSubscriptionId(data: Record<string, unknown>): string {
	const innerData = data.data as Record<string, unknown> | undefined;
	return String(innerData?.id ?? "");
}

function extractLsCustomerId(data: Record<string, unknown>): string {
	const attrs = extractAttributes(data);
	return String(attrs.customer_id ?? "");
}

/**
 * Process a webhook event and update the subscription database.
 */
export async function processWebhookEvent(
	ctx: WebhookContext,
	eventName: string,
	data: Record<string, unknown>,
): Promise<void> {
	if (!HANDLED_EVENTS.has(eventName)) {
		return; // Acknowledge but don't process
	}

	const lsSubscriptionId = extractLsSubscriptionId(data);
	const lsCustomerId = extractLsCustomerId(data);
	const attrs = extractAttributes(data);

	// Resolve user
	const userId = await resolveUserId(ctx, data);

	// Unresolvable user check
	if (!userId) {
		ctx.logger.warn(
			"Webhook event could not be resolved to a user",
			{ lsSubscriptionId, lsCustomerId, eventName },
		);
		// Still invoke onWebhookEvent with resolved: false
		if (ctx.options.onWebhookEvent) {
			await ctx.options.onWebhookEvent({
				type: eventName,
				data,
				userId: null,
				resolved: false,
			});
		}
		return;
	}

	// Find existing subscription record
	const existing = lsSubscriptionId
		? await ctx.adapter.findOne({
				model: "lsSubscription",
				where: [{ field: "lsSubscriptionId", value: lsSubscriptionId }],
			})
		: null;

	// Stale event detection
	const incomingUpdatedAt = attrs.updated_at
		? new Date(attrs.updated_at as string)
		: null;
	if (existing && incomingUpdatedAt && existing.lsUpdatedAt) {
		const storedUpdatedAt = new Date(existing.lsUpdatedAt as string);
		if (incomingUpdatedAt < storedUpdatedAt) {
			// Stale event — skip processing but still return 200
			return;
		}
	}

	// Handle payment events (conditional status updates only)
	if (PAYMENT_EVENTS.has(eventName)) {
		await handlePaymentEvent(ctx, eventName, existing, lsSubscriptionId, incomingUpdatedAt);
		// Invoke callback
		if (ctx.options.onWebhookEvent) {
			await ctx.options.onWebhookEvent({
				type: eventName,
				data,
				userId,
				resolved: true,
			});
		}
		return;
	}

	// Resolve plan info from variant
	const variantId = String(attrs.variant_id ?? "");
	const productId = String(attrs.product_id ?? "");
	const resolved = resolvePlanFromVariant(ctx.options, variantId);
	const planName = resolved?.planName ?? "unknown";
	const interval = resolved?.interval ?? null;

	if (!resolved && variantId) {
		ctx.logger.warn(
			"Variant ID does not match any configured plan interval",
			{ variantId, productId, lsSubscriptionId, lsCustomerId, eventType: eventName, userId },
		);
	}

	const now = new Date();
	const subscriptionData: Record<string, unknown> = {
		userId,
		lsSubscriptionId,
		lsCustomerId,
		variantId,
		productId,
		planName,
		interval,
		status: mapEventToStatus(eventName, attrs, existing),
		renewsAt: attrs.renews_at ? new Date(attrs.renews_at as string) : null,
		endsAt: attrs.ends_at ? new Date(attrs.ends_at as string) : null,
		trialEndsAt: attrs.trial_ends_at
			? new Date(attrs.trial_ends_at as string)
			: null,
		lsUpdatedAt: incomingUpdatedAt,
		updatedAt: now,
	};

	// subscription_created: store subscriptionItemId if present
	if (eventName === "subscription_created") {
		const firstItem = attrs.first_subscription_item as
			| Record<string, unknown>
			| undefined;
		if (firstItem?.id) {
			subscriptionData.subscriptionItemId = String(firstItem.id);
		}
	}

	// subscription_cancelled: set cancelledAt
	if (eventName === "subscription_cancelled") {
		subscriptionData.cancelledAt = attrs.cancelled_at
			? new Date(attrs.cancelled_at as string)
			: now;
	}

	// Upsert by lsSubscriptionId
	if (existing) {
		await ctx.adapter.update({
			model: "lsSubscription",
			update: subscriptionData,
			where: [{ field: "lsSubscriptionId", value: lsSubscriptionId }],
		});
	} else {
		subscriptionData.createdAt = now;
		await ctx.adapter.create({
			model: "lsSubscription",
			data: subscriptionData,
		});
	}

	// Check for duplicate plan (subscription_created)
	let duplicatePlan = false;
	if (eventName === "subscription_created") {
		const userSubscriptions = await ctx.adapter.findMany({
			model: "lsSubscription",
			where: [{ field: "userId", value: userId }],
		});
		const activeSamePlan = userSubscriptions.filter(
			(s) =>
				s.planName === planName &&
				(s.status === "active" || s.status === "on_trial") &&
				s.lsSubscriptionId !== lsSubscriptionId,
		);
		duplicatePlan = activeSamePlan.length > 0;
	}

	// Invoke onWebhookEvent callback
	if (ctx.options.onWebhookEvent) {
		const payload: {
			type: string;
			data: Record<string, unknown>;
			userId: string;
			resolved: true;
			duplicatePlan?: boolean;
		} = {
			type: eventName,
			data,
			userId,
			resolved: true,
		};
		if (eventName === "subscription_created" && duplicatePlan) {
			payload.duplicatePlan = true;
		}
		await ctx.options.onWebhookEvent(payload);
	}
}

/**
 * Map an event name + attributes to the subscription status to store.
 */
function mapEventToStatus(
	eventName: string,
	attrs: Record<string, unknown>,
	existing: Record<string, unknown> | null,
): SubscriptionStatus {
	switch (eventName) {
		case "subscription_created":
		case "subscription_updated":
			return (attrs.status as SubscriptionStatus) ?? "active";
		case "subscription_paused":
			return "paused";
		case "subscription_unpaused":
			return "active";
		case "subscription_cancelled":
			return "cancelled";
		case "subscription_expired":
			return "expired";
		default:
			return (existing?.status as SubscriptionStatus) ?? "active";
	}
}

/**
 * Handle payment events with conditional status updates.
 */
async function handlePaymentEvent(
	ctx: WebhookContext,
	eventName: string,
	existing: Record<string, unknown> | null,
	lsSubscriptionId: string,
	incomingUpdatedAt: Date | null,
): Promise<void> {
	if (!existing) return; // No subscription record to update

	const currentStatus = existing.status as string;
	let newStatus: string | null = null;

	switch (eventName) {
		case "subscription_payment_success":
		case "subscription_payment_recovered":
			// Only update to active if currently past_due or unpaid
			if (currentStatus === "past_due" || currentStatus === "unpaid") {
				newStatus = "active";
			}
			break;
		case "subscription_payment_failed":
			// Only update to past_due if currently active
			if (currentStatus === "active") {
				newStatus = "past_due";
			}
			break;
		case "subscription_payment_refunded":
			// No status change
			break;
	}

	if (newStatus) {
		const updateData: Record<string, unknown> = {
			status: newStatus,
			updatedAt: new Date(),
		};
		if (incomingUpdatedAt) {
			updateData.lsUpdatedAt = incomingUpdatedAt;
		}
		await ctx.adapter.update({
			model: "lsSubscription",
			update: updateData,
			where: [{ field: "lsSubscriptionId", value: lsSubscriptionId }],
		});
	}
}
