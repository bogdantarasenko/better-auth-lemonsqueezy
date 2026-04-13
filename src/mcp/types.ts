export interface LemonSqueezyMcpOptions {
	/** Lemon Squeezy API key (required) */
	apiKey: string;
	/** MCP server name reported to clients (default: "lemonsqueezy-mcp") */
	serverName?: string;
	/** MCP server version reported to clients */
	serverVersion?: string;
	/** Default store ID used as a filter for list operations when no store_id param is provided */
	storeId?: string;
	/** Enable in-memory audit log of tool invocations (default: true) */
	auditLog?: boolean;
}
