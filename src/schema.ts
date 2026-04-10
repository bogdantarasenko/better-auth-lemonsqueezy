/**
 * Database schema definitions for the Lemon Squeezy plugin.
 */

export const lsCustomerSchema = {
	lsCustomer: {
		fields: {
			userId: {
				type: "string" as const,
				required: true,
				unique: true,
				references: {
					model: "user",
					field: "id",
					onDelete: "cascade" as const,
				},
			},
			lsCustomerId: {
				type: "string" as const,
				required: true,
				unique: true,
			},
			email: {
				type: "string" as const,
				required: true,
			},
			createdAt: {
				type: "date" as const,
				required: true,
			},
			updatedAt: {
				type: "date" as const,
				required: true,
			},
		},
	},
} as const;

export const lsSubscriptionSchema = {
	lsSubscription: {
		fields: {
			userId: {
				type: "string" as const,
				required: true,
				references: {
					model: "user",
					field: "id",
					onDelete: "cascade" as const,
				},
			},
			lsSubscriptionId: {
				type: "string" as const,
				required: true,
				unique: true,
			},
			lsCustomerId: {
				type: "string" as const,
				required: true,
			},
			variantId: {
				type: "string" as const,
				required: true,
			},
			productId: {
				type: "string" as const,
				required: true,
			},
			subscriptionItemId: {
				type: "string" as const,
				required: false,
			},
			status: {
				type: "string" as const,
				required: true,
			},
			planName: {
				type: "string" as const,
				required: true,
			},
			interval: {
				type: "string" as const,
				required: false,
			},
			cancelledAt: {
				type: "date" as const,
				required: false,
			},
			renewsAt: {
				type: "date" as const,
				required: false,
			},
			endsAt: {
				type: "date" as const,
				required: false,
			},
			trialEndsAt: {
				type: "date" as const,
				required: false,
			},
			lsUpdatedAt: {
				type: "date" as const,
				required: false,
			},
			createdAt: {
				type: "date" as const,
				required: true,
			},
			updatedAt: {
				type: "date" as const,
				required: true,
			},
		},
	},
} as const;

export const schema = {
	...lsCustomerSchema,
	...lsSubscriptionSchema,
};
