/**
 * Validate and return all required E2E environment variables.
 * Throws with a clear message listing any missing variables.
 */
export function getEnv() {
	const required = [
		"LEMONSQUEEZY_API_KEY",
		"LEMONSQUEEZY_STORE_ID",
		"LEMONSQUEEZY_WEBHOOK_SIGNING_SECRET",
		"LEMONSQUEEZY_PRO_PRODUCT_ID",
		"LEMONSQUEEZY_PRO_MONTHLY_VARIANT_ID",
		"LEMONSQUEEZY_PRO_ANNUAL_VARIANT_ID",
		"LEMONSQUEEZY_MAX_PRODUCT_ID",
		"LEMONSQUEEZY_MAX_MONTHLY_VARIANT_ID",
		"LEMONSQUEEZY_MAX_ANNUAL_VARIANT_ID",
	] as const;

	const missing = required.filter((key) => !process.env[key]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required E2E environment variables:\n${missing.map((k) => `  - ${k}`).join("\n")}\n\nSee e2e/.env.e2e.example for the full list.`,
		);
	}

	return {
		LEMONSQUEEZY_API_KEY: process.env.LEMONSQUEEZY_API_KEY!,
		LEMONSQUEEZY_STORE_ID: process.env.LEMONSQUEEZY_STORE_ID!,
		LEMONSQUEEZY_WEBHOOK_SIGNING_SECRET: process.env.LEMONSQUEEZY_WEBHOOK_SIGNING_SECRET!,
		LEMONSQUEEZY_PRO_PRODUCT_ID: process.env.LEMONSQUEEZY_PRO_PRODUCT_ID!,
		LEMONSQUEEZY_PRO_MONTHLY_VARIANT_ID: process.env.LEMONSQUEEZY_PRO_MONTHLY_VARIANT_ID!,
		LEMONSQUEEZY_PRO_ANNUAL_VARIANT_ID: process.env.LEMONSQUEEZY_PRO_ANNUAL_VARIANT_ID!,
		LEMONSQUEEZY_MAX_PRODUCT_ID: process.env.LEMONSQUEEZY_MAX_PRODUCT_ID!,
		LEMONSQUEEZY_MAX_MONTHLY_VARIANT_ID: process.env.LEMONSQUEEZY_MAX_MONTHLY_VARIANT_ID!,
		LEMONSQUEEZY_MAX_ANNUAL_VARIANT_ID: process.env.LEMONSQUEEZY_MAX_ANNUAL_VARIANT_ID!,
		E2E_TUNNEL_URL: process.env.E2E_TUNNEL_URL || "",
		E2E_HEADLESS: process.env.E2E_HEADLESS !== "false",
		E2E_SLOW_MO: Number(process.env.E2E_SLOW_MO || "0"),
	};
}
