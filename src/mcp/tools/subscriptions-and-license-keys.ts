import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lsFetch } from "../../ls-fetch.js";

const LS_API_BASE = "https://api.lemonsqueezy.com";

export function registerSubscriptionAndLicenseKeyTools(
	server: McpServer,
	apiKey: string,
	options?: { storeId?: string },
) {
	const headers = {
		Authorization: `Bearer ${apiKey}`,
		Accept: "application/vnd.api+json",
	};

	server.tool(
		"list_subscriptions",
		"List Lemon Squeezy subscriptions, optionally filtered by store",
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
			const url = `${LS_API_BASE}/v1/subscriptions${qs ? `?${qs}` : ""}`;
			const result = await lsFetch(url, { method: "GET", headers });
			if (result.error) {
				return { content: [{ type: "text", text: JSON.stringify({ error: result.error, code: result.code, status: result.status }) }] };
			}
			return { content: [{ type: "text", text: JSON.stringify(result.data) }] };
		},
	);

	server.tool(
		"get_subscription",
		"Get a specific Lemon Squeezy subscription by ID",
		{
			subscription_id: z.string().describe("The subscription ID"),
		},
		async ({ subscription_id }) => {
			const result = await lsFetch(`${LS_API_BASE}/v1/subscriptions/${subscription_id}`, {
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
		"list_license_keys",
		"List Lemon Squeezy license keys, optionally filtered by store",
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
			const url = `${LS_API_BASE}/v1/license-keys${qs ? `?${qs}` : ""}`;
			const result = await lsFetch(url, { method: "GET", headers });
			if (result.error) {
				return { content: [{ type: "text", text: JSON.stringify({ error: result.error, code: result.code, status: result.status }) }] };
			}
			return { content: [{ type: "text", text: JSON.stringify(result.data) }] };
		},
	);

	server.tool(
		"get_license_key",
		"Get a specific Lemon Squeezy license key by ID",
		{
			license_key_id: z.string().describe("The license key ID"),
		},
		async ({ license_key_id }) => {
			const result = await lsFetch(`${LS_API_BASE}/v1/license-keys/${license_key_id}`, {
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
