import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { LemonSqueezyMcpOptions } from "./types.js";
import { AuditLog } from "./audit-log.js";
import { registerUserAndStoreTools } from "./tools/user-and-stores.js";
import { registerProductAndVariantTools } from "./tools/products-and-variants.js";
import { registerOrderAndCustomerTools } from "./tools/orders-and-customers.js";
import { registerSubscriptionAndLicenseKeyTools } from "./tools/subscriptions-and-license-keys.js";
import { registerCheckoutAndWebhookTools } from "./tools/checkouts-and-webhooks.js";

export type { LemonSqueezyMcpOptions } from "./types.js";

function wrapServerWithAuditLog(server: McpServer, auditLog: AuditLog) {
	const originalTool = server.tool.bind(server);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(server as any).tool = function (...args: any[]) {
		const name = args[0] as string;
		// The handler is always the last argument
		const handlerIndex = args.length - 1;
		const originalHandler = args[handlerIndex];

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		args[handlerIndex] = async (params: any, extra: any) => {
			let success = true;
			try {
				const result = await originalHandler(params, extra);
				return result;
			} catch (error) {
				success = false;
				throw error;
			} finally {
				auditLog.add({
					tool: name,
					parameters: params ?? {},
					timestamp: new Date().toISOString(),
					success,
				});
			}
		};

		return (originalTool as Function).apply(server, args);
	};
}

export function createLemonSqueezyMcpServer(options: LemonSqueezyMcpOptions) {
	const {
		serverName = "lemonsqueezy-mcp",
		serverVersion = "0.1.0",
		auditLog: auditLogEnabled = true,
	} = options;

	const server = new McpServer(
		{ name: serverName, version: serverVersion },
	);

	const auditLog = auditLogEnabled ? new AuditLog() : null;

	if (auditLog) {
		wrapServerWithAuditLog(server, auditLog);
	}

	registerUserAndStoreTools(server, options.apiKey);
	registerProductAndVariantTools(server, options.apiKey, { storeId: options.storeId });
	registerOrderAndCustomerTools(server, options.apiKey, { storeId: options.storeId });
	registerSubscriptionAndLicenseKeyTools(server, options.apiKey, { storeId: options.storeId });
	registerCheckoutAndWebhookTools(server, options.apiKey, { storeId: options.storeId });

	if (auditLog) {
		server.resource(
			"audit-log",
			"audit://lemonsqueezy-operations",
			{ description: "In-memory log of all tool invocations during the current MCP session" },
			async () => ({
				contents: [{
					uri: "audit://lemonsqueezy-operations",
					mimeType: "application/json",
					text: JSON.stringify(auditLog.getEntries(), null, 2),
				}],
			}),
		);
	}

	return {
		server,
		async start() {
			const transport = new StdioServerTransport();
			await server.connect(transport);
		},
	};
}
