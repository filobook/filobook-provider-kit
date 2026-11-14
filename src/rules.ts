// Your price rules. Edit RULES below, then deploy.
//
// All prices are decimal USDG strings with up to 6 decimals, like "0.04". The kit turns them into whole
// micro-USDG (1 USDG = 1,000,000 micro) and never uses floating point for money.

import { formatMicro, parsePrice } from "./filobook/price";
import type { Order, RequestType } from "./filobook/types";

export type Rule = {
	/** The price you normally quote. */
	price: string;
	/** The lowest price you will ever quote for this type. Must be at or below `price`. */
	floor: string;
	/**
	 * Optional. When a lower verified quote is visible, quote `best - step` instead of `price`, but never
	 * below `floor`. The cron also uses it to re-quote orders where someone has gone under you.
	 */
	undercut?: { step: string };
	/** Quote lifetime in seconds, 10–3600. FiloBook's default is 60. */
	ttl_s?: number;
	/** Hide your price from other providers until the order closes. */
	private?: boolean;
};

export type Rules = Partial<Record<RequestType, Rule>>;

/**
 * One rule per request type you serve. Types without a rule are never quoted. These values are examples
 * only: replace them with your own costs before you deploy.
 */
export const RULES: Rules = {
	web_search: { price: "0.04", floor: "0.025" },
	// scraping: { price: "0.08", floor: "0.05", undercut: { step: "0.001" }, ttl_s: 120 },
	// inference: { price: "0.02", floor: "0.012", private: true },
};

/**
 * Caps per run, so one webhook or cron run stays inside the Worker's subrequest budget and under
 * FiloBook's quote rate limit (60 quotes a minute per wallet).
 */
export const LIMITS = {
	/** Most new quotes posted by one webhook delivery or one cron run. */
	maxQuotesPerRun: 20,
	/** Most re-quotes posted by one cron run. */
	maxRepricesPerRun: 10,
};

// ---------- decisions (pure, no I/O) ----------

export type SkipReason =
	| "no_rule"
	| "invalid_rule"
	| "invalid_order"
	| "above_max"
	| "below_floor"
	| "no_undercut"
	| "no_best_quote"
	| "not_beaten"
	| "not_lower";

export type Decision = { price: string } | { skip: SkipReason; detail?: string };

export type CompiledRule = { price: number; floor: number; step: number | null; ttl_s?: number; private?: boolean };

/** Turn a rule into micro-USDG and check it. Returns an error message for a bad rule. */
export function compileRule(rule: Rule): { rule: CompiledRule } | { error: string } {
	const price = parsePrice(rule.price);
	if (price === null) return { error: `price "${rule.price}" is not a valid USDG amount` };
	const floor = parsePrice(rule.floor);
	if (floor === null) return { error: `floor "${rule.floor}" is not a valid USDG amount` };
	if (floor > price) return { error: `floor ${rule.floor} is above price ${rule.price}` };
	let step: number | null = null;
	if (rule.undercut) {
		step = parsePrice(rule.undercut.step);
		if (step === null) return { error: `undercut.step "${rule.undercut.step}" is not a valid USDG amount` };
	}
	if (rule.ttl_s !== undefined && (!Number.isInteger(rule.ttl_s) || rule.ttl_s < 10 || rule.ttl_s > 3600)) {
		return { error: `ttl_s ${rule.ttl_s} must be a whole number from 10 to 3600` };
	}
	if (rule.private !== undefined && typeof rule.private !== "boolean") return { error: "private must be true or false" };
	return { rule: { price, floor, step, ttl_s: rule.ttl_s, private: rule.private } };
}

/** Every rule problem in a rules object, as "type: message" strings. Empty when all rules are valid. */
export function validateRules(rules: Rules): string[] {
	const problems: string[] = [];
	for (const [type, rule] of Object.entries(rules)) {
		if (!rule) continue;
		const r = compileRule(rule);
		if ("error" in r) problems.push(`${type}: ${r.error}`);
	}
	return problems;
}

/**
 * The price to quote on a new order, or why to skip it.
 *
 * Target is the rule's `price`. With `undercut`, when a verified quote below `price` is visible, the target
 * becomes `best_quote - step`. Skip when the target is above the order's max or below the rule's floor.
 */
export function decide(order: Pick<Order, "max_price" | "best_quote">, rule: Rule | undefined): Decision {
	if (!rule) return { skip: "no_rule" };
	const compiled = compileRule(rule);
	if ("error" in compiled) return { skip: "invalid_rule", detail: compiled.error };
	const r = compiled.rule;
	const max = parsePrice(order.max_price);
	if (max === null) return { skip: "invalid_order", detail: `max_price "${order.max_price}"` };
	const best = order.best_quote ? parsePrice(order.best_quote) : null;

	let target = r.price;
	if (r.step !== null && best !== null && best < r.price) target = best - r.step;

	if (target > max) return { skip: "above_max", detail: `${formatMicro(target)} > max ${order.max_price}` };
	if (target < r.floor) return { skip: "below_floor", detail: `${formatMicro(target)} < floor ${rule.floor}` };
	return { price: formatMicro(target) };
}

/**
 * The price to re-quote at on an order you already quoted, or why not to.
 *
 * Only for rules with `undercut`, and only when a verified quote strictly below your current one is visible.
 * The new price is `best_quote - step`, which must stay at or above the floor, at or below the max, and
 * strictly below your current quote (FiloBook rejects anything else with requote_not_lower).
 */
export function decideReprice(order: Pick<Order, "max_price" | "best_quote">, rule: Rule | undefined, current: string): Decision {
	if (!rule) return { skip: "no_rule" };
	const compiled = compileRule(rule);
	if ("error" in compiled) return { skip: "invalid_rule", detail: compiled.error };
	const r = compiled.rule;
	if (r.step === null) return { skip: "no_undercut" };
	const max = parsePrice(order.max_price);
	const mine = parsePrice(current);
	if (max === null || mine === null) return { skip: "invalid_order" };
	const best = order.best_quote ? parsePrice(order.best_quote) : null;
	if (best === null) return { skip: "no_best_quote" };
	if (best >= mine) return { skip: "not_beaten" };

	const target = best - r.step;
	if (target < r.floor) return { skip: "below_floor", detail: `${formatMicro(target)} < floor ${rule.floor}` };
	if (target >= mine) return { skip: "not_lower" };
	if (target > max) return { skip: "above_max" };
	return { price: formatMicro(target) };
}

/** The extra quote fields a rule asks for (ttl_s, private), left out when not set. */
export function quoteOptions(rule: Rule): { ttl_s?: number; private?: boolean } {
	const out: { ttl_s?: number; private?: boolean } = {};
	if (rule.ttl_s !== undefined) out.ttl_s = rule.ttl_s;
	if (rule.private !== undefined) out.private = rule.private;
	return out;
}
