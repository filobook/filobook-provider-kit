// FiloBook provider kit: a Worker that quotes on FiloBook orders from the price rules in src/rules.ts.
//
//   POST /webhook  signed feed deliveries from FiloBook; answered at once, quoting runs in waitUntil
//   GET  /health   { ok: true }
//   cron           every minute: poll /v1/feed?since= (webhooks have no retries), then optional repricing

import { DEFAULT_BASE_URL, FiloBook } from "./filobook/client";
import { WebhookError, verifyWebhookRequest } from "./filobook/webhook";
import { quoteOrders, runCron, summary, type Deps } from "./quoter";
import { RULES, validateRules } from "./rules";

export interface Env {
	/** FiloBook API base URL. Defaults to https://dapp.filobook.run. */
	FILOBOOK_BASE_URL?: string;
	/** Secret: an API key (fb_live_…) from the dapp's API keys page, created by your provider wallet. */
	FILOBOOK_API_KEY?: string;
	/** Secret: your provider's webhook signing secret (whsec_…), shown when you set a webhook_url. */
	WEBHOOK_SECRET?: string;
	/** KV namespace for the feed cursor and the "already quoted" markers. */
	STATE: KVNamespace;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const log = (event: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ event, ...data }));

export function makeDeps(env: Env): Deps {
	return {
		client: new FiloBook({ apiKey: env.FILOBOOK_API_KEY, baseUrl: env.FILOBOOK_BASE_URL || DEFAULT_BASE_URL }),
		kv: env.STATE,
		log,
	};
}

/** Log bad rules loudly. decide() also skips orders whose rule is invalid, so a typo never posts a wrong price. */
function checkRules() {
	const problems = validateRules(RULES);
	if (problems.length) log("rules.invalid", { problems });
}

async function handleWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (!env.WEBHOOK_SECRET) {
		log("webhook.not_configured", { missing: "WEBHOOK_SECRET" });
		return json({ error: "not_configured", message: "WEBHOOK_SECRET is not set" }, 503);
	}
	let event;
	try {
		event = await verifyWebhookRequest(req, env.WEBHOOK_SECRET);
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
	if (!env.FILOBOOK_API_KEY) {
		log("webhook.not_configured", { missing: "FILOBOOK_API_KEY" });
		return json({ error: "not_configured", message: "FILOBOOK_API_KEY is not set" }, 503);
	}
	const orders = Array.isArray(event.orders) ? event.orders : [];
	checkRules();
	ctx.waitUntil(
		quoteOrders(orders, makeDeps(env))
			.then((r) => log("webhook.done", { orders: orders.length, ...summary(r) }))
			.catch((e) => log("webhook.crashed", { message: (e as Error)?.message ?? String(e) })),
	);
	return json({ ok: true, orders: orders.length });
}

export default {
	async fetch(req, env, ctx) {
		const { pathname } = new URL(req.url);
		if (pathname === "/health") return req.method === "GET" || req.method === "HEAD" ? json({ ok: true }) : json({ error: "method_not_allowed" }, 405);
		if (pathname === "/webhook") return req.method === "POST" ? handleWebhook(req, env, ctx) : json({ error: "method_not_allowed" }, 405);
		return json({ error: "not_found" }, 404);
	},

	async scheduled(_controller, env, ctx) {
		if (!env.FILOBOOK_API_KEY) {
			log("cron.not_configured", { missing: "FILOBOOK_API_KEY" });
			return;
		}
		checkRules();
		ctx.waitUntil(runCron(makeDeps(env)));
	},
} satisfies ExportedHandler<Env>;
