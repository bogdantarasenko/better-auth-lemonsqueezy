export interface E2EContext {
	// Server
	serverUrl: string;
	tunnelUrl: string;

	// Auth
	testUser: { id: string; email: string; sessionToken: string };
	secondUser: { id: string; email: string; sessionToken: string };

	// Lemon Squeezy IDs (populated during test runs)
	lsCustomerId?: string;
	proSubscriptionId?: string;
	proLsSubscriptionId?: string;
	enterpriseSubscriptionId?: string;
	enterpriseLsSubscriptionId?: string;
	orderId?: string;
}

/**
 * Shared mutable context passed between sequential test suites.
 * Populated by global-setup and enriched by each test suite.
 */
export const ctx: E2EContext = {
	serverUrl: "",
	tunnelUrl: "",
	testUser: { id: "", email: "", sessionToken: "" },
	secondUser: { id: "", email: "", sessionToken: "" },
};
