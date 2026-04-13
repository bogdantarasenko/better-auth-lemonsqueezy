import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["e2e/**/*.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 60_000,
		sequence: {
			concurrent: false,
		},
		globalSetup: ["e2e/global-setup.ts"],
		poolOptions: {
			forks: { singleFork: true },
		},
	},
});
