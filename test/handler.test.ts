import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signWebhook } from "../src/filobook/webhook";
import worker, { type Env } from "../src/index";
import { quotedKey } from "../src/state";
import { MemoryKV, NOW, TestContext, apiError, fakeApi, order, quoteOk } from "./helpers";

/** worker.fetch with a plain Request (tests have no incoming `cf` properties). */
const hit = (req: Request, env: Env, ctx: ExecutionContext) => worker.fetch(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);

const SECRET = "whsec_test_000000000000000000000000000000000000000000";
const KEY = "fb_live_test";

function setup(routes: Parameters<typeof fakeApi>[0] = { "POST /v1/orders/:id/quotes": quoteOk() }) {
	const api = fakeApi(routes);
	vi.stubGlobal("fetch", api.fetch);
	const kv = new MemoryKV();
	const env: Env = { FILOBOOK_API_KEY: KEY, WEBHOOK_SECRET: SECRET, FILOBOOK_BASE_URL: "https://filobook.test", STATE: kv.asKV() };
	return { api, kv, env };
}

async function delivery(body: object, opts: { secret?: string; timestamp?: number; method?: string } = {}) {
	const raw = JSON.stringify(body);
	const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
	return new Request("https://kit.test/webhook", {
		method: opts.method ?? "POST",
		headers: {
			"content-type": "application/json",
			"x-filobook-event": (body as { event?: string }).event ?? "orders.created",
			"x-filobook-timestamp": ts,
			"x-filobook-signature": await signWebhook(opts.secret ?? SECRET, ts, raw),
		},
		body: raw,
	});
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

describe("GET /health", () => {
	it("returns ok", async () => {
		const { env } = setup();
		const res = await hit(new Request("https://kit.test/health"), env, new TestContext().asCtx());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
	it("404s unknown paths and 405s wrong methods", async () => {
		const { env } = setup();
		expect((await hit(new Request("https://kit.test/nope"), env, new TestContext().asCtx())).status).toBe(404);
		expect((await hit(new Request("https://kit.test/webhook"), env, new TestContext().asCtx())).status).toBe(405);
	});
});

describe("POST /webhook", () => {
	it("rejects a bad signature with 401 and does nothing", async () => {
		const { env, api } = setup();
		const ctx = new TestContext();
		const res = await hit(await delivery({ event: "orders.created", sent_at: "x", orders: [order()] }, { secret: "whsec_wrong" }), env, ctx.asCtx());
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "bad_signature" });
		await ctx.settle();
		expect(ctx.promises).toHaveLength(0);
		expect(api.calls).toHaveLength(0);
	});

	it("rejects a stale timestamp with 401", async () => {
		const { env, api } = setup();
		const old = Math.floor(NOW / 1000) - 301;
		const res = await hit(await delivery({ event: "orders.created", sent_at: "x", orders: [order()] }, { timestamp: old }), env, new TestContext().asCtx());
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "stale_timestamp" });
		expect(api.calls).toHaveLength(0);
	});

	it("rejects a missing signature with 401", async () => {
		const { env } = setup();
		const req = new Request("https://kit.test/webhook", { method: "POST", body: "{}" });
		expect((await hit(req, env, new TestContext().asCtx())).status).toBe(401);
	});

	it("answers 503 when WEBHOOK_SECRET is not set", async () => {
		const { env } = setup();
		const res = await hit(await delivery({ event: "test", sent_at: "x", orders: [] }), { ...env, WEBHOOK_SECRET: undefined }, new TestContext().asCtx());
		expect(res.status).toBe(503);
	});

	it("answers test events with 200 and no API calls", async () => {
		const { env, api } = setup();
		const ctx = new TestContext();
		const res = await hit(await delivery({ event: "test", sent_at: "x", orders: [] }), env, ctx.asCtx());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(ctx.promises).toHaveLength(0);
		expect(api.calls).toHaveLength(0);
	});

	it("answers 200 at once and quotes inside waitUntil", async () => {
		const { env, api, kv } = setup();
		const ctx = new TestContext();
		const a = order({ max_price: "0.05" });
		const b = order({ max_price: "0.03" }); // below the example rule price 0.04: skipped
		const c = order({ type: "image" }); // no rule for image: skipped
		const res = await hit(await delivery({ event: "orders.created", sent_at: "x", orders: [a, b, c] }), env, ctx.asCtx());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, orders: 3 });
		expect(ctx.promises).toHaveLength(1);

		await ctx.settle();
		const posted = api.quotes();
		expect(posted).toHaveLength(1);
		expect(posted[0].path).toBe(`/v1/orders/${a.id}/quotes`);
		expect(posted[0].body).toEqual({ price: "0.04" });
		expect(posted[0].auth).toBe(`Bearer ${KEY}`);
		expect(await kv.get(quotedKey(a.id))).toBe("0.04");
		expect(await kv.get(quotedKey(b.id))).toBeNull();
	});

	it("does not quote the same order twice", async () => {
		const { env, api } = setup();
		const a = order();
		for (let i = 0; i < 2; i++) {
			const ctx = new TestContext();
			await hit(await delivery({ event: "orders.created", sent_at: "x", orders: [a] }), env, ctx.asCtx());
			await ctx.settle();
		}
		expect(api.quotes()).toHaveLength(1);
	});

	it("survives API errors inside waitUntil", async () => {
		const { env, kv } = setup({ "POST /v1/orders/:id/quotes": apiError(409, "order_not_open") });
		const ctx = new TestContext();
		const a = order();
		const res = await hit(await delivery({ event: "orders.created", sent_at: "x", orders: [a] }), env, ctx.asCtx());
		expect(res.status).toBe(200);
		await expect(ctx.settle()).resolves.toBeUndefined();
		expect(await kv.get(quotedKey(a.id))).toBe("order_not_open");
	});
});
