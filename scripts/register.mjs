#!/usr/bin/env node
// Register your provider on FiloBook, or update it if this wallet already has one.
//
//   FILOBOOK_API_KEY=fb_live_… node scripts/register.mjs \
//     --name "Acme Search" \
//     --endpoint https://api.acme.example/x402/search \
//     --types web_search,scraping \
//     --webhook https://<where-the-kit-runs>/webhook
//
// Node 20+, no dependencies. The API key never leaves this process except in the Authorization header.

import { parseArgs } from "node:util";

const REQUEST_TYPES = ["market_data", "web_search", "scraping", "inference", "compute", "dataset", "image", "storage", "translation", "speech", "tool", "other"];

const HELP = `Register or update your FiloBook provider.

Usage:
  FILOBOOK_API_KEY=fb_live_… node scripts/register.mjs --name <name> --endpoint <url> --types <a,b> [--webhook <url>]

Options:
  --name       Provider name shown on FiloBook
  --endpoint   Your x402 endpoint. FiloBook checks it is reachable before a quote counts as verified.
  --types      Comma-separated request types you serve: ${REQUEST_TYPES.join(", ")}
  --webhook    The kit's public /webhook URL, so FiloBook pushes new orders to it (optional; the tick polls anyway)
  --base-url   FiloBook API (default: $FILOBOOK_BASE_URL or https://dapp.filobook.run)
  --help       Show this help

When the provider already exists (409 provider_exists), the same fields are sent with PATCH /v1/providers/me.`;

function fail(message) {
	console.error(`error: ${message}`);
	process.exit(1);
}

function httpsUrl(value, flag) {
	let url;
	try {
		url = new URL(value);
	} catch {
		fail(`${flag} must be a full URL`);
	}
	if (url.protocol !== "https:") fail(`${flag} must use https://`);
	return url.toString();
}

let args;
try {
	// `pnpm run register -- --name …` passes the "--" through; drop it.
	const argv = process.argv.slice(2);
	if (argv[0] === "--") argv.shift();
	args = parseArgs({
		args: argv,
		options: {
			name: { type: "string" },
			endpoint: { type: "string" },
			types: { type: "string" },
			webhook: { type: "string" },
			"base-url": { type: "string" },
			help: { type: "boolean" },
		},
	}).values;
} catch (e) {
	fail(`${e.message}\n\n${HELP}`);
}

if (args.help) {
	console.log(HELP);
	process.exit(0);
}

const apiKey = process.env.FILOBOOK_API_KEY;
if (!apiKey) fail("set FILOBOOK_API_KEY (create one on the dapp's API keys page with your provider wallet)");
if (!args.name?.trim()) fail("--name is required");
if (!args.endpoint) fail("--endpoint is required");
if (!args.types) fail("--types is required");

const types = [...new Set(args.types.split(",").map((t) => t.trim()).filter(Boolean))];
const unknown = types.filter((t) => !REQUEST_TYPES.includes(t));
if (!types.length) fail("--types needs at least one type");
if (unknown.length) fail(`unknown type(s): ${unknown.join(", ")}. Valid: ${REQUEST_TYPES.join(", ")}`);

const baseUrl = (args["base-url"] || process.env.FILOBOOK_BASE_URL || "https://dapp.filobook.run").replace(/\/+$/, "");
const fields = { name: args.name.trim(), endpoint_url: httpsUrl(args.endpoint, "--endpoint"), types };
if (args.webhook) fields.webhook_url = httpsUrl(args.webhook, "--webhook");

async function call(method, path, body) {
	const res = await fetch(baseUrl + path, {
		method,
		headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json", "user-agent": "filobook-provider-kit/0.1.0" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
	});
	const text = await res.text();
	let data = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		/* not JSON */
	}
	return { status: res.status, data };
}

let res = await call("POST", "/v1/providers", fields);
let action = "Registered";
if (res.status === 409 && res.data?.error === "provider_exists") {
	res = await call("PATCH", "/v1/providers/me", fields);
	action = "Updated";
}
if (res.status < 200 || res.status >= 300) {
	fail(`${res.status} ${res.data?.error ?? "http_error"}: ${res.data?.message ?? "request failed"}`);
}

const p = res.data;
console.log(`${action} provider ${p.id} (${p.name})`);
console.log(`  endpoint: ${p.endpoint_url}`);
console.log(`  types:    ${p.types.join(", ")}`);
console.log(`  active:   ${p.active}`);
console.log(`  webhook:  ${p.webhook_url ?? "none (the tick still polls the feed every minute)"}`);

if (p.webhook_secret) {
	console.log(`
Your webhook signing secret (it is yours; this script does not save it anywhere):

  ${p.webhook_secret}

Give it to the kit as WEBHOOK_SECRET:

  Cloudflare Workers:  pnpm exec wrangler secret put WEBHOOK_SECRET
  Node, Bun, Deno:     set WEBHOOK_SECRET=… in the server's environment (for example a .env file you do not commit)`);
}
