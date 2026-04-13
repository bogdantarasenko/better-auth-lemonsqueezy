import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lsFetch } from "../../ls-fetch.js";

const LS_API_BASE = "https://api.lemonsqueezy.com";

export function registerUserAndStoreTools(
	server: McpServer,
	apiKey: string,
) {
	const headers = {
		Authorization: `Bearer ${apiKey}`,
		Accept: "application/vnd.api+json",
	};

	server.tool(
		"get_user",
		"Get the authenticated Lemon Squeezy user",
		{},
		async () => {
			const result = await lsFetch(`${LS_API_BASE}/v1/users/me`, {
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
		"list_stores",
		"List all Lemon Squeezy stores",
		{},
		async () => {
			const result = await lsFetch(`${LS_API_BASE}/v1/stores`, {
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
		"get_store",
		"Get a specific Lemon Squeezy store by ID",
		{
			store_id: z.string().describe("The store ID"),
		},
		async ({ store_id }) => {
			const result = await lsFetch(`${LS_API_BASE}/v1/stores/${store_id}`, {
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
