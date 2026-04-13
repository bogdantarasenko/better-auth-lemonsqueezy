import { describe, it, expect, inject, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { getEnv } from "./fixtures/env";
import { ctx } from "./fixtures/context";
import { getAuthClient } from "./helpers/auth-client";
import { poll } from "./helpers/poll";

const LS_API_BASE = "https://api.lemonsqueezy.com/v1";
const DB_PATH = "e2e/test.db";
const TEST_EMAIL = `e2e-customer-${Date.now()}@test.example`;
const TEST_PASSWORD = "TestPassword123!";
const TEST_NAME = "E2E Test User";

function lsApi(path: string, apiKey: string) {
	return fetch(`${LS_API_BASE}${path}`, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/vnd.api+json",
		},
	});
}

describe("Suite 2: Customer Lifecycle", () => {
	const env = getEnv();
	let userId: string;
	let sessionToken: string;
	let lsCustomerId: string;

	beforeAll(() => {
		ctx.serverUrl = inject("serverUrl");
		ctx.tunnelUrl = inject("tunnelUrl");
	});

	it("2.1 — Sign up creates LS customer", async () => {
		const client = getAuthClient();

		// Sign up a new user
		const signUpRes = await client.signUp.email({
			email: TEST_EMAIL,
			password: TEST_PASSWORD,
			name: TEST_NAME,
		});

		expect(signUpRes.data).toBeTruthy();
		userId = signUpRes.data!.user.id;
		expect(userId).toBeTruthy();

		// Extract session token from the response
		sessionToken = signUpRes.data!.session.token;
		expect(sessionToken).toBeTruthy();

		// Poll the local DB for the lsCustomer record
		// (created asynchronously in the database hook after user creation)
		const db = new Database(DB_PATH, { readonly: true });
		try {
			const row = await poll(
				async () => {
					return db
						.prepare("SELECT * FROM lsCustomer WHERE userId = ?")
						.get(userId) as
						| { userId: string; lsCustomerId: string; email: string }
						| undefined;
				},
				{ timeoutMs: 15_000, intervalMs: 500, label: "lsCustomer in DB" },
			);

			expect(row).toBeTruthy();
			expect(row.lsCustomerId).toBeTruthy();
			expect(row.email).toBe(TEST_EMAIL);
			lsCustomerId = row.lsCustomerId;
		} finally {
			db.close();
		}

		// Verify customer exists in Lemon Squeezy API
		const lsRes = await lsApi(
			`/customers/${lsCustomerId}`,
			env.E2E_LS_API_KEY,
		);
		expect(lsRes.status).toBe(200);

		const lsBody = await lsRes.json();
		expect(lsBody.data.id).toBe(lsCustomerId);

		// Populate shared context for downstream test suites
		ctx.testUser = { id: userId, email: TEST_EMAIL, sessionToken };
		ctx.lsCustomerId = lsCustomerId;
	});

	it("2.2 — Customer data matches between local DB and LS API", async () => {
		expect(lsCustomerId).toBeTruthy();

		// Read local DB record
		const db = new Database(DB_PATH, { readonly: true });
		let localRow: {
			userId: string;
			lsCustomerId: string;
			email: string;
		};
		try {
			localRow = db
				.prepare("SELECT * FROM lsCustomer WHERE lsCustomerId = ?")
				.get(lsCustomerId) as typeof localRow;
		} finally {
			db.close();
		}

		expect(localRow).toBeTruthy();
		expect(localRow.userId).toBe(userId);
		expect(localRow.email).toBe(TEST_EMAIL);

		// Verify LS API customer attributes match
		const lsRes = await lsApi(
			`/customers/${lsCustomerId}`,
			env.E2E_LS_API_KEY,
		);
		expect(lsRes.status).toBe(200);

		const lsBody = await lsRes.json();
		const attrs = lsBody.data.attributes;
		expect(attrs.email).toBe(TEST_EMAIL);
		expect(attrs.name).toBe(TEST_NAME);
		expect(lsBody.data.attributes.store_id).toBe(
			Number(env.E2E_LS_STORE_ID),
		);
	});

	it("2.3 — Duplicate sign-up is idempotent (unique constraint prevents duplicates)", async () => {
		expect(userId).toBeTruthy();
		expect(lsCustomerId).toBeTruthy();

		// Attempt to sign up with the same email — should fail or return existing user
		const client = getAuthClient();
		const duplicateRes = await client.signUp.email({
			email: TEST_EMAIL,
			password: TEST_PASSWORD,
			name: TEST_NAME,
		});

		// Better Auth should reject duplicate email sign-ups
		// Either it errors or returns the existing user — either way, no duplicate lsCustomer
		const db = new Database(DB_PATH, { readonly: true });
		try {
			const rows = db
				.prepare("SELECT * FROM lsCustomer WHERE email = ?")
				.all(TEST_EMAIL) as Array<{
				userId: string;
				lsCustomerId: string;
				email: string;
			}>;

			// There should be exactly one lsCustomer record for this email
			expect(rows).toHaveLength(1);
			expect(rows[0].lsCustomerId).toBe(lsCustomerId);
			expect(rows[0].userId).toBe(userId);
		} finally {
			db.close();
		}
	});
});
