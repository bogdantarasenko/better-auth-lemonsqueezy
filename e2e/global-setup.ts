import type { GlobalSetupContext } from "vitest/node";
import { startServer, stopServer } from "./fixtures/server";
import { startTunnel, stopTunnel } from "./fixtures/tunnel";
import { getEnv } from "./fixtures/env";

/**
 * Vitest global setup for E2E tests.
 * Starts the Better Auth test server + tunnel, then exposes
 * connection details to tests via provide().
 */
export default async function setup({ provide }: GlobalSetupContext) {
	// Validate env vars early — fail fast with clear message
	getEnv();

	// Start tunnel first to get the public URL
	const tunnelUrl = await startTunnel(4738);

	// Start the test server with the tunnel URL for success/cancel redirects
	const serverUrl = await startServer(tunnelUrl);

	// Provide connection details to test files via vitest injection
	provide("serverUrl", serverUrl);
	provide("tunnelUrl", tunnelUrl);

	console.log("[e2e] Global setup complete");

	// Return teardown function
	return async () => {
		console.log("[e2e] Global teardown starting...");
		await stopServer();
		await stopTunnel();
		console.log("[e2e] Global teardown complete");
	};
}

// Type augmentation for vitest injection
declare module "vitest" {
	export interface ProvidedContext {
		serverUrl: string;
		tunnelUrl: string;
	}
}
