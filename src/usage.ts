/**
 * Usage reporting helpers for Lemon Squeezy usage-based billing.
 */

interface Adapter {
	findOne(params: {
		model: string;
		where: Array<{ field: string; value: unknown }>;
	}): Promise<Record<string, unknown> | null>;
}

/**
 * Report usage to Lemon Squeezy for a subscription.
 * Resolves the subscriptionItemId internally from the local database.
 */
async function reportUsage(
	adapter: Adapter,
	apiKey: string,
	userId: string,
	subscriptionId: string,
	quantity: number,
): Promise<void> {
	if (!Number.isInteger(quantity) || quantity <= 0) {
		throw new Error("Quantity must be a positive integer");
	}

	const subscription = (await adapter.findOne({
		model: "lsSubscription",
		where: [{ field: "lsSubscriptionId", value: subscriptionId }],
	})) as Record<string, unknown> | null;

	if (!subscription) {
		throw new Error("Subscription not found");
	}
	if (subscription.userId !== userId) {
		throw new Error("Not authorized");
	}

	const subscriptionItemId = subscription.subscriptionItemId as
		| string
		| null;
	if (!subscriptionItemId) {
		throw new Error(
			"No subscription item ID found — usage reporting requires a usage-based subscription",
		);
	}

	const response = await fetch(
		"https://api.lemonsqueezy.com/v1/usage-records",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/vnd.api+json",
				"Content-Type": "application/vnd.api+json",
			},
			body: JSON.stringify({
				data: {
					type: "usage-records",
					attributes: {
						quantity,
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

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`Lemon Squeezy usage report failed: ${response.status} ${errorText}`,
		);
	}
}

/**
 * Factory that creates a reportUsage function bound to a specific adapter and API key.
 * Accepts either a raw adapter or an auth-like object with options.adapter.
 */
export function createUsageReporter(
	adapterOrAuth: Adapter | { options: { adapter: Adapter } },
	apiKey: string,
) {
	const adapter =
		"options" in adapterOrAuth
			? adapterOrAuth.options.adapter
			: adapterOrAuth;

	return (
		userId: string,
		subscriptionId: string,
		quantity: number,
	): Promise<void> => {
		return reportUsage(adapter, apiKey, userId, subscriptionId, quantity);
	};
}
