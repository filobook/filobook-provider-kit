import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FiloBook } from "../src/filobook/client";
import { createProvider } from "../src/provider";
import { pollFeed, type Deps } from "../src/quoter";
import type { Rules } from "../src/rules";
import { CURSOR_KEY, quotedKey } from "../src/store";
import { TestStore, NOW, apiError, fakeApi, order, quoteOk, type Handler, type Reply } from "./helpers";

const rules: Rules = { web_search: { price: "0.04", floor: "0.025" } };
const noLog = () => {};

function deps(routes: Record<string, Reply | Handler>, extra: Partial<Deps> = {}) {
	const api = fakeApi(routes);
	const kv = new TestStore();
	const d: Deps = { client: new FiloBook({ apiKey: "fb_live_test", baseUrl: "https://filobook.test", fetch: api.fetch }), store: kv, rules, now: () => NOW, log: noLog, ...extra };
	return { api, kv, d };
}

beforeEach(() => {
	vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("provider.tick()", () => {
	const feedRoutes = (a: ReturnType<typeof order>) => ({
		"GET /v1/feed": ((c) => (c.query.get("since") ? { body: { orders: [], cursor: c.query.get("since") } } : { body: { orders: [a], cursor: "2026-11-14T11:59:55.000Z" } })) as Handler,
		"GET /v1/me/quotes": { body: { quotes: [] } },
		"POST /v1/orders/:id/quotes": quoteOk(),
	});

	it("polls the feed, quotes, and saves the cursor", async () => {
		const api = fakeApi(feedRoutes(order()));
		const kv = new TestStore();
		const provider = createProvider({ apiKey: "fb_live_test", baseUrl: "https://filobook.test", store: kv, fetch: api.fetch, log: noLog });

		await provider.tick();
		const feeds = api.calls.filter((c) => c.path === "/v1/feed");
		expect(feeds[0].query.has("since")).toBe(false);
		expect(api.quotes()).toHaveLength(1);
		expect(await kv.get(CURSOR_KEY)).toBe("2026-11-14T11:59:55.000Z");

		await provider.tick();
		const feeds2 = api.calls.filter((c) => c.path === "/v1/feed");
		expect(feeds2.at(-1)!.query.get("since")).toBe("2026-11-14T11:59:55.000Z");
		expect(api.quotes()).toHaveLength(1);
	});

	it("does nothing without an API key", async () => {
		const api = fakeApi({});
		const provider = createProvider({ store: new TestStore(), fetch: api.fetch, log: noLog });
		expect(await provider.tick()).toBeNull();
		expect(api.calls).toHaveLength(0);
	});

	it("skips a tick while the previous one is still running", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const api = fakeApi({
			"GET /v1/feed": async () => {
				await gate;
				return { body: { orders: [], cursor: null } };
			},
			"GET /v1/me/quotes": { body: { quotes: [] } },
		});
		const provider = createProvider({ apiKey: "fb_live_test", baseUrl: "https://filobook.test", store: new TestStore(), fetch: api.fetch, log: noLog });
		const first = provider.tick();
		expect(await provider.tick()).toBeNull();
		release();
		expect(await first).not.toBeNull();
		expect(await provider.tick()).not.toBeNull();
	});
});

describe("pollFeed", () => {
	it("skips orders already quoted (for example by the webhook)", async () => {
		const a = order();
		const b = order();
		const { api, kv, d } = deps({ "GET /v1/feed": { body: { orders: [a, b], cursor: "c1" } }, "POST /v1/orders/:id/quotes": quoteOk() });
		await kv.put(quotedKey(a.id), "0.04", { ttlSeconds: 600 });
		const r = await pollFeed(d);
		expect(api.quotes().map((c) => c.path)).toEqual([`/v1/orders/${b.id}/quotes`]);
		expect(r.outcomes[0]).toEqual({ order_id: a.id, action: "skipped", reason: "already_quoted" });
	});

	it("marks orders with a TTL that outlives the order", async () => {
		const a = order({ closes_at: new Date(NOW + 120_000).toISOString() });
		const { kv, d } = deps({ "GET /v1/feed": { body: { orders: [a], cursor: "c1" } }, "POST /v1/orders/:id/quotes": quoteOk() });
		await pollFeed(d);
		expect(kv.store.get(quotedKey(a.id))).toEqual({ value: "0.04", ttl: 120 + 600 });
	});

	it("handles final API errors without crashing and moves the cursor on", async () => {
		const [a, b, c, e] = [order(), order(), order(), order()];
		const codes: Record<string, Reply> = {
			[a.id]: apiError(409, "requote_not_lower"),
			[b.id]: apiError(409, "order_not_open"),
			[c.id]: apiError(403, "not_eligible"),
			[e.id]: apiError(403, "own_order"),
		};
		const { kv, d } = deps({ "GET /v1/feed": { body: { orders: [a, b, c, e], cursor: "c1" } }, "POST /v1/orders/:id/quotes": (call) => codes[call.path.split("/")[3]] });
		const r = await pollFeed(d);
		expect(r.stopped).toBeNull();
		expect(r.outcomes.map((o) => (o.action === "rejected" ? o.code : o.action))).toEqual(["requote_not_lower", "order_not_open", "not_eligible", "own_order"]);
		expect(await kv.get(CURSOR_KEY)).toBe("c1");
		expect(await kv.get(quotedKey(b.id))).toBe("order_not_open");
	});

	it("stops on rate_limited and keeps the old cursor so the rest is retried", async () => {
		const [a, b, c] = [order(), order(), order()];
		let n = 0;
		const { api, kv, d } = deps({
			"GET /v1/feed": { body: { orders: [a, b, c], cursor: "c2" } },
			"POST /v1/orders/:id/quotes": (call) => (++n === 2 ? apiError(429, "rate_limited") : quoteOk()(call)),
		});
		await kv.put(CURSOR_KEY, "c1");
		const r = await pollFeed(d);
		expect(r.stopped).toBe("rate_limited");
		expect(api.quotes()).toHaveLength(2);
		expect(await kv.get(CURSOR_KEY)).toBe("c1");
		expect(await kv.get(quotedKey(b.id))).toBeNull();

		// Next run: a is skipped, b and c are quoted, cursor moves.
		const r2 = await pollFeed(d);
		expect(r2.stopped).toBeNull();
		expect(api.quotes().slice(2).map((q) => q.path)).toEqual([`/v1/orders/${b.id}/quotes`, `/v1/orders/${c.id}/quotes`]);
		expect(api.calls.filter((q) => q.path === "/v1/feed").at(-1)!.query.get("since")).toBe("c1");
		expect(await kv.get(CURSOR_KEY)).toBe("c2");
	});

	it("keeps going past a 5xx on one order but does not move the cursor", async () => {
		const [a, b] = [order(), order()];
		let fail = true;
		const { api, kv, d } = deps({
			"GET /v1/feed": { body: { orders: [a, b], cursor: "c2" } },
			"POST /v1/orders/:id/quotes": (call) => (call.path.includes(a.id) && fail ? apiError(500, "internal") : quoteOk()(call)),
		});
		const r = await pollFeed(d);
		expect(r.outcomes.map((o) => o.action)).toEqual(["error", "quoted"]);
		expect(r.incomplete).toBe(true);
		expect(await kv.get(CURSOR_KEY)).toBeNull();

		fail = false;
		await pollFeed(d);
		expect(api.quotes().map((q) => q.path)).toEqual([`/v1/orders/${a.id}/quotes`, `/v1/orders/${b.id}/quotes`, `/v1/orders/${a.id}/quotes`]);
		expect(await kv.get(CURSOR_KEY)).toBe("c2");
	});

	it("treats a network failure like a 5xx", async () => {
		const a = order();
		const { kv, d } = deps({ "GET /v1/feed": { body: { orders: [a], cursor: "c2" } } });
		const client = d.client as FiloBook;
		const failing = { ...d, client: { feed: client.feed.bind(client), myQuotes: client.myQuotes.bind(client), quote: () => Promise.reject(new TypeError("fetch failed")) } };
		const r = await pollFeed(failing);
		expect(r.outcomes).toEqual([{ order_id: a.id, action: "error", code: "network" }]);
		expect(await kv.get(CURSOR_KEY)).toBeNull();
	});

	it("stops on an auth problem", async () => {
		const [a, b] = [order(), order()];
		const { api, d } = deps({ "GET /v1/feed": { body: { orders: [a, b], cursor: "c2" } }, "POST /v1/orders/:id/quotes": apiError(403, "provider_required") });
		const r = await pollFeed(d);
		expect(r.stopped).toBe("auth");
		expect(api.quotes()).toHaveLength(1);
	});

	it("survives a feed error", async () => {
		const { kv, d } = deps({ "GET /v1/feed": apiError(503, "unavailable") });
		const r = await pollFeed(d);
		expect(r.stopped).toBe("error");
		expect(kv.puts).toHaveLength(0);
	});

	it("respects maxQuotesPerRun", async () => {
		const orders = [order(), order(), order()];
		const { api, kv, d } = deps({ "GET /v1/feed": { body: { orders, cursor: "c2" } }, "POST /v1/orders/:id/quotes": quoteOk() }, { limits: { maxQuotesPerRun: 2, maxRepricesPerRun: 10 } });
		const r = await pollFeed(d);
		expect(r.stopped).toBe("limit");
		expect(api.quotes()).toHaveLength(2);
		expect(await kv.get(CURSOR_KEY)).toBeNull();
		await pollFeed(d);
		expect(api.quotes()).toHaveLength(3);
		expect(await kv.get(CURSOR_KEY)).toBe("c2");
	});

	it("skips closed orders and does not rewrite an unchanged cursor", async () => {
		const closed = order({ closes_at: new Date(NOW - 1).toISOString() });
		const filled = order({ status: "filled" });
		const { api, kv, d } = deps({ "GET /v1/feed": { body: { orders: [closed, filled], cursor: "c1" } } });
		await kv.put(CURSOR_KEY, "c1");
		kv.puts = [];
		const r = await pollFeed(d);
		expect(r.outcomes.map((o) => o.action === "skipped" && o.reason)).toEqual(["not_open", "not_open"]);
		expect(api.quotes()).toHaveLength(0);
		expect(kv.puts).toHaveLength(0);
	});

	it("sends ttl_s and private from the rule", async () => {
		const a = order();
		const { api, d } = deps({ "GET /v1/feed": { body: { orders: [a], cursor: "c1" } }, "POST /v1/orders/:id/quotes": quoteOk() }, { rules: { web_search: { price: "0.04", floor: "0.03", ttl_s: 120, private: true } } });
		await pollFeed(d);
		expect(api.quotes()[0].body).toEqual({ price: "0.04", ttl_s: 120, private: true });
	});

	it("records quotes that failed verification", async () => {
		const a = order();
		const { kv, d } = deps({
			"GET /v1/feed": { body: { orders: [a], cursor: "c1" } },
			"POST /v1/orders/:id/quotes": (call) => {
				const r = quoteOk("failed")(call) as Reply;
				(r.body as { verification: unknown }).verification = { checks: [{ name: "endpoint_reachable", ok: false, detail: "No response within 3 s" }] };
				return r;
			},
		});
		const r = await pollFeed(d);
		expect(r.outcomes[0]).toMatchObject({ action: "quoted", status: "failed", failed_checks: ["endpoint_reachable: No response within 3 s"] });
		expect(await kv.get(quotedKey(a.id))).toBe("0.04");
	});
});
