#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createLemonSqueezyMcpServer } from "./index.js";

// Auto-load .env file if present in the current working directory
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
	try {
		process.loadEnvFile(envPath);
	} catch {
		// Node < 20.12 or malformed .env — fall through to process.env
	}
}

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
