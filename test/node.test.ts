import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signWebhook } from "../src/filobook/webhook";
import { createProvider } from "../src/provider";
import { FileStore } from "../src/runtimes/file-store";
import { serve } from "../src/runtimes/node";
import { MemoryStore } from "../src/store";
import { fakeApi, order, quoteOk } from "./helpers";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "filobook-kit-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("MemoryStore", () => {
	it("expires keys after ttlSeconds", async () => {
		let now = 1_000_000;
		const s = new MemoryStore(() => now);
		await s.put("a", "1", { ttlSeconds: 60 });
		await s.put("b", "2");
		expect(await s.get("a")).toBe("1");
		now += 60_000;
		expect(await s.get("a")).toBeNull();
		expect(await s.get("b")).toBe("2");
	});
});

describe("FileStore", () => {
	it("persists across instances, expires keys, and writes the file with mode 600", async () => {
		let now = 1_000_000;
		const path = join(dir, "nested", "state.json");
		const a = new FileStore(path, () => now);
		await Promise.all([a.put("feed:cursor", "c1"), a.put("quoted:x", "0.04", { ttlSeconds: 60 }), a.put("quoted:y", "0.05", { ttlSeconds: 600 })]);

		const b = new FileStore(path, () => now);
		expect(await b.get("feed:cursor")).toBe("c1");
		expect(await b.get("quoted:x")).toBe("0.04");
		expect((await stat(path)).mode & 0o777).toBe(0o600);

		now += 61_000;
		expect(await b.get("quoted:x")).toBeNull();
		await b.put("feed:cursor", "c2");
		const raw = JSON.parse(await readFile(path, "utf8"));
		expect(Object.keys(raw).sort()).toEqual(["feed:cursor", "quoted:y"]);
	});

	it("starts empty when the file does not exist", async () => {
		expect(await new FileStore(join(dir, "missing.json")).get("feed:cursor")).toBeNull();
	});
});

describe("serve (node:http)", () => {
	it("serves /health and quotes a signed webhook", async () => {
		const secret = "whsec_test_000000000000000000000000000000000000000000";
		const api = fakeApi({ "POST /v1/orders/:id/quotes": quoteOk() });
		const store = new MemoryStore();
		const provider = createProvider({ apiKey: "fb_live_test", webhookSecret: secret, baseUrl: "https://filobook.test", store, fetch: api.fetch, log: () => {} });
		const server = await serve(provider, { port: 0, host: "127.0.0.1", tickIntervalS: 0, log: () => {} });
		try {
			const health = await fetch(`${server.url}/health`);
			expect(health.status).toBe(200);
			expect(await health.json()).toEqual({ ok: true });

			const a = order({ closes_at: new Date(Date.now() + 60_000).toISOString() });
			const raw = JSON.stringify({ event: "orders.created", sent_at: "x", orders: [a] });
			const ts = String(Math.floor(Date.now() / 1000));
			const res = await fetch(`${server.url}/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-filobook-timestamp": ts, "x-filobook-signature": await signWebhook(secret, ts, raw) }, body: raw });
			expect(res.status).toBe(200);
			for (let i = 0; i < 50 && api.quotes().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
			expect(api.quotes()).toHaveLength(1);

			const bad = await fetch(`${server.url}/webhook`, { method: "POST", headers: { "x-filobook-timestamp": ts, "x-filobook-signature": `sha256=${"0".repeat(64)}` }, body: raw });
			expect(bad.status).toBe(401);

			const big = await fetch(`${server.url}/webhook`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
			expect(big.status).toBe(413);
		} finally {
			await server.close();
		}
	});
});
