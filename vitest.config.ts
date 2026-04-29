import { defineConfig } from "vitest/config";
import { resolve } from "path";

const integration = process.env.VITEST_INTEGRATION === "1";

export default defineConfig({
	resolve: {
		alias: {
			obsidian: resolve(__dirname, "tests/obsidian-mock.ts"),
		},
	},
	test: {
		environment: "node",
		include: integration ? ["tests/integration/**/*.test.ts"] : ["tests/*.{test,spec}.ts"],
		exclude: integration ? [] : ["tests/integration/**"],
	},
});
