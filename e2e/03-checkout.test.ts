import { describe, it, expect, inject, beforeAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import Database from "better-sqlite3";
import { getEnv } from "./fixtures/env";
import { ctx } from "./fixtures/context";
import { poll } from "./helpers/poll";
import { checkoutSelectors } from "./selectors/checkout";

const DB_PATH = "e2e/test.db";

/**
 * Make an authenticated API call to the Better Auth server.
 * All lemonSqueezy endpoints live under /api/auth/lemonsqueezy/...
 */
async function apiCall(
	path: string,
	opts: {
		method?: string;
		body?: Record<string, unknown>;
		query?: Record<string, string>;
		sessionToken: string;
	},
) {
	const url = new URL(`${ctx.serverUrl}/api/auth${path}`);
	if (opts.query) {
		for (const [k, v] of Object.entries(opts.query)) {
			url.searchParams.set(k, v);
		}
	}

	const res = await fetch(url.toString(), {
		method: opts.method || "GET",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${opts.sessionToken}`,
		},
		body: opts.body ? JSON.stringify(opts.body) : undefined,
	});

	const data = await res.json();
	return { status: res.status, data };
}

/** Take a screenshot on failure for debugging. */
async function screenshotOnFailure(page: Page | null, name: string) {
	if (!page) return;
	try {
		await page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });
	} catch {
		// Ignore screenshot errors
	}
}

/**
 * Fill Stripe card fields on the LS checkout page.
 *
 * Lemon Squeezy's checkout uses Stripe Elements which renders card inputs
 * inside iframes. This helper locates the iframes and fills the card details.
 * Falls back to direct input selectors if no iframes found.
 */
async function fillCardDetails(
	page: Page,
	card: { number: string; expiry: string; cvc: string },
) {
	// Wait for the page to settle
	await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

	// Strategy 1: Stripe iframes
	const stripeIframes = page.frameLocator(
		'iframe[src*="stripe"], iframe[name*="__privateStripeFrame"], iframe[title*="Secure"]',
	);

	const cardInput = stripeIframes.first().locator(
		'input[name="cardnumber"], input[placeholder*="card number" i], input[autocomplete="cc-number"]',
	);

	const hasStripeFrames = await cardInput.count().catch(() => 0);

	if (hasStripeFrames > 0) {
		await cardInput.fill(card.number);

		const expiryInput = stripeIframes
			.locator('input[name="exp-date"], input[placeholder*="MM" i], input[autocomplete="cc-exp"]')
			.first();
		await expiryInput.fill(card.expiry);

		const cvcInput = stripeIframes
			.locator('input[name="cvc"], input[placeholder*="CVC" i], input[autocomplete="cc-csc"]')
			.first();
		await cvcInput.fill(card.cvc);
	} else {
		// Strategy 2: Direct inputs
		const directCard = page.locator(checkoutSelectors.cardNumberInput).first();
		await directCard.waitFor({ timeout: 15_000 });
		await directCard.fill(card.number);

		const directExpiry = page.locator(checkoutSelectors.expiryInput).first();
		await directExpiry.fill(card.expiry);

		const directCvc = page.locator(checkoutSelectors.cvcInput).first();
		await directCvc.fill(card.cvc);
	}
}

/**
 * Complete a Lemon Squeezy checkout page using Playwright.
 */
async function completeCheckout(
	browser: Browser,
	checkoutUrl: string,
	opts: {
		email: string;
		cardNumber: string;
		expiry: string;
		cvc: string;
		name: string;
		screenshotName: string;
	},
): Promise<void> {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 720 },
	});
	const page = await context.newPage();

	try {
		await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
		await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

		// Fill email if visible
		const emailInput = page.locator(checkoutSelectors.emailInput).first();
		if (await emailInput.isVisible().catch(() => false)) {
			await emailInput.fill(opts.email);
		}

		// Fill name if visible
		const nameInput = page.locator(checkoutSelectors.nameInput).first();
		if (await nameInput.isVisible().catch(() => false)) {
			await nameInput.fill(opts.name);
		}

		// Fill card details (handles Stripe iframes)
		await fillCardDetails(page, {
			number: opts.cardNumber,
			expiry: opts.expiry,
			cvc: opts.cvc,
		});

		// Submit
		const submitBtn = page.locator(checkoutSelectors.submitButton).first();
		await submitBtn.waitFor({ state: "visible", timeout: 10_000 });
		await submitBtn.click();

		// Wait for success redirect or confirmation
		await Promise.race([
			page.waitForURL("**/success**", { timeout: 60_000 }),
			page.waitForSelector("text=/thank|success|confirmed|complete/i", { timeout: 60_000 }),
		]);
	} catch (error) {
		await screenshotOnFailure(page, opts.screenshotName);
		throw error;
	} finally {
		await context.close();
	}
}

describe("Suite 3: Checkout & Subscription Creation (Playwright)", () => {
	const env = getEnv();
	let browser: Browser;
	let proCheckoutUrl: string;

	beforeAll(async () => {
		ctx.serverUrl = inject("serverUrl");
		ctx.tunnelUrl = inject("tunnelUrl");

		// Ensure screenshots directory exists
		const fs = await import("node:fs");
		if (!fs.existsSync("e2e/screenshots")) {
			fs.mkdirSync("e2e/screenshots", { recursive: true });
		}

		// Launch Playwright browser
		browser = await chromium.launch({
			headless: env.E2E_HEADLESS,
			slowMo: env.E2E_SLOW_MO,
		});

		return async () => {
			await browser?.close();
		};
	});

	it("3.1 — Create checkout returns valid URL", async () => {
		expect(ctx.testUser.sessionToken).toBeTruthy();

		const { status, data } = await apiCall("/lemonsqueezy/subscription/create", {
			method: "POST",
			body: { plan: "pro", interval: "monthly" },
			sessionToken: ctx.testUser.sessionToken,
		});

		expect(status).toBe(200);
		expect(data.url).toBeTruthy();

		// Verify it's a valid Lemon Squeezy checkout URL
		const url = new URL(data.url);
		expect(url.hostname).toContain("lemonsqueezy");

		proCheckoutUrl = data.url;
	});

	it("3.2 — Complete checkout (monthly pro) via Playwright", async () => {
		expect(proCheckoutUrl).toBeTruthy();

		await completeCheckout(browser, proCheckoutUrl, {
			email: ctx.testUser.email,
			cardNumber: "4242424242424242",
			expiry: "12/30",
			cvc: "123",
			name: "E2E Test User",
			screenshotName: "checkout-pro-monthly-failure",
		});
	});

	it("3.3 — Webhook creates subscription record", async () => {
		const db = new Database(DB_PATH, { readonly: true });
		try {
			const row = await poll(
				async () => {
					return db
						.prepare("SELECT * FROM lsSubscription WHERE userId = ? AND planName = ?")
						.get(ctx.testUser.id, "pro") as Record<string, unknown> | undefined;
				},
				{ timeoutMs: 30_000, intervalMs: 1_000, label: "pro subscription in DB" },
			);

			expect(row).toBeTruthy();
			expect(row.status).toBe("active");
			expect(row.planName).toBe("pro");
			expect(row.interval).toBe("monthly");
			expect(row.lsSubscriptionId).toBeTruthy();
			expect(row.lsCustomerId).toBeTruthy();
			expect(row.variantId).toBe(env.LEMONSQUEEZY_PRO_MONTHLY_VARIANT_ID);
			expect(row.productId).toBe(env.LEMONSQUEEZY_PRO_PRODUCT_ID);

			ctx.proSubscriptionId = row.id as string;
			ctx.proLsSubscriptionId = row.lsSubscriptionId as string;
		} finally {
			db.close();
		}
	});

	it("3.4 — Subscription appears in list", async () => {
		expect(ctx.proLsSubscriptionId).toBeTruthy();

		const { status, data } = await apiCall("/lemonsqueezy/subscription/list", {
			sessionToken: ctx.testUser.sessionToken,
		});

		expect(status).toBe(200);
		expect(data.subscriptions).toBeTruthy();
		expect(data.subscriptions.length).toBeGreaterThanOrEqual(1);

		const proSub = data.subscriptions.find(
			(s: Record<string, unknown>) => s.lsSubscriptionId === ctx.proLsSubscriptionId,
		);
		expect(proSub).toBeTruthy();
		expect(proSub.planName).toBe("pro");
		expect(proSub.status).toBe("active");
	});

	it("3.5 — Subscription get returns details", async () => {
		expect(ctx.proLsSubscriptionId).toBeTruthy();

		const { status, data } = await apiCall("/lemonsqueezy/subscription/get", {
			query: { subscriptionId: ctx.proLsSubscriptionId! },
			sessionToken: ctx.testUser.sessionToken,
		});

		expect(status).toBe(200);
		const sub = data.subscription;
		expect(sub).toBeTruthy();
		expect(sub.lsSubscriptionId).toBe(ctx.proLsSubscriptionId);
		expect(sub.planName).toBe("pro");
		expect(sub.interval).toBe("monthly");
		expect(sub.status).toBe("active");
		expect(sub.userId).toBe(ctx.testUser.id);
		expect(sub.variantId).toBe(env.LEMONSQUEEZY_PRO_MONTHLY_VARIANT_ID);
		expect(sub.productId).toBe(env.LEMONSQUEEZY_PRO_PRODUCT_ID);
	});

	it("3.6 — Duplicate checkout is blocked for same plan", async () => {
		expect(ctx.testUser.sessionToken).toBeTruthy();

		const { status, data } = await apiCall("/lemonsqueezy/subscription/create", {
			method: "POST",
			body: { plan: "pro", interval: "monthly" },
			sessionToken: ctx.testUser.sessionToken,
		});

		expect(status).toBe(400);
		expect(data.code).toBe("already_subscribed");
	});

	it("3.7 — Create and complete checkout (annual max)", async () => {
		expect(ctx.testUser.sessionToken).toBeTruthy();

		const { status, data } = await apiCall("/lemonsqueezy/subscription/create", {
			method: "POST",
			body: { plan: "max", interval: "annual" },
			sessionToken: ctx.testUser.sessionToken,
		});

		expect(status).toBe(200);
		expect(data.url).toBeTruthy();

		const url = new URL(data.url);
		expect(url.hostname).toContain("lemonsqueezy");

		await completeCheckout(browser, data.url, {
			email: ctx.testUser.email,
			cardNumber: "4242424242424242",
			expiry: "12/30",
			cvc: "123",
			name: "E2E Test User",
			screenshotName: "checkout-max-annual-failure",
		});
	});

	it("3.8 — Webhook creates second subscription (max annual)", async () => {
		const db = new Database(DB_PATH, { readonly: true });
		try {
			const row = await poll(
				async () => {
					return db
						.prepare("SELECT * FROM lsSubscription WHERE userId = ? AND planName = ?")
						.get(ctx.testUser.id, "max") as Record<string, unknown> | undefined;
				},
				{ timeoutMs: 30_000, intervalMs: 1_000, label: "max subscription in DB" },
			);

			expect(row).toBeTruthy();
			expect(row.status).toBe("active");
			expect(row.planName).toBe("max");
			expect(row.interval).toBe("annual");
			expect(row.lsSubscriptionId).toBeTruthy();
			expect(row.variantId).toBe(env.LEMONSQUEEZY_MAX_ANNUAL_VARIANT_ID);
			expect(row.productId).toBe(env.LEMONSQUEEZY_MAX_PRODUCT_ID);

			ctx.maxSubscriptionId = row.id as string;
			ctx.maxLsSubscriptionId = row.lsSubscriptionId as string;
		} finally {
			db.close();
		}
	});
});
