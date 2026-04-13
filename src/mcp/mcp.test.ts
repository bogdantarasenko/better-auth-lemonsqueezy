import { describe, it, expect } from "vitest";
import { createLemonSqueezyMcpServer } from "./index.js";

describe("createLemonSqueezyMcpServer", () => {
	it("returns an object with a start method", () => {
		const result = createLemonSqueezyMcpServer({
			apiKey: "test-api-key",
		});

		expect(result).toBeDefined();
		expect(typeof result.start).toBe("function");
		expect(result.server).toBeDefined();
	});

	it("registers all expected tools", () => {
		const result = createLemonSqueezyMcpServer({
			apiKey: "test-api-key",
		});

		// Access internal registered tools to verify count
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const registeredTools = (result.server as any)._registeredTools;
		const toolNames = Object.keys(registeredTools);

		// 17 tools total:
		// user-and-stores: get_user, list_stores, get_store (3)
		// products-and-variants: list_products, get_product, get_product_variants (3)
		// orders-and-customers: list_orders, get_order, list_customers, get_customer (4)
		// subscriptions-and-license-keys: list_subscriptions, get_subscription, list_license_keys, get_license_key (4)
		// checkouts-and-webhooks: create_checkout, create_webhook, list_webhooks (3)
		expect(toolNames).toHaveLength(17);

		const expectedTools = [
			"get_user",
			"list_stores",
			"get_store",
			"list_products",
			"get_product",
			"get_product_variants",
			"list_orders",
			"get_order",
			"list_customers",
			"get_customer",
			"list_subscriptions",
			"get_subscription",
			"list_license_keys",
			"get_license_key",
			"create_checkout",
			"create_webhook",
			"list_webhooks",
		];

		for (const tool of expectedTools) {
			expect(toolNames).toContain(tool);
		}
	});
});
