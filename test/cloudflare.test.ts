import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signWebhook } from "../src/filobook/webhook";
import worker, { kvStore, type Env, type KVLike } from "../src/runtimes/cloudflare";
import { CURSOR_KEY, quotedKey } from "../src/store";
import { NOW, TestContext, fakeApi, order, quoteOk } from "./helpers";

/** A fake KV namespace that records the options passed to put. */
class FakeKV implements KVLike {
	data = new Map<string, { value: string; expirationTtl?: number }>();
	async get(key: string) {
		return this.data.get(key)?.value ?? null;
	}
	async put(key: string, value: string, opts?: { expirationTtl?: number }) {
		if (opts?.expirationTtl !== undefined && opts.expirationTtl < 60) throw new Error("KV expirationTtl must be at least 60");
		this.data.set(key, { value, expirationTtl: opts?.expirationTtl });
	}
}

const SECRET = "whsec_test_000000000000000000000000000000000000000000";

beforeEach(() => {
	vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("kvStore", () => {
	it("maps ttlSeconds to expirationTtl", async () => {
		const kv = new FakeKV();
		const store = kvStore(kv);
		await store.put("a", "1", { ttlSeconds: 120 });
		await store.put("b", "2");
		expect(kv.data.get("a")).toEqual({ value: "1", expirationTtl: 120 });
		expect(kv.data.get("b")).toEqual({ value: "2", expirationTtl: undefined });
		expect(await store.get("a")).toBe("1");
	});
});

describe("Cloudflare entry", () => {
	it("scheduled() runs a tick with state in KV", async () => {
		const api = fakeApi({
			"GET /v1/feed": { body: { orders: [order()], cursor: "c1" } },
			"GET /v1/me/quotes": { body: { quotes: [] } },
			"POST /v1/orders/:id/quotes": quoteOk(),
		});
		vi.stubGlobal("fetch", api.fetch);
		const kv = new FakeKV();
		const env: Env = { FILOBOOK_API_KEY: "fb_live_test", FILOBOOK_BASE_URL: "https://filobook.test", STATE: kv };
		const ctx = new TestContext();
		await worker.scheduled({}, env, ctx);
		await ctx.settle();
		expect(api.quotes()).toHaveLength(1);
		expect(await kv.get(CURSOR_KEY)).toBe("c1");
	});

	it("scheduled() does nothing without FILOBOOK_API_KEY", async () => {
		const api = fakeApi({});
		vi.stubGlobal("fetch", api.fetch);
		const ctx = new TestContext();
		await worker.scheduled({}, { STATE: new FakeKV() }, ctx);
		await ctx.settle();
		expect(api.calls).toHaveLength(0);
	});

	it("fetch() quotes a webhook delivery inside ctx.waitUntil", async () => {
		const api = fakeApi({ "POST /v1/orders/:id/quotes": quoteOk() });
		vi.stubGlobal("fetch", api.fetch);
		const kv = new FakeKV();
		const env: Env = { FILOBOOK_API_KEY: "fb_live_test", WEBHOOK_SECRET: SECRET, FILOBOOK_BASE_URL: "https://filobook.test", STATE: kv };
		const a = order();
		const raw = JSON.stringify({ event: "orders.created", sent_at: "x", orders: [a] });
		const ts = String(Math.floor(NOW / 1000));
		const req = new Request("https://kit.test/webhook", { method: "POST", headers: { "x-filobook-timestamp": ts, "x-filobook-signature": await signWebhook(SECRET, ts, raw) }, body: raw });
		const ctx = new TestContext();
		const res = await worker.fetch(req, env, ctx);
		expect(res.status).toBe(200);
		expect(ctx.promises).toHaveLength(1);
		await ctx.settle();
		expect(api.quotes()).toHaveLength(1);
		expect(kv.data.get(quotedKey(a.id))?.expirationTtl).toBeGreaterThanOrEqual(60);
	});
});
