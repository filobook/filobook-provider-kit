import { defineConfig } from "vitest/config";

// Tests run in plain Node with a mocked fetch and an in-memory KV. No wrangler or network needed.
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
	},
});
