// The runtime-agnostic core. Uses only Web APIs (Request, Response, fetch, crypto.subtle), so the same code
// runs on Cloudflare Workers, Node, Bun, Deno, or anything else that speaks the Fetch API.
//
//   provider.fetch(req)  a Fetch API handler with three routes:
//     GET  /health    { ok: true }
//     POST /webhook   signed feed deliveries from FiloBook; answered at once, quoting runs in the background
//     GET|POST /tick  run one tick now, for HTTP cron services. Off unless `tickSecret` is set.
//   provider.tick()      poll /v1/feed?since= (webhooks have no retries), then optional repricing.
//                        Call it about once a minute from whatever scheduler your platform has.

import { DEFAULT_BASE_URL, FiloBook } from "./filobook/client";
import { WebhookError, verifyWebhookRequest } from "./filobook/webhook";
import { quoteOrders, runCron, summary, type Deps, type Logger, type RunResult } from "./quoter";
import { LIMITS, RULES, validateRules, type Rules } from "./rules";
import type { Store } from "./store";

export type ProviderConfig = {
	/** An API key (fb_live_…) from the dapp's API keys page, created by your provider wallet. */
	apiKey?: string;
	/** Your provider's webhook signing secret (whsec_…), shown when you set a webhook_url. */
	webhookSecret?: string;
	/** FiloBook API base URL. Defaults to https://dapp.filobook.run. */
	baseUrl?: string;
	/** Where the feed cursor and the "already quoted" markers live. */
	store: Store;
	/** Bearer token that unlocks GET|POST /tick. Leave unset if you call tick() yourself. */
	tickSecret?: string;
	rules?: Rules;
	limits?: typeof LIMITS;
	log?: Logger;
	/** Defaults to the global fetch. */
	fetch?: typeof fetch;
	/** Current time in ms. */
	now?: () => number;
};

export type HandleOptions = {
	/**
	 * Keeps the background quoting alive after the response is sent. Pass ctx.waitUntil on Cloudflare (or your
	 * platform's equivalent on serverless). Long-running servers (Node, Bun, Deno) can leave it out.
	 */
	waitUntil?: (promise: Promise<unknown>) => void;
};

export type TickResult = { poll: RunResult; reprice: RunResult | null };

export type Provider = {
	fetch(req: Request, opts?: HandleOptions): Promise<Response>;
	/** One tick. Resolves to null when it did not run (no API key, or the previous tick is still going). Never throws. */
	tick(): Promise<TickResult | null>;
};

const defaultLog: Logger = (event, data) => console.log(JSON.stringify({ event, ...data }));

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function safeEqual(a: string, b: string) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export function createProvider(config: ProviderConfig): Provider {
	const log = config.log ?? defaultLog;
	const rules = config.rules ?? RULES;
	const deps: Deps = {
		client: new FiloBook({ apiKey: config.apiKey, baseUrl: config.baseUrl || DEFAULT_BASE_URL, fetch: config.fetch }),
		store: config.store,
		rules,
		limits: config.limits,
		now: config.now,
		log,
	};

	/** Log bad rules loudly. decide() also skips orders whose rule is invalid, so a typo never posts a wrong price. */
	const checkRules = () => {
		const problems = validateRules(rules);
		if (problems.length) log("rules.invalid", { problems });
	};

	let running: Promise<TickResult> | null = null;

	async function tick(): Promise<TickResult | null> {
		if (!config.apiKey) {
			log("tick.not_configured", { missing: "FILOBOOK_API_KEY" });
			return null;
		}
		if (running) {
			log("tick.skipped", { reason: "previous tick still running" });
			return null;
		}
		checkRules();
		running = runCron(deps);
		try {
			return await running;
		} finally {
			running = null;
		}
	}

	async function handleWebhook(req: Request, opts: HandleOptions): Promise<Response> {
		if (!config.webhookSecret) {
			log("webhook.not_configured", { missing: "WEBHOOK_SECRET" });
			return json({ error: "not_configured", message: "WEBHOOK_SECRET is not set" }, 503);
		}
		let event;
		try {
			event = await verifyWebhookRequest(req, config.webhookSecret);
		} catch (e) {
			if (e instanceof WebhookError) {
				log("webhook.rejected", { code: e.code });
				return json({ error: e.code }, 401);
			}
			throw e;
		}
		// The event name inside the signed body is the one we trust; the x-filobook-event header is not signed.
		if (event.event === "test") return json({ ok: true });
		if (event.event !== "orders.created") return json({ ok: true, ignored: true });
		if (!config.apiKey) {
			log("webhook.not_configured", { missing: "FILOBOOK_API_KEY" });
			return json({ error: "not_configured", message: "FILOBOOK_API_KEY is not set" }, 503);
		}
		const orders = Array.isArray(event.orders) ? event.orders : [];
		checkRules();
		const work = quoteOrders(orders, deps)
			.then((r) => log("webhook.done", { orders: orders.length, ...summary(r) }))
			.catch((e) => log("webhook.crashed", { message: (e as Error)?.message ?? String(e) }));
		if (opts.waitUntil) opts.waitUntil(work);
		return json({ ok: true, orders: orders.length });
	}

	async function handleTick(req: Request): Promise<Response> {
		if (!config.tickSecret) return json({ error: "not_found" }, 404);
		const auth = req.headers.get("authorization") ?? "";
		if (!safeEqual(auth, `Bearer ${config.tickSecret}`)) return json({ error: "unauthorized" }, 401);
		if (!config.apiKey) return json({ error: "not_configured", message: "FILOBOOK_API_KEY is not set" }, 503);
		const r = await tick();
		if (!r) return json({ ok: true, skipped: "busy" });
		return json({ ok: true, poll: summary(r.poll), reprice: r.reprice ? summary(r.reprice) : null });
	}

	async function fetch(req: Request, opts: HandleOptions = {}): Promise<Response> {
		const { pathname } = new URL(req.url);
		if (pathname === "/health") return req.method === "GET" || req.method === "HEAD" ? json({ ok: true }) : json({ error: "method_not_allowed" }, 405);
		if (pathname === "/webhook") return req.method === "POST" ? handleWebhook(req, opts) : json({ error: "method_not_allowed" }, 405);
		if (pathname === "/tick") return req.method === "GET" || req.method === "POST" ? handleTick(req) : json({ error: "method_not_allowed" }, 405);
		return json({ error: "not_found" }, 404);
	}

	return { fetch, tick };
}
