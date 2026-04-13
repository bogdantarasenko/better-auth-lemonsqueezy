import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getEnv } from "./fixtures/env";
import { createLemonSqueezyMcpServer } from "./helpers/mcp-client";

/**
 * Suite 8: MCP Tool Tests
 *
 * Creates the MCP server in-process with the real LS API key,
 * connects a Client via InMemoryTransport, and exercises every tool.
 */
describe("Suite 8: MCP Tools", () => {
	const env = getEnv();
	let client: Client;
	let cleanup: () => Promise<void>;

	// Track IDs discovered during list operations for get tests
	let orderId: string | undefined;
	let customerId: string | undefined;
	let subscriptionId: string | undefined;

	beforeAll(async () => {
		const { server } = createLemonSqueezyMcpServer({
			apiKey: env.LEMONSQUEEZY_API_KEY,
			storeId: env.LEMONSQUEEZY_STORE_ID,
			auditLog: true,
		});

		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();

		client = new Client(
			{ name: "e2e-test-client", version: "1.0.0" },
		);

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		cleanup = async () => {
			await client.close();
			await server.close();
		};
	});

	afterAll(async () => {
		await cleanup?.();
	});

	/** Helper: call tool and parse the text content as JSON */
	async function callTool(
		name: string,
		args: Record<string, unknown> = {},
	) {
		const result = await client.callTool({ name, arguments: args });
		const text = (result.content as Array<{ type: string; text: string }>)[0]
			?.text;
		expect(text).toBeTruthy();
		return JSON.parse(text!);
	}

	// ── User & Stores ──────────────────────────────────────────

	it("8.1 — get_user returns authenticated user data", async () => {
		const data = await callTool("get_user");
		expect(data.data).toBeDefined();
		expect(data.data.id).toBeTruthy();
		expect(data.data.attributes).toBeDefined();
		expect(data.data.attributes.email).toBeTruthy();
	});

	it("8.2 — list_stores returns at least the test store", async () => {
		const data = await callTool("list_stores");
		expect(data.data).toBeDefined();
		expect(Array.isArray(data.data)).toBe(true);
		expect(data.data.length).toBeGreaterThanOrEqual(1);

		const storeIds = data.data.map((s: { id: string }) => s.id);
		expect(storeIds).toContain(env.LEMONSQUEEZY_STORE_ID);
	});

	it("8.3 — get_store returns test store by ID", async () => {
		const data = await callTool("get_store", {
			store_id: env.LEMONSQUEEZY_STORE_ID,
		});
		expect(data.data).toBeDefined();
		expect(data.data.id).toBe(env.LEMONSQUEEZY_STORE_ID);
		expect(data.data.attributes.name).toBeTruthy();
	});

	// ── Products & Variants ────────────────────────────────────

	it("8.4 — list_products returns products filtered by store", async () => {
		const data = await callTool("list_products", {
			store_id: env.LEMONSQUEEZY_STORE_ID,
		});
		expect(data.data).toBeDefined();
		expect(Array.isArray(data.data)).toBe(true);
		expect(data.data.length).toBeGreaterThanOrEqual(2);

		const productIds = data.data.map((p: { id: string }) => p.id);
		expect(productIds).toContain(env.LEMONSQUEEZY_PRO_PRODUCT_ID);
		expect(productIds).toContain(env.LEMONSQUEEZY_MAX_PRODUCT_ID);
	});

	it("8.5 — get_product returns pro product by ID", async () => {
		const data = await callTool("get_product", {
			product_id: env.LEMONSQUEEZY_PRO_PRODUCT_ID,
		});
		expect(data.data).toBeDefined();
		expect(data.data.id).toBe(env.LEMONSQUEEZY_PRO_PRODUCT_ID);
		expect(data.data.attributes.name).toBeTruthy();
	});

	it("8.6 — get_product_variants returns variants for pro product", async () => {
		const data = await callTool("get_product_variants", {
			product_id: env.LEMONSQUEEZY_PRO_PRODUCT_ID,
		});
		expect(data.data).toBeDefined();
		expect(Array.isArray(data.data)).toBe(true);

		const variantIds = data.data.map((v: { id: string }) => v.id);
		expect(variantIds).toContain(env.LEMONSQUEEZY_PRO_MONTHLY_VARIANT_ID);
		expect(variantIds).toContain(env.LEMONSQUEEZY_PRO_ANNUAL_VARIANT_ID);
	});

	// ── Orders & Customers ─────────────────────────────────────

	it("8.7 — list_orders returns orders", async () => {
		const data = await callTool("list_orders", {
			store_id: env.LEMONSQUEEZY_STORE_ID,
		});
		expect(data.data).toBeDefined();
		expect(Array.isArray(data.data)).toBe(true);
		// Orders may exist from checkout tests — save first ID if available
		if (data.data.length > 0) {
			orderId = data.data[0].id;
		}
	});

	it("8.8 — get_order returns specific order if available", async ({
		skip,
	}) => {
		if (!orderId) {
			skip();
			return;
		}
		const data = await callTool("get_order", { order_id: orderId });
		expect(data.data).toBeDefined();
		expect(data.data.id).toBe(orderId);
		expect(data.data.attributes).toBeDefined();
	});

	it("8.9 — list_customers returns customers", async () => {
		const data = await callTool("list_customers", {
			store_id: env.LEMONSQUEEZY_STORE_ID,
		});
		expect(data.data).toBeDefined();
		expect(Array.isArray(data.data)).toBe(true);
		expect(data.data.length).toBeGreaterThanOrEqual(1);
		// Save first customer ID for get test
		customerId = data.data[0].id;
	});

	it("8.10 — get_customer returns specific customer by ID", async ({
		skip,
	}) => {
		if (!customerId) {
			skip();
			return;
		}
		const data = await callTool("get_customer", {
			customer_id: customerId,
		});
		expect(data.data).toBeDefined();
		expect(data.data.id).toBe(customerId);
		expect(data.data.attributes).toBeDefined();
	});

	// ── Subscriptions & License Keys ───────────────────────────

	it("8.11 — list_subscriptions returns subscriptions", async () => {
		const data = await callTool("list_subscriptions", {
			store_id: env.LEMONSQUEEZY_STORE_ID,
		});
		expect(data.data).toBeDefined();
		expect(Array.isArray(data.data)).toBe(true);
		expect(data.data.length).toBeGreaterThanOrEqual(1);
		// Save first subscription ID for get test
		subscriptionId = data.data[0].id;
	});

	it("8.12 — get_subscription returns specific subscription by ID", async ({
		skip,
	}) => {
		if (!subscriptionId) {
			skip();
			return;
		}
		const data = await callTool("get_subscription", {
			subscription_id: subscriptionId,
		});
		expect(data.data).toBeDefined();
		expect(data.data.id).toBe(subscriptionId);
		expect(data.data.attributes).toBeDefined();
	});

	it("8.13 — list_license_keys returns license keys (may be empty)", async () => {
		const data = await callTool("list_license_keys", {
			store_id: env.LEMONSQUEEZY_STORE_ID,
		});
		expect(data.data).toBeDefined();
		expect(Array.isArray(data.data)).toBe(true);
		// License keys may or may not exist — just confirm the response shape
	});

	// ── Checkouts & Webhooks ───────────────────────────────────

	it("8.14 — list_webhooks returns configured webhooks", async () => {
		const data = await callTool("list_webhooks", {
			store_id: env.LEMONSQUEEZY_STORE_ID,
		});
		expect(data.data).toBeDefined();
		expect(Array.isArray(data.data)).toBe(true);
	});

	it("8.15 — create_checkout creates a checkout and returns URL", async () => {
		const data = await callTool("create_checkout", {
			data: {
				type: "checkouts",
				attributes: {
					checkout_data: {
						email: "mcp-test@example.com",
						name: "MCP Test",
					},
				},
				relationships: {
					store: {
						data: {
							type: "stores",
							id: env.LEMONSQUEEZY_STORE_ID,
						},
					},
					variant: {
						data: {
							type: "variants",
							id: env.LEMONSQUEEZY_PRO_MONTHLY_VARIANT_ID,
						},
					},
				},
			},
		});
		expect(data.data).toBeDefined();
		expect(data.data.attributes.url).toBeTruthy();
		expect(data.data.attributes.url).toMatch(/^https:\/\//);
	});

	it("8.16 — create_webhook creates a test webhook", async () => {
		const data = await callTool("create_webhook", {
			webhook_data: {
				data: {
					type: "webhooks",
					attributes: {
						url: "https://mcp-e2e-test.example.com/webhook",
						events: ["subscription_created"],
						secret: "mcp-test-secret-12345",
					},
					relationships: {
						store: {
							data: {
								type: "stores",
								id: env.LEMONSQUEEZY_STORE_ID,
							},
						},
					},
				},
			},
		});
		expect(data.data).toBeDefined();
		expect(data.data.id).toBeTruthy();
		expect(data.data.attributes.url).toBe(
			"https://mcp-e2e-test.example.com/webhook",
		);
	});

	// ── Audit Log ──────────────────────────────────────────────

	it("8.17 — Audit log resource contains entries from previous tool calls", async () => {
		const resource = await client.readResource({
			uri: "audit://lemonsqueezy-operations",
		});
		expect(resource.contents).toBeDefined();
		expect(resource.contents.length).toBe(1);

		const entries = JSON.parse(resource.contents[0].text!);
		expect(Array.isArray(entries)).toBe(true);
		// We should have at least 16 entries from previous tests (8.1–8.16)
		expect(entries.length).toBeGreaterThanOrEqual(16);

		// Verify entry shape
		const firstEntry = entries[0];
		expect(firstEntry.tool).toBeTruthy();
		expect(firstEntry.timestamp).toBeTruthy();
		expect(typeof firstEntry.success).toBe("boolean");

		// Verify specific tools appear in the log
		const toolNames = entries.map((e: { tool: string }) => e.tool);
		expect(toolNames).toContain("get_user");
		expect(toolNames).toContain("list_stores");
		expect(toolNames).toContain("create_checkout");
		expect(toolNames).toContain("create_webhook");
	});
});
