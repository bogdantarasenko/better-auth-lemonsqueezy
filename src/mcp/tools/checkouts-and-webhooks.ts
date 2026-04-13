import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lsFetch } from "../../ls-fetch.js";

const LS_API_BASE = "https://api.lemonsqueezy.com";

export function registerCheckoutAndWebhookTools(
	server: McpServer,
	apiKey: string,
	options?: { storeId?: string },
) {
	const headers = {
		Authorization: `Bearer ${apiKey}`,
		Accept: "application/vnd.api+json",
		"Content-Type": "application/vnd.api+json",
	};

	server.tool(
		"create_checkout",
		"Create a Lemon Squeezy checkout",
		{
			data: z.object({}).passthrough().describe("Lemon Squeezy checkout payload (JSON:API format)"),
		},
		async ({ data }) => {
			const result = await lsFetch(`${LS_API_BASE}/v1/checkouts`, {
				method: "POST",
				headers,
				body: JSON.stringify(data),
			});
			if (result.error) {
				return { content: [{ type: "text", text: JSON.stringify({ error: result.error, code: result.code, status: result.status }) }] };
			}
			return { content: [{ type: "text", text: JSON.stringify(result.data) }] };
		},
	);

	server.tool(
		"create_webhook",
		"Create a Lemon Squeezy webhook",
		{
			webhook_data: z.object({}).passthrough().describe("Lemon Squeezy webhook payload (JSON:API format)"),
		},
		async ({ webhook_data }) => {
			const result = await lsFetch(`${LS_API_BASE}/v1/webhooks`, {
				method: "POST",
				headers,
				body: JSON.stringify(webhook_data),
			});
			if (result.error) {
				return { content: [{ type: "text", text: JSON.stringify({ error: result.error, code: result.code, status: result.status }) }] };
			}
			return { content: [{ type: "text", text: JSON.stringify(result.data) }] };
		},
	);

	server.tool(
		"list_webhooks",
		"List Lemon Squeezy webhooks, optionally filtered by store",
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
			const url = `${LS_API_BASE}/v1/webhooks${qs ? `?${qs}` : ""}`;
			const result = await lsFetch(url, { method: "GET", headers });
			if (result.error) {
				return { content: [{ type: "text", text: JSON.stringify({ error: result.error, code: result.code, status: result.status }) }] };
			}
			return { content: [{ type: "text", text: JSON.stringify(result.data) }] };
		},
	);
}
