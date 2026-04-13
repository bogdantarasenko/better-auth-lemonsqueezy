import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { LemonSqueezyMcpOptions } from "./types.js";

export type { LemonSqueezyMcpOptions } from "./types.js";

export function createLemonSqueezyMcpServer(options: LemonSqueezyMcpOptions) {
	const {
		serverName = "lemonsqueezy-mcp",
		serverVersion = "0.1.0",
	} = options;

	const server = new McpServer(
		{ name: serverName, version: serverVersion },
	);

	return {
		server,
		async start() {
			const transport = new StdioServerTransport();
			await server.connect(transport);
		},
	};
}
