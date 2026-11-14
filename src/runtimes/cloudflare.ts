// Cloudflare Workers entry (wrangler.jsonc "main"). State lives in the KV namespace bound as STATE; the cron
// trigger in wrangler.jsonc calls tick() every minute.

import { configFromEnv, type EnvVars } from "../env";
import { createProvider } from "../provider";
import type { Store } from "../store";

/** The two KV methods the kit uses, so this file does not need @cloudflare/workers-types. */
export interface KVLike {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

interface Ctx {
	waitUntil(promise: Promise<unknown>): void;
}

export interface Env extends EnvVars {
	/** KV namespace for the feed cursor and the "already quoted" markers. */
	STATE: KVLike;
}

export const kvStore = (kv: KVLike): Store => ({
	get: (key) => kv.get(key),
	put: (key, value, opts) => kv.put(key, value, opts?.ttlSeconds ? { expirationTtl: opts.ttlSeconds } : undefined),
});

const providerFor = (env: Env) => createProvider({ ...configFromEnv(env), store: kvStore(env.STATE) });

export default {
	fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
		return providerFor(env).fetch(req, { waitUntil: (p) => ctx.waitUntil(p) });
	},
	async scheduled(_controller: unknown, env: Env, ctx: Ctx): Promise<void> {
		ctx.waitUntil(providerFor(env).tick());
	},
};
