// The quoting loop: turn orders into quotes using the rules, and talk to FiloBook.

import { FiloBookError, type FiloBook } from "./filobook/client";
import type { Order, Quote, QuoteStatus } from "./filobook/types";
import { LIMITS, RULES, decide, decideReprice, quoteOptions, type Rule, type Rules } from "./rules";
import { getCursor, isQuoted, markQuoted, setCursor } from "./state";

export type Logger = (event: string, data?: Record<string, unknown>) => void;

export type Deps = {
	client: Pick<FiloBook, "feed" | "quote" | "myQuotes">;
	kv: KVNamespace;
	rules?: Rules;
	limits?: typeof LIMITS;
	/** Current time in ms. */
	now?: () => number;
	log?: Logger;
};

export type Outcome =
	| { order_id: string; action: "quoted"; price: string; status: QuoteStatus; failed_checks?: string[] }
	| { order_id: string; action: "skipped"; reason: string; detail?: string }
	/** FiloBook refused for a reason that will not change (order closed, own order, not eligible, ...). */
	| { order_id: string; action: "rejected"; code: string }
	/** Something that may work next time (5xx, network, timeout). */
	| { order_id: string; action: "error"; code: string };

export type StopReason = "limit" | "rate_limited" | "auth" | "error";

export type RunResult = {
	outcomes: Outcome[];
	/** Why the run ended early, if it did. */
	stopped: StopReason | null;
	/** True when some order may still need a quote, so the feed cursor must not move past it. */
	incomplete: boolean;
};

/** API answers that will not change if we ask again. We record them and never retry that order. */
const FINAL_CODES = new Set(["requote_not_lower", "order_not_open", "own_order", "not_eligible", "not_found", "invalid_price", "invalid_ttl", "invalid_private"]);
/** API answers that mean this key or wallet cannot quote at all. Stop and fix the setup. */
const AUTH_CODES = new Set(["unauthorized", "provider_required"]);

type PostResult =
	| { kind: "ok"; quote: Quote }
	| { kind: "final"; code: string }
	| { kind: "stop"; reason: "rate_limited" | "auth"; code: string }
	| { kind: "transient"; code: string };

const defaultLog: Logger = (event, data) => console.log(JSON.stringify({ event, ...data }));

async function postQuote(deps: Deps, order: Order, price: string, rule: Rule): Promise<PostResult> {
	try {
		return { kind: "ok", quote: await deps.client.quote(order.id, { price, ...quoteOptions(rule) }) };
	} catch (e) {
		if (e instanceof FiloBookError) {
			if (e.status === 429 || e.code === "rate_limited") return { kind: "stop", reason: "rate_limited", code: e.code };
			if (e.status === 401 || AUTH_CODES.has(e.code)) return { kind: "stop", reason: "auth", code: e.code };
			if (FINAL_CODES.has(e.code)) return { kind: "final", code: e.code };
			return { kind: "transient", code: e.code };
		}
		return { kind: "transient", code: (e as Error)?.name === "TimeoutError" ? "timeout" : "network" };
	}
}

const failedChecks = (q: Quote) => q.verification?.checks?.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`) ?? [];

const isOpen = (order: Order, nowMs: number) => order.status === "open" && Date.parse(order.closes_at) > nowMs;

/**
 * Quote on new orders (from a webhook delivery or a feed page). Orders already marked in KV are skipped.
 * Posts at most `limits.maxQuotesPerRun` quotes; stops at once on rate_limited or an auth problem.
 */
export async function quoteOrders(orders: Order[], deps: Deps): Promise<RunResult> {
	const rules = deps.rules ?? RULES;
	const limits = deps.limits ?? LIMITS;
	const now = deps.now ?? Date.now;
	const log = deps.log ?? defaultLog;
	const outcomes: Outcome[] = [];
	let posted = 0;
	let incomplete = false;

	for (const order of orders) {
		if (!isOpen(order, now())) {
			outcomes.push({ order_id: order.id, action: "skipped", reason: "not_open" });
			continue;
		}
		if (await isQuoted(deps.kv, order.id)) {
			outcomes.push({ order_id: order.id, action: "skipped", reason: "already_quoted" });
			continue;
		}
		const rule = rules[order.type];
		const decision = decide(order, rule);
		if ("skip" in decision) {
			outcomes.push({ order_id: order.id, action: "skipped", reason: decision.skip, detail: decision.detail });
			continue;
		}
		if (posted >= limits.maxQuotesPerRun) {
			log("quote.limit_reached", { limit: limits.maxQuotesPerRun });
			return { outcomes, stopped: "limit", incomplete: true };
		}
		posted++;
		const res = await postQuote(deps, order, decision.price, rule!);
		if (res.kind === "ok") {
			const failed = failedChecks(res.quote);
			await markQuoted(deps.kv, order, decision.price, now());
			outcomes.push({ order_id: order.id, action: "quoted", price: decision.price, status: res.quote.status, ...(failed.length ? { failed_checks: failed } : {}) });
			log(res.quote.status === "verified" ? "quote.verified" : "quote.not_verified", { order_id: order.id, price: decision.price, status: res.quote.status, failed_checks: failed });
		} else if (res.kind === "final") {
			await markQuoted(deps.kv, order, res.code, now());
			outcomes.push({ order_id: order.id, action: "rejected", code: res.code });
			log("quote.rejected", { order_id: order.id, code: res.code });
		} else if (res.kind === "stop") {
			outcomes.push({ order_id: order.id, action: "error", code: res.code });
			log("quote.stopped", { order_id: order.id, code: res.code });
			return { outcomes, stopped: res.reason, incomplete: true };
		} else {
			incomplete = true;
			outcomes.push({ order_id: order.id, action: "error", code: res.code });
			log("quote.error", { order_id: order.id, code: res.code });
		}
	}
	return { outcomes, stopped: null, incomplete };
}

/**
 * Poll GET /v1/feed?since=<cursor> and quote what is new. The cursor only moves forward when every order on
 * the page was handled, so an order hit by a rate limit or a 5xx is tried again next run. That can only hold
 * the cursor back until the order closes, because the feed lists open orders only.
 */
export async function pollFeed(deps: Deps): Promise<RunResult & { cursor: string | null }> {
	const log = deps.log ?? defaultLog;
	const since = await getCursor(deps.kv);
	let page: { orders: Order[]; cursor: string | null };
	try {
		page = await deps.client.feed(since ? { since } : {});
	} catch (e) {
		const code = e instanceof FiloBookError ? e.code : "network";
		const stopped: StopReason = e instanceof FiloBookError && (e.status === 401 || AUTH_CODES.has(e.code)) ? "auth" : e instanceof FiloBookError && e.status === 429 ? "rate_limited" : "error";
		log("feed.error", { code });
		return { outcomes: [], stopped, incomplete: true, cursor: since };
	}
	const result = await quoteOrders(page.orders ?? [], deps);
	let cursor = since;
	if (!result.incomplete && page.cursor && page.cursor !== since) {
		await setCursor(deps.kv, page.cursor);
		cursor = page.cursor;
	}
	return { ...result, cursor };
}

/**
 * Re-quote open orders where someone has gone under your verified quote, for rules with `undercut`.
 * One feed call (open orders with the best price you can see) and one /v1/me/quotes call per run, then at most
 * one re-quote per order and `limits.maxRepricesPerRun` in total. Orders in `exclude` (quoted earlier in this
 * run) are left alone.
 */
export async function reprice(deps: Deps, exclude: ReadonlySet<string> = new Set()): Promise<RunResult> {
	const rules = deps.rules ?? RULES;
	const limits = deps.limits ?? LIMITS;
	const now = deps.now ?? Date.now;
	const log = deps.log ?? defaultLog;
	const outcomes: Outcome[] = [];
	if (!Object.values(rules).some((r) => r?.undercut)) return { outcomes, stopped: null, incomplete: false };

	let orders: Order[];
	let quotes: Quote[];
	try {
		[orders, quotes] = await Promise.all([deps.client.feed({ limit: 200 }).then((p) => p.orders ?? []), deps.client.myQuotes({ limit: 200 })]);
	} catch (e) {
		log("reprice.error", { code: e instanceof FiloBookError ? e.code : "network" });
		return { outcomes, stopped: "error", incomplete: true };
	}

	// /v1/me/quotes is newest first, so the first quote per order is the current one. Only a live verified
	// quote counts: a re-quote has to beat that one.
	const current = new Map<string, string>();
	const seen = new Set<string>();
	for (const q of quotes) {
		if (seen.has(q.order_id)) continue;
		seen.add(q.order_id);
		if (q.status === "verified" && q.price !== null) current.set(q.order_id, q.price);
	}

	const done = new Set<string>();
	let posted = 0;
	for (const order of orders) {
		if (done.has(order.id) || exclude.has(order.id)) continue;
		done.add(order.id);
		const mine = current.get(order.id);
		if (!mine || !isOpen(order, now())) continue;
		const rule = rules[order.type];
		const decision = decideReprice(order, rule, mine);
		if ("skip" in decision) {
			if (decision.skip === "below_floor") log("reprice.floor", { order_id: order.id, best_quote: order.best_quote, current: mine });
			outcomes.push({ order_id: order.id, action: "skipped", reason: decision.skip, detail: decision.detail });
			continue;
		}
		if (posted >= limits.maxRepricesPerRun) {
			log("reprice.limit_reached", { limit: limits.maxRepricesPerRun });
			return { outcomes, stopped: "limit", incomplete: true };
		}
		posted++;
		const res = await postQuote(deps, order, decision.price, rule!);
		if (res.kind === "ok") {
			const failed = failedChecks(res.quote);
			outcomes.push({ order_id: order.id, action: "quoted", price: decision.price, status: res.quote.status, ...(failed.length ? { failed_checks: failed } : {}) });
			log("reprice.quoted", { order_id: order.id, from: mine, price: decision.price, status: res.quote.status, failed_checks: failed });
		} else if (res.kind === "final") {
			outcomes.push({ order_id: order.id, action: "rejected", code: res.code });
			log("reprice.rejected", { order_id: order.id, code: res.code });
		} else if (res.kind === "stop") {
			outcomes.push({ order_id: order.id, action: "error", code: res.code });
			log("reprice.stopped", { order_id: order.id, code: res.code });
			return { outcomes, stopped: res.reason, incomplete: true };
		} else {
			outcomes.push({ order_id: order.id, action: "error", code: res.code });
			log("reprice.error", { order_id: order.id, code: res.code });
		}
	}
	return { outcomes, stopped: null, incomplete: false };
}

/** One cron run: poll the feed, then reprice. Never throws. */
export async function runCron(deps: Deps): Promise<{ poll: RunResult; reprice: RunResult | null }> {
	const log = deps.log ?? defaultLog;
	try {
		const poll = await pollFeed(deps);
		if (poll.stopped === "auth" || poll.stopped === "rate_limited") {
			log("cron.done", { poll: summary(poll), reprice: null });
			return { poll, reprice: null };
		}
		const quotedNow = new Set(poll.outcomes.filter((o) => o.action === "quoted").map((o) => o.order_id));
		const rep = await reprice(deps, quotedNow);
		log("cron.done", { poll: summary(poll), reprice: summary(rep) });
		return { poll, reprice: rep };
	} catch (e) {
		log("cron.crashed", { message: (e as Error)?.message ?? String(e) });
		return { poll: { outcomes: [], stopped: "error", incomplete: true }, reprice: null };
	}
}

export function summary(r: RunResult) {
	const count = (a: Outcome["action"]) => r.outcomes.filter((o) => o.action === a).length;
	return { quoted: count("quoted"), skipped: count("skipped"), rejected: count("rejected"), errors: count("error"), stopped: r.stopped };
}
