import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lsFetch } from "../../ls-fetch.js";

const LS_API_BASE = "https://api.lemonsqueezy.com";

export function registerProductAndVariantTools(
	server: McpServer,
	apiKey: string,
	options?: { storeId?: string },
) {
	const headers = {
		Authorization: `Bearer ${apiKey}`,
		Accept: "application/vnd.api+json",
	};

	server.tool(
		"list_products",
		"List Lemon Squeezy products, optionally filtered by store",
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
			const url = `${LS_API_BASE}/v1/products${qs ? `?${qs}` : ""}`;
			const result = await lsFetch(url, { method: "GET", headers });
			if (result.error) {
				return { content: [{ type: "text", text: JSON.stringify({ error: result.error, code: result.code, status: result.status }) }] };
			}
			return { content: [{ type: "text", text: JSON.stringify(result.data) }] };
		},
	);

	server.tool(
		"get_product",
		"Get a specific Lemon Squeezy product by ID",
		{
			product_id: z.string().describe("The product ID"),
		},
		async ({ product_id }) => {
			const result = await lsFetch(`${LS_API_BASE}/v1/products/${product_id}`, {
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
		"get_product_variants",
		"Get all variants for a specific Lemon Squeezy product",
		{
			product_id: z.string().describe("The product ID to get variants for"),
		},
		async ({ product_id }) => {
			const result = await lsFetch(`${LS_API_BASE}/v1/variants?filter[product_id]=${product_id}`, {
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
