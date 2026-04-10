/**
 * Plan-based access control helpers for Lemon Squeezy subscriptions.
 *
 * All helpers query the local lsSubscription table (no API calls to Lemon Squeezy).
 * Accept userId as a string — extracting userId from session/request is the consumer's responsibility.
 *
 * NOTE: Only subscriptions with status "active" or "on_trial" are considered active.
 * Subscriptions with status "paused" are NOT treated as active — if your application
 * needs to grant access during pause periods, check the status explicitly.
 */

interface Adapter {
	findMany(opts: {
		model: string;
		where: Array<{ field: string; value: string }>;
	}): Promise<Array<Record<string, unknown>>>;
}

/**
 * Create access control helpers bound to a database adapter.
 *
 * Usage:
 * ```ts
 * const auth = betterAuth({ plugins: [lemonSqueezy({...})] });
 * const { hasActiveSubscription, hasActivePlan, requirePlan } = createAccessControlHelpers(auth);
 * ```
 */
export function createAccessControlHelpers(adapterOrAuth: Adapter | { options: { adapter: Adapter } }) {
	const adapter: Adapter =
		"findMany" in adapterOrAuth
			? adapterOrAuth
			: adapterOrAuth.options.adapter;

	/**
	 * Returns true if the user has any subscription with status "active" or "on_trial".
	 */
	async function hasActiveSubscription(userId: string): Promise<boolean> {
		const subscriptions = (await adapter.findMany({
			model: "lsSubscription",
			where: [{ field: "userId", value: userId }],
		})) as Array<Record<string, unknown>>;

		return subscriptions.some(
			(s) => s.status === "active" || s.status === "on_trial",
		);
	}

	/**
	 * Returns true if the user has an active subscription matching the given plan name.
	 */
	async function hasActivePlan(
		userId: string,
		planName: string,
	): Promise<boolean> {
		const subscriptions = (await adapter.findMany({
			model: "lsSubscription",
			where: [{ field: "userId", value: userId }],
		})) as Array<Record<string, unknown>>;

		return subscriptions.some(
			(s) =>
				s.planName === planName &&
				(s.status === "active" || s.status === "on_trial"),
		);
	}

	/**
	 * Verifies the user has the required plan.
	 * Returns { allowed: true, subscription } if the user has an active subscription for the plan,
	 * or { allowed: false } otherwise.
	 */
	async function requirePlan(
		userId: string,
		planName: string,
	): Promise<{
		allowed: boolean;
		subscription?: Record<string, unknown>;
	}> {
		const subscriptions = (await adapter.findMany({
			model: "lsSubscription",
			where: [{ field: "userId", value: userId }],
		})) as Array<Record<string, unknown>>;

		const match = subscriptions.find(
			(s) =>
				s.planName === planName &&
				(s.status === "active" || s.status === "on_trial"),
		);

		return match
			? { allowed: true, subscription: match }
			: { allowed: false };
	}

	return { hasActiveSubscription, hasActivePlan, requirePlan };
}
