#!/usr/bin/env node
import { createLemonSqueezyMcpServer } from "./index.js";

const apiKey = process.env.LEMONSQUEEZY_API_KEY;

if (!apiKey) {
	console.error(
		"Error: LEMONSQUEEZY_API_KEY environment variable is not set.\n\n" +
		"Set it before running the MCP server:\n" +
		"  export LEMONSQUEEZY_API_KEY=your_api_key_here\n" +
		"  npx better-auth-lemonsqueezy-mcp",
	);
	process.exit(1);
}

const { start } = createLemonSqueezyMcpServer({
	apiKey,
	storeId: process.env.LEMONSQUEEZY_STORE_ID,
});

start();
