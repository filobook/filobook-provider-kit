import { describe, expect, it } from "vitest";
import { createProvider, type ProviderConfig } from "../src/provider";
import { TestStore, fakeApi } from "./helpers";

const routes = { "GET /v1/feed": { body: { orders: [], cursor: null } }, "GET /v1/me/quotes": { body: { quotes: [] } } };

function setup(extra: Partial<ProviderConfig> = {}) {
	const api = fakeApi(routes);
	const provider = createProvider({ apiKey: "fb_live_test", baseUrl: "https://filobook.test", store: new TestStore(), fetch: api.fetch, log: () => {}, ...extra });
	return { api, provider };
}

const tick = (auth?: string, method = "POST") => new Request("https://kit.test/tick", { method, headers: auth ? { authorization: auth } : {} });

describe("/tick", () => {
	it("is off (404) when no tickSecret is set", async () => {
		const { provider, api } = setup();
		expect((await provider.fetch(tick("Bearer anything"))).status).toBe(404);
		expect(api.calls).toHaveLength(0);
	});

	it("needs the right bearer token", async () => {
		const { provider, api } = setup({ tickSecret: "s3cret" });
		expect((await provider.fetch(tick())).status).toBe(401);
		expect((await provider.fetch(tick("Bearer wrong!"))).status).toBe(401);
		expect(api.calls).toHaveLength(0);
	});

	it("runs a tick and returns a summary (GET or POST)", async () => {
		const { provider, api } = setup({ tickSecret: "s3cret" });
		for (const method of ["POST", "GET"]) {
			const res = await provider.fetch(tick("Bearer s3cret", method));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { ok: boolean; poll: { quoted: number } };
			expect(body.ok).toBe(true);
			expect(body.poll.quoted).toBe(0);
		}
		expect(api.calls.filter((c) => c.path === "/v1/feed").length).toBeGreaterThanOrEqual(2);
	});

	it("answers 503 without an API key", async () => {
		const { provider } = setup({ tickSecret: "s3cret", apiKey: undefined });
		expect((await provider.fetch(tick("Bearer s3cret"))).status).toBe(503);
	});

	it("rejects other methods", async () => {
		const { provider } = setup({ tickSecret: "s3cret" });
		expect((await provider.fetch(tick("Bearer s3cret", "DELETE"))).status).toBe(405);
	});
});
