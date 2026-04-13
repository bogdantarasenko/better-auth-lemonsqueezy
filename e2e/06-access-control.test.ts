import Database from "better-sqlite3";
import { describe, it, expect, inject, beforeAll } from "vitest";
import { createAccessControlHelpers } from "../src/access-control";
import { ctx } from "./fixtures/context";

const DB_PATH = "e2e/test.db";

/**
 * Minimal adapter wrapping better-sqlite3 for access control helpers.
 * Only implements findMany on lsSubscription (all that's needed).
 */
function createSqliteAdapter(dbPath: string) {
	const db = new Database(dbPath, { readonly: true });

	return {
		findMany(opts: {
			model: string;
			where: Array<{ field: string; value: string }>;
		}): Promise<Array<Record<string, unknown>>> {
			const table = opts.model;
			const conditions = opts.where
				.map((w) => `${w.field} = ?`)
				.join(" AND ");
			const values = opts.where.map((w) => w.value);
			const rows = db.prepare(`SELECT * FROM ${table} WHERE ${conditions}`).all(...values);
			return Promise.resolve(rows as Array<Record<string, unknown>>);
		},
	};
}

describe("Suite 6: Access Control", () => {
	let helpers: ReturnType<typeof createAccessControlHelpers>;

	beforeAll(async () => {
		ctx.serverUrl = inject("serverUrl");
		ctx.tunnelUrl = inject("tunnelUrl");

		const adapter = createSqliteAdapter(DB_PATH);
		helpers = createAccessControlHelpers(adapter);
	});

	it("6.1 — hasActiveSubscription returns true for user with active subscription", async () => {
		// testUser created subscriptions in Suite 3 (pro + max)
		const result = await helpers.hasActiveSubscription(ctx.testUser.id);
		expect(result).toBe(true);
	});

	it("6.2 — hasActiveSubscription returns false for user with no subscription", async () => {
		// Use a non-existent user ID — no subscriptions exist for this user
		const result = await helpers.hasActiveSubscription("non-existent-user-id");
		expect(result).toBe(false);
	});

	it("6.3 — hasActivePlan matches correct plan", async () => {
		const result = await helpers.hasActivePlan(ctx.testUser.id, "pro");
		expect(result).toBe(true);
	});

	it("6.4 — hasActivePlan rejects wrong plan", async () => {
		const result = await helpers.hasActivePlan(ctx.testUser.id, "starter");
		expect(result).toBe(false);
	});

	it("6.5 — requirePlan returns allowed with subscription when plan matches", async () => {
		const result = await helpers.requirePlan(ctx.testUser.id, "pro");
		expect(result.allowed).toBe(true);
		expect(result.subscription).toBeDefined();
		expect(result.subscription!.planName).toBe("pro");
		expect(result.subscription!.userId).toBe(ctx.testUser.id);
	});

	it("6.6 — requirePlan returns denied for non-subscribed user", async () => {
		const result = await helpers.requirePlan("non-existent-user-id", "pro");
		expect(result.allowed).toBe(false);
		expect(result.subscription).toBeUndefined();
	});
});
