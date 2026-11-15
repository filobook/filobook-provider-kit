# filobook-provider-kit

An agnostic worker that quotes on [FiloBook](https://dapp.filobook.run) orders for you.

You write your prices in one file. The kit listens for FiloBook's feed webhook, polls the feed every minute as a backup, and can re-quote when another provider goes under you. The core uses only Web APIs (`Request`, `Response`, `fetch`, `crypto.subtle`), so the same code runs wherever you already host things:

| Runtime | How | State |
|---|---|---|
| Cloudflare Workers | `pnpm run deploy` (wrangler) | KV namespace |
| Node 20+ | `node dist/server.mjs` | JSON file |
| Bun | `bun dist/server.mjs` | JSON file |
| Deno 2 | `deno run --allow-net --allow-env --allow-read --allow-write dist/server.mjs` | JSON file |
| Docker (any VPS or container host) | `docker run ghcr.io/filobook/filobook-provider-kit` | JSON file on a volume |
| Your own server or framework | mount `provider.fetch`, call `provider.tick()` | any `Store` you write |

CI runs the test suite, then starts the same `dist/server.mjs` on Node 20, Node 22, Bun and Deno, and builds and starts the Docker image. Releases also publish that image to `ghcr.io/filobook/filobook-provider-kit`.

## What this kit does not do

- **It only quotes.** It does not serve the x402 calls. Your own x402 endpoint does that.
- **It does not handle payment.** When the agent has funded the FiloBook escrow ([`0x5689Cd95D9106C7498D1760058d6b85D8A9F2288`](https://robinhoodchain.blockscout.com/address/0x5689Cd95D9106C7498D1760058d6b85D8A9F2288)), a won fill pays your provider wallet in USDG on Robinhood Chain automatically; the kit does nothing for that. Other fills are recorded in the public ledger only.

## Prerequisites

- A running x402 endpoint that FiloBook can reach over HTTPS. A quote only counts as verified if FiloBook can reach this URL (see [How quoting works](#how-quoting-works)).
- A provider wallet. This is the wallet you sign in to the dapp with.
- An API key from the dapp's **API keys** page, created while signed in with that wallet. It looks like `fb_live_…` and acts as that wallet.
- Node 20 or newer and pnpm, to install and build. Plus whichever runtime you deploy to.
- A public HTTPS URL for the kit, if you want webhooks. Without one the kit still works: it polls the feed every minute.

## Setup

1. Install dependencies.

   ```sh
   pnpm install
   ```

2. Edit your price rules in [`src/rules.ts`](src/rules.ts), or for Docker and the standalone server put them in a JSON file (`RULES_FILE`, see [Settings](#settings)). The values in the file are examples only. Use your own costs.

   ```ts
   export const RULES: Rules = {
     web_search: { price: "0.04", floor: "0.025" },
     scraping: { price: "0.08", floor: "0.05", undercut: { step: "0.001" }, ttl_s: 120 },
   };
   ```

3. Deploy to one of the runtimes below and note its public URL.

4. Register your provider, with the kit's `/webhook` URL. If your wallet already has a provider, the script updates it instead.

   ```sh
   FILOBOOK_API_KEY=fb_live_… pnpm run register \
     --name "Acme Search" \
     --endpoint https://api.acme.example/x402/search \
     --types web_search,scraping \
     --webhook https://<where-the-kit-runs>/webhook
   ```

   The script prints your webhook signing secret once. It does not save it. Give it to the kit as `WEBHOOK_SECRET`.

5. Check it. `GET /health` should return `{"ok":true}`. To send a signed `test` event to your webhook:

   ```sh
   curl -X POST -H "Authorization: Bearer $FILOBOOK_API_KEY" https://dapp.filobook.run/v1/providers/me/webhook/test
   ```

### Settings

Every runtime reads the same environment variables.

| variable | meaning |
|---|---|
| `FILOBOOK_API_KEY` | Secret. Your `fb_live_…` key. Without it the kit answers webhooks with `503` and skips ticks. |
| `WEBHOOK_SECRET` | Secret. The `whsec_…` value printed by `pnpm run register`. |
| `FILOBOOK_BASE_URL` | Optional. Defaults to `https://dapp.filobook.run`. |
| `TICK_SECRET` | Optional. Turns on `GET`/`POST /tick` for HTTP cron services (see [Ticks](#ticks)). |
| `PORT`, `HOST` | Standalone server only. Default `8787` and `0.0.0.0`. |
| `STATE_FILE` | Standalone server only. Default `./.filobook-state.json`. |
| `TICK_INTERVAL_S` | Standalone server only. Seconds between ticks, default `60`. `0` turns the built-in timer off. |
| `RULES_FILE` | Standalone server and Docker only. Path to a JSON file with your price rules, same shape as `RULES` in `src/rules.ts`. Overrides the compiled rules. |
| `RULES_JSON` | Same as `RULES_FILE`, with the JSON inline. Wins when both are set. |

A rules file looks like this. A bad file (unknown type, floor above price, not JSON) stops the server at start-up with a `rules.invalid` log line, so it never quotes with wrong prices.

```json
{
  "web_search": { "price": "0.04", "floor": "0.025" },
  "scraping": { "price": "0.08", "floor": "0.05", "undercut": { "step": "0.001" }, "ttl_s": 120 }
}
```

## Deploy

### Cloudflare Workers

1. Create the KV namespace and paste the `id` it prints into `wrangler.jsonc`, replacing the zeros.

   ```sh
   pnpm exec wrangler kv namespace create STATE
   ```

2. Store your secrets, then deploy. The cron trigger in `wrangler.jsonc` runs a tick every minute.

   ```sh
   pnpm exec wrangler secret put FILOBOOK_API_KEY
   pnpm exec wrangler secret put WEBHOOK_SECRET
   pnpm run deploy
   ```

   Your webhook URL is `https://filobook-provider.<your-subdomain>.workers.dev/webhook`. Watch the logs with `pnpm exec wrangler tail`.

For local development, copy `.dev.vars.example` to `.dev.vars`, run `pnpm dev`, and open `http://localhost:8787/__scheduled` to trigger a tick by hand.

### Node, Bun or Deno

Build once, then run the single file `dist/server.mjs`. It has no runtime dependencies.

```sh
pnpm build
FILOBOOK_API_KEY=fb_live_… WEBHOOK_SECRET=whsec_… node dist/server.mjs
# or: bun dist/server.mjs
# or: deno run --allow-net --allow-env --allow-read --allow-write dist/server.mjs
```

The server ticks every minute on its own and keeps state in `STATE_FILE`. Put it behind your usual reverse proxy for HTTPS, and keep it running with systemd, pm2 or similar. Rebuild after you change `src/rules.ts`, or keep your prices in `RULES_FILE` and just restart.

Run one process per provider. The JSON file is not shared between processes. For several replicas, use a shared store (see [Your own server](#your-own-server-or-framework)).

### Docker

A prebuilt image for `linux/amd64` and `linux/arm64` is published to GitHub Container Registry on every release:

```sh
docker run -d --name filobook-provider -p 8787:8787 \
  -v filobook-state:/data \
  -v "$PWD/rules.json:/config/rules.json:ro" -e RULES_FILE=/config/rules.json \
  -e FILOBOOK_API_KEY=fb_live_… -e WEBHOOK_SECRET=whsec_… \
  ghcr.io/filobook/filobook-provider-kit:latest
```

Tags: `latest` and each version (`0.3.1`, `0.3`) from releases, `main` from the main branch. Pin a version in production. Put your prices in `rules.json` (see [Settings](#settings)); without `RULES_FILE` or `RULES_JSON` the image uses the example rules from `src/rules.ts`, which are not your costs.

To build your own image instead, with your rules compiled in:

```sh
docker build -t filobook-provider .
docker run -d --name filobook-provider -p 8787:8787 -v filobook-state:/data \
  -e FILOBOOK_API_KEY=fb_live_… -e WEBHOOK_SECRET=whsec_… filobook-provider
```

The image runs `dist/server.mjs` on Node as a non-root user and keeps state in `/data/state.json`.

### Your own server or framework

`src/index.ts` exports the core. `provider.fetch` is a plain Fetch API handler, so you can mount it in anything that gives you a `Request`.

```ts
import { createProvider, MemoryStore } from "./src";

const provider = createProvider({
  apiKey: process.env.FILOBOOK_API_KEY,
  webhookSecret: process.env.WEBHOOK_SECRET,
  store: new MemoryStore(), // or your own Store
});

// Route POST /webhook (and GET /health) to provider.fetch(request).
// On serverless platforms, pass the platform's waitUntil so quoting finishes after the response:
//   provider.fetch(request, { waitUntil })
// Then call provider.tick() about once a minute.
```

A `Store` is two methods. Any key-value store with expiring keys works, for example Redis:

```ts
const store: Store = {
  get: (key) => redis.get(key),
  put: (key, value, opts) => (opts?.ttlSeconds ? redis.set(key, value, { EX: opts.ttlSeconds }) : redis.set(key, value)).then(() => {}),
};
```

`MemoryStore` forgets everything on restart. That is safe, only less efficient: the first tick after a restart reads the newest open orders again, and FiloBook answers any repeat quote with `409 requote_not_lower`.

## Ticks

A tick polls `GET /v1/feed?since=<cursor>`, quotes what is new, then runs [repricing](#repricing-off-by-default). It should run about once a minute.

- **Cloudflare Workers:** the cron trigger in `wrangler.jsonc`.
- **Standalone server and Docker:** the built-in timer (`TICK_INTERVAL_S`).
- **Platforms with HTTP cron** (for example Vercel Cron or a GitHub Actions schedule): set `TICK_SECRET`, set `TICK_INTERVAL_S=0` on a standalone server, and have the cron call `GET` or `POST /tick` with `Authorization: Bearer <TICK_SECRET>`. The answer is a JSON summary of the tick. Without `TICK_SECRET`, `/tick` answers `404`.

If a tick is still running when the next one starts, the new one is skipped.

## Layout

| file | what it is |
|---|---|
| `src/rules.ts` | Your prices. The only file you normally edit. |
| `src/provider.ts` | The core: `createProvider()`, routes, ticks. Web APIs only. |
| `src/quoter.ts` | Quoting, feed polling and repricing. |
| `src/store.ts` | The `Store` interface, `MemoryStore`, and the cursor and marker keys. |
| `src/runtimes/cloudflare.ts` | Cloudflare Workers entry (KV store, cron trigger). |
| `src/runtimes/node.ts` | `node:http` server with a tick timer, used by Node, Bun and Deno. |
| `src/runtimes/file-store.ts` | `FileStore`, a `Store` in one JSON file. |
| `src/runtimes/rules-file.ts` | Loads `RULES_FILE` / `RULES_JSON` for the standalone server and Docker. |
| `src/server.ts` | Standalone entry, built to `dist/server.mjs`. |
| `src/filobook/` | A copy of the SDK pieces the kit needs (see below). |

### Tests

```sh
pnpm test
pnpm run typecheck
bash scripts/smoke.sh node dist/server.mjs   # after pnpm build
```

The tests use a mocked FiloBook API and in-memory stores. They never call the live API.

## How it works

- **`POST /webhook`.** FiloBook sends new orders here. The kit checks the `x-filobook-signature` header against `WEBHOOK_SECRET` and answers `401` if it does not match or the timestamp is more than 5 minutes off. A good delivery gets `200` at once. The quoting happens afterwards, in the background. `test` events just get `200`.
- **A tick, every minute.** FiloBook delivers each webhook once, with a 3 second timeout and no retries. So the kit also polls `GET /v1/feed?since=<cursor>` and keeps the cursor in its store. The cursor only moves forward once every order on the page has been handled. If a quote hits a rate limit or a server error, that order is tried again on the next tick.
- **No double quotes.** After quoting an order, the kit writes a marker for it in its store. The webhook and the tick both skip marked orders. The two can still race now and then (Cloudflare KV, for one, is eventually consistent). That is harmless: FiloBook answers the second quote with `409 requote_not_lower`, and the kit treats that as already quoted.
- **`GET /health`** returns `{"ok":true}`.
- **`GET`/`POST /tick`** runs a tick now. Off unless `TICK_SECRET` is set.

## How quoting works

Each order has a request type, a `max_price`, and a `best_quote` (the best verified price you are allowed to see, or `null`). The pure function `decide(order, rule)` in `src/rules.ts` picks the price:

1. No rule for the order's type: skip.
2. The target is the rule's `price`.
3. If the rule has `undercut` and a visible `best_quote` is lower than `price`, the target becomes `best_quote − step`.
4. If the target is above the order's `max_price`: skip. The kit never quotes above the max.
5. If the target is below the rule's `floor`: skip.

All math is done in whole micro-USDG (1 USDG = 1,000,000 micro). No floating point.

### Repricing (off by default)

Repricing only runs for rules with `undercut`. On each tick, the kit reads your current quotes (`GET /v1/me/quotes`) and the open orders you can quote (`GET /v1/feed`). If another verified quote is strictly lower than your current verified quote, it re-quotes at `best_quote − step`. It only does this if the new price stays at or above your floor and is strictly lower than your current quote. FiloBook rejects any re-quote that is not lower.

It re-quotes each order at most once per tick. It also skips orders it quoted earlier in the same tick. Two providers undercutting each other will step down once a tick until one of them reaches its floor or the order closes.

### When does a quote count?

FiloBook marks a quote as verified only if all 5 checks pass:

1. The price is at or below the order's max.
2. Your provider is active.
3. Your provider serves the order's type.
4. The quote has not expired.
5. Your `endpoint_url` is reachable. FiloBook makes one GET with a 3 second timeout and no redirects. Any status below 500, or 402, passes.

Only the cheapest verified quote can fill. A quote that fails a check is still recorded, and the kit logs which check failed.

### Rule fields

| field | meaning |
|---|---|
| `price` | The price you normally quote, as a decimal USDG string. |
| `floor` | The lowest price you will ever quote. Must be at or below `price`. |
| `undercut.step` | Optional. Go `step` under a lower visible quote, and enable repricing. |
| `ttl_s` | Optional. Quote lifetime in seconds, 10 to 3600. FiloBook's default is 60. |
| `private` | Optional. Hide your price from other providers until the order closes. |

A rule with a mistake (for example a floor above the price) is never used. The kit logs `rules.invalid` and skips orders of that type.

## Errors the kit handles

| FiloBook answer | what the kit does |
|---|---|
| `409 requote_not_lower` | Marks the order as quoted. |
| `409 order_not_open` | Marks the order and moves on. |
| `403 own_order` | Marks the order and moves on. You cannot quote your own order. |
| `403 not_eligible` | Marks the order and moves on. The order's conditions exclude you. |
| `429 rate_limited` | Stops this run. The rest is tried on the next tick. |
| `401`, `403 provider_required` | Stops this run. Check your API key and registration. |
| `5xx`, timeout, network error | Moves on to the next order and retries this one on the next tick. |

## Limits

- FiloBook allows 60 quotes a minute per wallet. `LIMITS` in `src/rules.ts` caps how many quotes (`maxQuotesPerRun`) and re-quotes (`maxRepricesPerRun`) one run may post. On Cloudflare Workers, one invocation can only make a limited number of outbound requests, and the limit depends on your plan. Keep these caps low.
- The webhook carries the order as it was when posted, usually with no `best_quote` yet. So a first quote sent from a webhook is usually your rule `price`. With `undercut` set, repricing handles the rest on the next ticks.
- `best_quote` does not include other providers' private quotes while an order is open. The kit cannot undercut what it cannot see.
- The first tick has no cursor. It reads the newest open orders, then continues from there.
- Each quote and each new cursor is one store write. On Cloudflare, check that your plan's KV write limit fits your order volume.

## About `src/filobook/`

That folder mirrors a few small pieces of the FiloBook TypeScript SDK (types, price parsing, webhook verification and a minimal API client). `@filobook/sdk` is not on npm yet. Once it is published, this folder will be replaced by the package.

## License

MIT. See [LICENSE](LICENSE).
