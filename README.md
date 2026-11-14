# filobook-provider-kit

A Cloudflare Worker that quotes on [FiloBook](https://dapp.filobook.run) orders for you, using price rules you write in one file. It listens for FiloBook's feed webhook, polls the feed every minute as a backup, and can optionally re-quote when another provider goes under you.

## What this kit does not do

- **It only quotes.** It does not serve the x402 calls. Your own x402 endpoint does that.
- **No funds move on FiloBook yet.** There is no settlement contract. A fill records who won and at what price.
- **$FILO has not launched.**

## Prerequisites

- A running x402 endpoint that FiloBook can reach over HTTPS. A quote only counts as verified if FiloBook can reach this URL (see [How quoting works](#how-quoting-works)).
- A provider wallet. This is the wallet you sign in to the dapp with.
- An API key from the dapp's **API keys** page, created while signed in with that wallet. It looks like `fb_live_…` and acts as that wallet.
- A Cloudflare account, Node 20 or newer, and pnpm.

## Setup

1. Install dependencies.

   ```sh
   pnpm install
   ```

2. Create the KV namespace. It stores the feed cursor and short-lived "already quoted" markers.

   ```sh
   pnpm exec wrangler kv namespace create STATE
   ```

   Paste the `id` it prints into `wrangler.jsonc`, replacing the zeros.

3. Edit your price rules in [`src/rules.ts`](src/rules.ts). The values in the file are examples only. Use your own costs.

   ```ts
   export const RULES: Rules = {
     web_search: { price: "0.04", floor: "0.025" },
     scraping: { price: "0.08", floor: "0.05", undercut: { step: "0.001" }, ttl_s: 120 },
   };
   ```

4. Store your API key in the Worker, then deploy.

   ```sh
   pnpm exec wrangler secret put FILOBOOK_API_KEY
   pnpm run deploy
   ```

   Note the Worker URL that wrangler prints, for example `https://filobook-provider.<your-subdomain>.workers.dev`.

5. Register your provider, with the Worker's `/webhook` URL. If your wallet already has a provider, the script updates it instead.

   ```sh
   FILOBOOK_API_KEY=fb_live_… pnpm run register \
     --name "Acme Search" \
     --endpoint https://api.acme.example/x402/search \
     --types web_search,scraping \
     --webhook https://filobook-provider.<your-subdomain>.workers.dev/webhook
   ```

   The script prints your webhook signing secret once. It does not save it.

6. Store the webhook secret in the Worker.

   ```sh
   pnpm exec wrangler secret put WEBHOOK_SECRET
   ```

7. Check it. `GET /health` should return `{"ok":true}`. To send a signed `test` event to your webhook:

   ```sh
   curl -X POST -H "Authorization: Bearer $FILOBOOK_API_KEY" https://dapp.filobook.run/v1/providers/me/webhook/test
   ```

   Watch the Worker's logs with `pnpm exec wrangler tail`.

### Local development

Copy `.dev.vars.example` to `.dev.vars` and fill it in. Then run `pnpm dev`. To trigger the cron by hand, open `http://localhost:8787/__scheduled`.

### Tests

```sh
pnpm test
pnpm run typecheck
```

The tests use a mocked FiloBook API and an in-memory KV. They never call the live API.

## How it works

- **`POST /webhook`.** FiloBook sends new orders here. The Worker checks the `x-filobook-signature` header against `WEBHOOK_SECRET` and answers `401` if it does not match or the timestamp is more than 5 minutes off. A good delivery gets `200` at once. The quoting happens afterwards, in `waitUntil`. `test` events just get `200`.
- **Cron, every minute.** FiloBook delivers each webhook once, with a 3 second timeout and no retries. So the Worker also polls `GET /v1/feed?since=<cursor>` and keeps the cursor in KV. The cursor only moves forward once every order on the page has been handled. If a quote hits a rate limit or a server error, that order is tried again next minute.
- **No double quotes.** After quoting an order, the Worker writes a KV marker for it. The webhook and the cron both skip marked orders. KV is eventually consistent, so the two can still race now and then. That is harmless: FiloBook answers the second quote with `409 requote_not_lower`, and the Worker treats that as already quoted.
- **`GET /health`** returns `{"ok":true}`.

## How quoting works

Each order has a request type, a `max_price`, and a `best_quote` (the best verified price you are allowed to see, or `null`). The pure function `decide(order, rule)` in `src/rules.ts` picks the price:

1. No rule for the order's type: skip.
2. The target is the rule's `price`.
3. If the rule has `undercut` and a visible `best_quote` is lower than `price`, the target becomes `best_quote − step`.
4. If the target is above the order's `max_price`: skip. The kit never quotes above the max.
5. If the target is below the rule's `floor`: skip.

All math is done in whole micro-USDG (1 USDG = 1,000,000 micro). No floating point.

### Repricing (off by default)

Repricing only runs for rules with `undercut`. Once a minute, the cron reads your current quotes (`GET /v1/me/quotes`) and the open orders you can quote (`GET /v1/feed`). If another verified quote is strictly lower than your current verified quote, it re-quotes at `best_quote − step`. It only does this if the new price stays at or above your floor and is strictly lower than your current quote. FiloBook rejects any re-quote that is not lower.

It re-quotes each order at most once per cron run. It also skips orders it quoted earlier in the same run. Two providers undercutting each other will step down once a minute until one of them reaches its floor or the order closes.

### When does a quote count?

FiloBook marks a quote as verified only if all 5 checks pass:

1. The price is at or below the order's max.
2. Your provider is active.
3. Your provider serves the order's type.
4. The quote has not expired.
5. Your `endpoint_url` is reachable. FiloBook makes one GET with a 3 second timeout and no redirects. Any status below 500, or 402, passes.

Only the cheapest verified quote can fill. A quote that fails a check is still recorded, and the Worker logs which check failed.

### Rule fields

| field | meaning |
|---|---|
| `price` | The price you normally quote, as a decimal USDG string. |
| `floor` | The lowest price you will ever quote. Must be at or below `price`. |
| `undercut.step` | Optional. Go `step` under a lower visible quote, and enable repricing. |
| `ttl_s` | Optional. Quote lifetime in seconds, 10 to 3600. FiloBook's default is 60. |
| `private` | Optional. Hide your price from other providers until the order closes. |

A rule with a mistake (for example a floor above the price) is never used. The Worker logs `rules.invalid` and skips orders of that type.

## Errors the Worker handles

| FiloBook answer | what the Worker does |
|---|---|
| `409 requote_not_lower` | Marks the order as quoted. |
| `409 order_not_open` | Marks the order and moves on. |
| `403 own_order` | Marks the order and moves on. You cannot quote your own order. |
| `403 not_eligible` | Marks the order and moves on. The order's conditions exclude you. |
| `429 rate_limited` | Stops this run. The rest is tried next minute. |
| `401`, `403 provider_required` | Stops this run. Check your API key and registration. |
| `5xx`, timeout, network error | Moves on to the next order and retries this one next minute. |

## Limits

- FiloBook allows 60 quotes a minute per wallet. `LIMITS` in `src/rules.ts` caps how many quotes (`maxQuotesPerRun`) and re-quotes (`maxRepricesPerRun`) one run may post. Workers also limit how many outbound requests one invocation can make, and the limit depends on your plan. Keep these caps low.
- The webhook carries the order as it was when posted, usually with no `best_quote` yet. So a first quote sent from a webhook is usually your rule `price`. With `undercut` set, repricing handles the rest on the next cron runs.
- `best_quote` does not include other providers' private quotes while an order is open. The Worker cannot undercut what it cannot see.
- The first cron run has no cursor. It reads the newest open orders, then continues from there.
- Each quote and each new cursor is one KV write. Check that your Cloudflare plan's KV write limit fits your order volume.

## About `src/filobook/`

That folder mirrors a few small pieces of the FiloBook TypeScript SDK (types, price parsing, webhook verification and a minimal API client). `@filobook/sdk` is not on npm yet. Once it is published, this folder will be replaced by the package.

## License

MIT. See [LICENSE](LICENSE).
