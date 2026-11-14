import { describe, expect, it } from "vitest";
import { FiloBook } from "../src/filobook/client";
import type { Order, Quote } from "../src/filobook/types";
import { reprice, runCron, type Deps } from "../src/quoter";
import type { Rules } from "../src/rules";
import { MemoryKV, NOW, apiError, fakeApi, order, quote, quoteOk, type Handler, type Reply } from "./helpers";

const undercut: Rules = { web_search: { price: "0.04", floor: "0.025", undercut: { step: "0.001" } } };

function setup(state: { orders: Order[]; quotes: Quote[] }, opts: { rules?: Rules; quoteReply?: Reply | Handler; limits?: Deps["limits"] } = {}) {
	const api = fakeApi({
		"GET /v1/feed": () => ({ body: { orders: state.orders, cursor: null } }),
		"GET /v1/me/quotes": () => ({ body: { quotes: state.quotes } }),
		"POST /v1/orders/:id/quotes": opts.quoteReply ?? quoteOk(),
	});
	const d: Deps = {
		client: new FiloBook({ apiKey: "fb_live_test", baseUrl: "https://filobook.test", fetch: api.fetch }),
		kv: new MemoryKV().asKV(),
		rules: opts.rules ?? undercut,
		limits: opts.limits,
		now: () => NOW,
		log: () => {},
	};
	return { api, d };
}

describe("reprice", () => {
	it("makes no API calls when no rule has undercut", async () => {
		const { api, d } = setup({ orders: [], quotes: [] }, { rules: { web_search: { price: "0.04", floor: "0.02" } } });
		await reprice(d);
		expect(api.calls).toHaveLength(0);
	});

	it("re-quotes best - step when someone is under your verified quote", async () => {
		const a = order({ best_quote: "0.035" });
		const { api, d } = setup({ orders: [a], quotes: [quote({ order_id: a.id, price: "0.04" })] });
		const r = await reprice(d);
		expect(api.quotes().map((q) => [q.path, q.body])).toEqual([[`/v1/orders/${a.id}/quotes`, { price: "0.034" }]]);
		expect(r.outcomes[0]).toMatchObject({ action: "quoted", price: "0.034" });
	});

	it("leaves orders alone when you are the best (or tied)", async () => {
		const a = order({ best_quote: "0.04" });
		const { api, d } = setup({ orders: [a], quotes: [quote({ order_id: a.id, price: "0.04" })] });
		await reprice(d);
		expect(api.quotes()).toHaveLength(0);
	});

	it("never goes below the floor", async () => {
		const a = order({ best_quote: "0.0255" });
		const { api, d } = setup({ orders: [a], quotes: [quote({ order_id: a.id, price: "0.03" })] });
		const r = await reprice(d);
		expect(api.quotes()).toHaveLength(0);
		expect(r.outcomes[0]).toMatchObject({ action: "skipped", reason: "below_floor" });
	});

	it("only follows your current quote, and only if it is verified", async () => {
		const a = order({ best_quote: "0.03" });
		const b = order({ best_quote: "0.03" });
		const c = order({ best_quote: "0.03" });
		const quotes = [
			quote({ order_id: a.id, price: "0.039", status: "failed" }), // newest for a: failed, so nothing to beat
			quote({ order_id: a.id, price: "0.04", status: "replaced" }),
			quote({ order_id: b.id, price: "0.04", status: "expired" }),
			quote({ order_id: c.id, price: null, status: "verified" }),
		];
		const { api, d } = setup({ orders: [a, b, c], quotes });
		await reprice(d);
		expect(api.quotes()).toHaveLength(0);
	});

	it("skips orders you never quoted, closed orders, and types without undercut", async () => {
		const notMine = order({ best_quote: "0.03" });
		const closed = order({ best_quote: "0.03", closes_at: new Date(NOW - 1).toISOString() });
		const other = order({ type: "scraping", best_quote: "0.03" });
		const quotes = [quote({ order_id: closed.id }), quote({ order_id: other.id })];
		const { api, d } = setup({ orders: [notMine, closed, other], quotes }, { rules: { ...undercut, scraping: { price: "0.04", floor: "0.01" } } });
		await reprice(d);
		expect(api.quotes()).toHaveLength(0);
	});

	it("re-quotes each order at most once per run", async () => {
		const a = order({ best_quote: "0.035" });
		const { api, d } = setup({ orders: [a, a], quotes: [quote({ order_id: a.id, price: "0.04" })] });
		await reprice(d);
		expect(api.quotes()).toHaveLength(1);
	});

	it("leaves out orders in the exclude set", async () => {
		const a = order({ best_quote: "0.035" });
		const { api, d } = setup({ orders: [a], quotes: [quote({ order_id: a.id, price: "0.04" })] });
		await reprice(d, new Set([a.id]));
		expect(api.quotes()).toHaveLength(0);
	});

	it("respects maxRepricesPerRun", async () => {
		const orders = [order({ best_quote: "0.035" }), order({ best_quote: "0.035" }), order({ best_quote: "0.035" })];
		const { api, d } = setup({ orders, quotes: orders.map((o) => quote({ order_id: o.id })) }, { limits: { maxQuotesPerRun: 20, maxRepricesPerRun: 2 } });
		const r = await reprice(d);
		expect(api.quotes()).toHaveLength(2);
		expect(r.stopped).toBe("limit");
	});

	it("handles requote_not_lower and order_not_open without crashing", async () => {
		const a = order({ best_quote: "0.035" });
		const b = order({ best_quote: "0.035" });
		const replies: Record<string, Reply> = { [a.id]: apiError(409, "requote_not_lower"), [b.id]: apiError(409, "order_not_open") };
		const { d } = setup({ orders: [a, b], quotes: [quote({ order_id: a.id }), quote({ order_id: b.id })] }, { quoteReply: (c) => replies[c.path.split("/")[3]] });
		const r = await reprice(d);
		expect(r.stopped).toBeNull();
		expect(r.outcomes.map((o) => o.action === "rejected" && o.code)).toEqual(["requote_not_lower", "order_not_open"]);
	});

	it("stops on rate_limited", async () => {
		const orders = [order({ best_quote: "0.035" }), order({ best_quote: "0.035" })];
		const { api, d } = setup({ orders, quotes: orders.map((o) => quote({ order_id: o.id })) }, { quoteReply: apiError(429, "rate_limited") });
		const r = await reprice(d);
		expect(r.stopped).toBe("rate_limited");
		expect(api.quotes()).toHaveLength(1);
	});

	it("settles instead of looping: once you are the best, the next run does nothing", async () => {
		const a = order({ best_quote: "0.035" });
		const state = { orders: [a], quotes: [quote({ order_id: a.id, price: "0.04" })] };
		const { api, d } = setup(state, {
			quoteReply: (call) => {
				const reply = quoteOk()(call) as { status: number; body: Quote };
				// FiloBook now shows our new quote as the best, and it is our newest quote.
				state.orders = [{ ...a, best_quote: reply.body.price }];
				state.quotes = [reply.body, ...state.quotes.map((q) => ({ ...q, status: "replaced" as const }))];
				return reply;
			},
		});
		await reprice(d);
		await reprice(d);
		await reprice(d);
		expect(api.quotes().map((q) => q.body)).toEqual([{ price: "0.034" }]);
	});

	it("walks down step by step against a competitor, then stops at the floor", async () => {
		const a = order({ best_quote: "0.03" });
		const state = { orders: [a], quotes: [quote({ order_id: a.id, price: "0.04" })] };
		const rules: Rules = { web_search: { price: "0.04", floor: "0.027", undercut: { step: "0.001" } } };
		const { api, d } = setup(state, {
			rules,
			quoteReply: (call) => {
				const reply = quoteOk()(call) as { status: number; body: Quote };
				state.quotes = [reply.body];
				// A competitor answers every move with one step lower.
				const next = Number(reply.body.price!.replace("0.", "")) - 1;
				state.orders = [{ ...a, best_quote: `0.0${next}` }];
				return reply;
			},
		});
		for (let i = 0; i < 10; i++) await reprice(d);
		expect(api.quotes().map((q) => (q.body as { price: string }).price)).toEqual(["0.029", "0.027"]);
	});
});

describe("runCron", () => {
	it("does not reprice an order it just quoted in the same run", async () => {
		const a = order({ best_quote: "0.03" });
		const api = fakeApi({
			"GET /v1/feed": (c) => ({ body: { orders: [a], cursor: c.query.get("since") ? null : "c1" } }),
			"GET /v1/me/quotes": { body: { quotes: [quote({ order_id: a.id, price: "0.029" })] } },
			"POST /v1/orders/:id/quotes": quoteOk(),
		});
		const d: Deps = { client: new FiloBook({ apiKey: "k", baseUrl: "https://filobook.test", fetch: api.fetch }), kv: new MemoryKV().asKV(), rules: undercut, now: () => NOW, log: () => {} };
		const r = await runCron(d);
		expect(api.quotes().map((q) => q.body)).toEqual([{ price: "0.029" }]);
		expect(r.reprice?.outcomes).toEqual([]);
	});

	it("never throws", async () => {
		const d: Deps = { client: { feed: () => Promise.reject(new Error("boom")), quote: () => Promise.reject(new Error("boom")), myQuotes: () => Promise.reject(new Error("boom")) }, kv: new MemoryKV().asKV(), rules: undercut, now: () => NOW, log: () => {} };
		await expect(runCron(d)).resolves.toBeDefined();
	});
});
