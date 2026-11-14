// What the Worker remembers between runs, in the KV namespace bound as STATE.
//
//   feed:cursor        the cursor from the last fully processed GET /v1/feed?since= page
//   quoted:<order id>  set after we quote an order (or FiloBook says we never can), so the webhook and the cron
//                      do not quote it twice. It expires a while after the order closes.
//
// KV is eventually consistent, so the webhook and the cron can still race on the same order now and then.
// That is harmless: a second quote at the same price is answered with 409 requote_not_lower, which the kit
// treats as "already quoted".

import type { Order } from "./filobook/types";

export const CURSOR_KEY = "feed:cursor";
export const quotedKey = (orderId: string) => `quoted:${orderId}`;

/** KV's smallest allowed expirationTtl, in seconds. */
const MIN_TTL_S = 60;
/** How long to keep a marker after the order closes, in seconds. */
const AFTER_CLOSE_S = 600;
/** Used when closes_at cannot be read. */
const FALLBACK_TTL_S = 3600;

export function getCursor(kv: KVNamespace): Promise<string | null> {
	return kv.get(CURSOR_KEY);
}

export async function setCursor(kv: KVNamespace, cursor: string): Promise<void> {
	await kv.put(CURSOR_KEY, cursor);
}

export async function isQuoted(kv: KVNamespace, orderId: string): Promise<boolean> {
	return (await kv.get(quotedKey(orderId))) !== null;
}

/** Seconds until the marker for this order should expire. */
export function markerTtl(order: Pick<Order, "closes_at">, nowMs: number): number {
	const closes = Date.parse(order.closes_at);
	if (!Number.isFinite(closes)) return FALLBACK_TTL_S;
	return Math.max(MIN_TTL_S, Math.ceil((closes - nowMs) / 1000) + AFTER_CLOSE_S);
}

/** `value` is a short note for humans reading KV: the price we quoted, or the API's reason for refusing. */
export async function markQuoted(kv: KVNamespace, order: Pick<Order, "id" | "closes_at">, value: string, nowMs: number): Promise<void> {
	await kv.put(quotedKey(order.id), value, { expirationTtl: markerTtl(order, nowMs) });
}
