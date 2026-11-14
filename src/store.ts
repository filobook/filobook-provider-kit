// What the kit remembers between runs. Any key-value store with expiring keys works: Cloudflare KV, a JSON
// file, Redis, Deno KV, a database table. Implement `Store` for yours (two methods) and pass it in.
//
//   feed:cursor        the cursor from the last fully processed GET /v1/feed?since= page
//   quoted:<order id>  set after we quote an order (or FiloBook says we never can), so the webhook and the tick
//                      do not quote it twice. It expires a while after the order closes.
//
// The store does not have to be strongly consistent. If the webhook and the tick race on the same order, the
// second quote at the same price is answered with 409 requote_not_lower, which the kit treats as "already quoted".

import type { Order } from "./filobook/types";

export interface Store {
	get(key: string): Promise<string | null>;
	/** `ttlSeconds`: forget the key after this many seconds. The kit never passes less than 60. */
	put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
}

/** Keeps everything in memory. Fine for tests and short runs; a restart forgets the cursor and the markers. */
export class MemoryStore implements Store {
	private readonly data = new Map<string, { value: string; expiresAt?: number }>();
	constructor(private readonly now: () => number = Date.now) {}
	async get(key: string): Promise<string | null> {
		const entry = this.data.get(key);
		if (!entry) return null;
		if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
			this.data.delete(key);
			return null;
		}
		return entry.value;
	}
	async put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void> {
		this.data.set(key, { value, expiresAt: opts?.ttlSeconds ? this.now() + opts.ttlSeconds * 1000 : undefined });
	}
}

export const CURSOR_KEY = "feed:cursor";
export const quotedKey = (orderId: string) => `quoted:${orderId}`;

/** Shortest marker TTL, in seconds. Also Cloudflare KV's smallest allowed expirationTtl. */
const MIN_TTL_S = 60;
/** How long to keep a marker after the order closes, in seconds. */
const AFTER_CLOSE_S = 600;
/** Used when closes_at cannot be read. */
const FALLBACK_TTL_S = 3600;

export function getCursor(store: Store): Promise<string | null> {
	return store.get(CURSOR_KEY);
}

export async function setCursor(store: Store, cursor: string): Promise<void> {
	await store.put(CURSOR_KEY, cursor);
}

export async function isQuoted(store: Store, orderId: string): Promise<boolean> {
	return (await store.get(quotedKey(orderId))) !== null;
}

/** Seconds until the marker for this order should expire. */
export function markerTtl(order: Pick<Order, "closes_at">, nowMs: number): number {
	const closes = Date.parse(order.closes_at);
	if (!Number.isFinite(closes)) return FALLBACK_TTL_S;
	return Math.max(MIN_TTL_S, Math.ceil((closes - nowMs) / 1000) + AFTER_CLOSE_S);
}

/** `value` is a short note for humans reading the store: the price we quoted, or the API's reason for refusing. */
export async function markQuoted(store: Store, order: Pick<Order, "id" | "closes_at">, value: string, nowMs: number): Promise<void> {
	await store.put(quotedKey(order.id), value, { ttlSeconds: markerTtl(order, nowMs) });
}
