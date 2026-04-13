import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lsFetch } from "../../ls-fetch.js";

const LS_API_BASE = "https://api.lemonsqueezy.com";

export function registerOrderAndCustomerTools(
	server: McpServer,
	apiKey: string,
	options?: { storeId?: string },
) {
	const headers = {
		Authorization: `Bearer ${apiKey}`,
		Accept: "application/vnd.api+json",
	};

	server.tool(
		"list_orders",
		"List Lemon Squeezy orders, optionally filtered by store",
		{
			store_id: z.string().optional().describe("Filter by store ID"),
			page: z.number().optional().describe("Page number for pagination"),
			per_page: z.number().optional().describe("Number of items per page"),
		},
		async ({ store_id, page, per_page }) => {
			const params = new URLSearchParams();
			const effectiveStoreId = store_id ?? options?.storeId;
			if (effectiveStoreId) params.set("filter[store_id]", effectiveStoreId);
			if (page) params.set("page[number]", String(page));
			if (per_page) params.set("page[size]", String(per_page));
			const qs = params.toString();
			const url = `${LS_API_BASE}/v1/orders${qs ? `?${qs}` : ""}`;
			const result = await lsFetch(url, { method: "GET", headers });
			if (result.error) {
				return { content: [{ type: "text", text: JSON.stringify({ error: result.error, code: result.code, status: result.status }) }] };
			}
			return { content: [{ type: "text", text: JSON.stringify(result.data) }] };
		},
	);

	server.tool(
		"get_order",
		"Get a specific Lemon Squeezy order by ID",
		{
			order_id: z.string().describe("The order ID"),
		},
		async ({ order_id }) => {
			const result = await lsFetch(`${LS_API_BASE}/v1/orders/${order_id}`, {
				method: "GET",
				headers,
			});
			if (result.error) {
				return { content: [{ type: "text", text: JSON.stringify({ error: result.error, code: result.code, status: result.status }) }] };
			}
			return { content: [{ type: "text", text: JSON.stringify(result.data) }] };
		},
	);

	server.tool(
		"list_customers",
		"List Lemon Squeezy customers, optionally filtered by store",
		{
			store_id: z.string().optional().describe("Filter by store ID"),
			page: z.number().optional().describe("Page number for pagination"),
			per_page: z.number().optional().describe("Number of items per page"),
		},
		async ({ store_id, page, per_page }) => {
			const params = new URLSearchParams();
			const effectiveStoreId = store_id ?? options?.storeId;
			if (effectiveStoreId) params.set("filter[store_id]", effectiveStoreId);
			if (page) params.set("page[number]", String(page));
			if (per_page) params.set("page[size]", String(per_page));
			const qs = params.toString();
			const url = `${LS_API_BASE}/v1/customers${qs ? `?${qs}` : ""}`;
			const result = await lsFetch(url, { method: "GET", headers });
			if (result.error) {
				return { content: [{ type: "text", text: JSON.stringify({ error: result.error, code: result.code, status: result.status }) }] };
			}
			return { content: [{ type: "text", text: JSON.stringify(result.data) }] };
		},
	);

	server.tool(
		"get_customer",
		"Get a specific Lemon Squeezy customer by ID",
		{
			customer_id: z.string().describe("The customer ID"),
		},
		async ({ customer_id }) => {
			const result = await lsFetch(`${LS_API_BASE}/v1/customers/${customer_id}`, {
				method: "GET",
				headers,
			});
			if (result.error) {
				return { content: [{ type: "text", text: JSON.stringify({ error: result.error, code: result.code, status: result.status }) }] };
			}
			return { content: [{ type: "text", text: JSON.stringify(result.data) }] };
		},
	);
}
