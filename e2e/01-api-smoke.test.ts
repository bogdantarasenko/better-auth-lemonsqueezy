import { describe, it, expect, inject } from "vitest";
import { getEnv } from "./fixtures/env";

const LS_API_BASE = "https://api.lemonsqueezy.com/v1";

/**
 * Helper to make authenticated requests to the Lemon Squeezy API.
 */
function lsApi(path: string, apiKey: string) {
	return fetch(`${LS_API_BASE}${path}`, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/vnd.api+json",
		},
	});
}

describe("Suite 1: API Smoke Tests", () => {
	const env = getEnv();

	it("1.1 — API key is valid", async () => {
		const res = await lsApi("/users/me", env.E2E_LS_API_KEY);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.data).toBeDefined();
		expect(body.data.id).toBeTruthy();
	});

	it("1.2 — Test store exists", async () => {
		const res = await lsApi(
			`/stores/${env.E2E_LS_STORE_ID}`,
			env.E2E_LS_API_KEY,
		);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.data.id).toBe(env.E2E_LS_STORE_ID);
	});

	it("1.3 — Pro product exists", async () => {
		const res = await lsApi(
			`/products/${env.E2E_LS_PRO_PRODUCT_ID}`,
			env.E2E_LS_API_KEY,
		);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.data.id).toBe(env.E2E_LS_PRO_PRODUCT_ID);
	});

	it("1.4 — Enterprise product exists", async () => {
		const res = await lsApi(
			`/products/${env.E2E_LS_ENTERPRISE_PRODUCT_ID}`,
			env.E2E_LS_API_KEY,
		);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.data.id).toBe(env.E2E_LS_ENTERPRISE_PRODUCT_ID);
	});

	it("1.5 — Pro variants exist (monthly + annual)", async () => {
		const res = await lsApi(
			`/variants?filter[product_id]=${env.E2E_LS_PRO_PRODUCT_ID}`,
			env.E2E_LS_API_KEY,
		);
		expect(res.status).toBe(200);

		const body = await res.json();
		const variantIds = body.data.map(
			(v: { id: string }) => v.id,
		);

		expect(variantIds).toContain(env.E2E_LS_PRO_MONTHLY_VARIANT_ID);
		expect(variantIds).toContain(env.E2E_LS_PRO_ANNUAL_VARIANT_ID);
	});

	it("1.6 — Enterprise variants exist (monthly + annual)", async () => {
		const res = await lsApi(
			`/variants?filter[product_id]=${env.E2E_LS_ENTERPRISE_PRODUCT_ID}`,
			env.E2E_LS_API_KEY,
		);
		expect(res.status).toBe(200);

		const body = await res.json();
		const variantIds = body.data.map(
			(v: { id: string }) => v.id,
		);

		expect(variantIds).toContain(env.E2E_LS_ENTERPRISE_MONTHLY_VARIANT_ID);
		expect(variantIds).toContain(env.E2E_LS_ENTERPRISE_ANNUAL_VARIANT_ID);
	});

	it("1.7 — Webhook endpoint is reachable via tunnel", async () => {
		const tunnelUrl = inject("tunnelUrl");
		expect(tunnelUrl).toBeTruthy();

		// Hit the server's health / root endpoint through the tunnel
		const res = await fetch(tunnelUrl, {
			signal: AbortSignal.timeout(10_000),
		});

		// The server should respond (any 2xx/4xx means it's reachable —
		// we just need to confirm the tunnel is routing traffic)
		expect(res.status).toBeLessThan(500);
	});
});
