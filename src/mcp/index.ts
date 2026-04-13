import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { LemonSqueezyMcpOptions } from "./types.js";
import { registerUserAndStoreTools } from "./tools/user-and-stores.js";
import { registerProductAndVariantTools } from "./tools/products-and-variants.js";

export type { LemonSqueezyMcpOptions } from "./types.js";

export function createLemonSqueezyMcpServer(options: LemonSqueezyMcpOptions) {
	const {
		serverName = "lemonsqueezy-mcp",
		serverVersion = "0.1.0",
	} = options;

	const server = new McpServer(
		{ name: serverName, version: serverVersion },
	);

	registerUserAndStoreTools(server, options.apiKey);
	registerProductAndVariantTools(server, options.apiKey, { storeId: options.storeId });

	return {
		server,
		async start() {
			const transport = new StdioServerTransport();
			await server.connect(transport);
		},
	};
}
