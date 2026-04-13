import { createAuthClient } from "better-auth/client";
import { lemonSqueezyClient } from "../../src/client";
import { ctx } from "../fixtures/context";

/**
 * Create a Better Auth client pointed at the e2e test server.
 */
export function getAuthClient() {
	return createAuthClient({
		baseURL: ctx.serverUrl,
		plugins: [lemonSqueezyClient()],
	});
}
