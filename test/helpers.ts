// Test doubles: an in-memory store, a fake FiloBook API behind a mocked fetch, and a context that collects
// waitUntil promises.

import type { Order, Quote } from "../src/filobook/types";
import type { Store } from "../src/store";

/** An in-memory Store that records every put and, like Cloudflare KV, refuses TTLs under 60 seconds. */
export class TestStore implements Store {
	store = new Map<string, { value: string; ttl?: number }>();
	puts: { key: string; value: string; ttl?: number }[] = [];
	async get(key: string): Promise<string | null> {
		return this.store.get(key)?.value ?? null;
	}
	async put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void> {
		if (opts?.ttlSeconds !== undefined && opts.ttlSeconds < 60) throw new Error("ttlSeconds must be at least 60");
		this.store.set(key, { value, ttl: opts?.ttlSeconds });
		this.puts.push({ key, value, ttl: opts?.ttlSeconds });
	}
}

/** Collects the promises handed to waitUntil. */
export class TestContext {
	promises: Promise<unknown>[] = [];
	waitUntil = (p: Promise<unknown>) => {
		this.promises.push(p);
	};
	async settle() {
		await Promise.all(this.promises);
	}
}

export const NOW = Date.parse("2026-11-14T12:00:00.000Z");

let seq = 0;
export function order(over: Partial<Order> = {}): Order {
	seq++;
	return {
		id: `ord_${String(seq).padStart(16, "0")}`,
		agent: "0xagent",
		request: "Top 10 results for x402",
		type: "web_search",
		max_price: "0.05",
		rule: null,
		status: "open",
		quote_count: 0,
		best_quote: null,
		private_quotes: 0,
		conditions: null,
		batch_id: null,
		close_reason: null,
		created_at: new Date(NOW - 5_000).toISOString(),
		closes_at: new Date(NOW + 60_000).toISOString(),
		...over,
	};
}

export function quote(over: Partial<Quote> & { order_id: string }): Quote {
	return {
		id: `qt_${Math.random().toString(16).slice(2, 10)}`,
		provider_id: "prv_me",
		provider_name: "Me",
		price: "0.04",
		private: false,
		status: "verified",
		verification: { checks: [] },
		created_at: new Date(NOW - 1_000).toISOString(),
		expires_at: new Date(NOW + 59_000).toISOString(),
		...over,
	};
}

export type Call = { method: string; path: string; query: URLSearchParams; body: unknown; auth: string | null };
export type Reply = { status?: number; body: unknown };
export type Handler = (call: Call) => Reply | Promise<Reply>;

/**
 * A fake FiloBook. `routes` maps "METHOD /path" (path without query; ":id" matches one segment) to a reply or
 * a handler. Unknown routes answer 404 not_found. Every call is recorded in `calls`.
 */
export function fakeApi(routes: Record<string, Reply | Handler>) {
	const calls: Call[] = [];
	const patterns = Object.entries(routes).map(([key, reply]) => {
		const [method, path] = key.split(" ");
		const re = new RegExp(`^${path.replace(/:[a-z_]+/g, "[^/]+")}$`);
		return { method, re, reply };
	});
	const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = (init?.method ?? "GET").toUpperCase();
		const headers = new Headers(init?.headers);
		const call: Call = { method, path: url.pathname, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get("authorization") };
		calls.push(call);
		const match = patterns.find((p) => p.method === method && p.re.test(url.pathname));
		const reply = match ? (typeof match.reply === "function" ? await match.reply(call) : match.reply) : { status: 404, body: { error: "not_found", message: "Not found" } };
		return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
	};
	return { calls, fetch: fetchMock as typeof fetch, quotes: () => calls.filter((c) => c.method === "POST" && /\/quotes$/.test(c.path)) };
}

export const apiError = (status: number, error: string): Reply => ({ status, body: { error, message: error } });

/** A successful quote reply echoing the posted price. */
export const quoteOk =
	(status: Quote["status"] = "verified"): Handler =>
	(call) => {
		const orderId = call.path.split("/")[3];
		const price = (call.body as { price: string }).price;
		return { status: 201, body: quote({ order_id: orderId, price, status }) };
	};
