// Standalone server for Node 20+, Bun and Deno. Build it with `pnpm build`, then run one of:
//
//   node dist/server.mjs
//   bun dist/server.mjs
//   deno run --allow-net --allow-env --allow-read --allow-write dist/server.mjs
//
// Settings come from the environment: FILOBOOK_API_KEY, WEBHOOK_SECRET, FILOBOOK_BASE_URL, TICK_SECRET, plus
//   PORT             default 8787
//   HOST             default 0.0.0.0
//   STATE_FILE       default ./.filobook-state.json
//   TICK_INTERVAL_S  default 60; 0 turns the built-in timer off
//   RULES_FILE       optional JSON price rules (same shape as src/rules.ts); RULES_JSON takes the JSON inline

import process from "node:process";
import { configFromEnv } from "./env";
import { createProvider } from "./provider";
import { FileStore } from "./runtimes/file-store";
import { loadRules, RulesError } from "./runtimes/rules-file";
import { serve } from "./runtimes/node";

const env = process.env;
const num = (value: string | undefined, fallback: number) => {
	const n = Number(value);
	return value !== undefined && value !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
};

let rules;
try {
	rules = loadRules(env);
} catch (e) {
	if (!(e instanceof RulesError)) throw e;
	console.error(JSON.stringify({ event: "rules.invalid", message: e.message }));
	process.exit(1);
}
if (rules) console.log(JSON.stringify({ event: "rules.loaded", source: env.RULES_JSON ? "RULES_JSON" : "RULES_FILE", types: Object.keys(rules) }));

const provider = createProvider({ ...configFromEnv(env), rules, store: new FileStore(env.STATE_FILE || ".filobook-state.json") });
const server = await serve(provider, { port: num(env.PORT, 8787), host: env.HOST || "0.0.0.0", tickIntervalS: num(env.TICK_INTERVAL_S, 60) });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void server.close().then(() => process.exit(0));
	});
}
