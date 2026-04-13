import { createServer, type Server } from "node:http";
import { betterAuth } from "better-auth";
import Database from "better-sqlite3";
import { lemonSqueezy } from "../../src/index";
import { getEnv } from "./env";

let server: Server | null = null;
let db: InstanceType<typeof Database> | null = null;

const DB_PATH = "e2e/test.db";

/**
 * Start the Better Auth test server with the lemonSqueezy plugin
 * configured against real LS test-mode credentials.
 */
export async function startServer(tunnelUrl: string): Promise<string> {
	const env = getEnv();

	// Fresh database each run
	const fs = await import("node:fs");
	if (fs.existsSync(DB_PATH)) {
		fs.unlinkSync(DB_PATH);
	}

	db = new Database(DB_PATH);

	const auth = betterAuth({
		database: {
			type: "sqlite",
			url: DB_PATH,
		},
		baseURL: "http://localhost:4738",
		emailAndPassword: {
			enabled: true,
		},
		plugins: [
			lemonSqueezy({
				apiKey: env.LEMONSQUEEZY_API_KEY,
				storeId: env.LEMONSQUEEZY_STORE_ID,
				webhookSigningSecret: env.LEMONSQUEEZY_WEBHOOK_SIGNING_SECRET,
				createCustomerOnSignUp: true,
				defaultSuccessUrl: `${tunnelUrl}/success`,
				defaultCancelUrl: `${tunnelUrl}/cancel`,
				usageEndpoint: true,
				subscription: {
					enabled: true,
					plans: [
						{
							name: "pro",
							productId: env.LEMONSQUEEZY_PRO_PRODUCT_ID,
							intervals: {
								monthly: env.LEMONSQUEEZY_PRO_MONTHLY_VARIANT_ID,
								annual: env.LEMONSQUEEZY_PRO_ANNUAL_VARIANT_ID,
							},
						},
						{
							name: "max",
							productId: env.LEMONSQUEEZY_MAX_PRODUCT_ID,
							intervals: {
								monthly: env.LEMONSQUEEZY_MAX_MONTHLY_VARIANT_ID,
								annual: env.LEMONSQUEEZY_MAX_ANNUAL_VARIANT_ID,
							},
						},
					],
				},
			}),
		],
	});

	return new Promise<string>((resolve, reject) => {
		server = createServer(async (req, res) => {
			// Health check endpoint
			if (req.url === "/health") {
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.end("ok");
				return;
			}

			// Success/cancel page stubs
			if (req.url === "/success" || req.url === "/cancel") {
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.end(req.url.slice(1));
				return;
			}

			// Convert Node request to Web Request for Better Auth
			const url = new URL(req.url || "/", "http://localhost:4738");
			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers)) {
				if (value) headers.set(key, Array.isArray(value) ? value[0] : value);
			}

			const body = await new Promise<string>((res) => {
				let data = "";
				req.on("data", (chunk) => (data += chunk));
				req.on("end", () => res(data));
			});

			const webRequest = new Request(url.toString(), {
				method: req.method,
				headers,
				body: ["GET", "HEAD"].includes(req.method || "GET") ? undefined : body,
			});

			try {
				const response = await auth.handler(webRequest);
				res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
				const responseBody = await response.text();
				res.end(responseBody);
			} catch (err) {
				console.error("[e2e server] Handler error:", err);
				res.writeHead(500);
				res.end("Internal Server Error");
			}
		});

		server.listen(4738, () => {
			console.log("[e2e] Test server listening on http://localhost:4738");
			resolve("http://localhost:4738");
		});

		server.on("error", reject);
	});
}

/**
 * Stop the test server and close the database.
 */
export async function stopServer(): Promise<void> {
	if (server) {
		await new Promise<void>((resolve) => {
			server!.close(() => resolve());
		});
		server = null;
	}
	if (db) {
		db.close();
		db = null;
	}
}
