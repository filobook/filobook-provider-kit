// Mirrors filobook-sdk (typescript/src/client.ts + errors.ts), cut down to the calls a provider needs.
// This folder will be replaced by the @filobook/sdk package once it is published to npm.

import type { Order, Provider, ProviderMe, Quote, QuoteInput } from "./types";

export const DEFAULT_BASE_URL = "https://dapp.filobook.run";
export const USER_AGENT = "filobook-provider-kit/0.3.1";

/** Any non-2xx answer from the API. `code` is the API's machine-readable error, e.g. "rate_limited". */
export class FiloBookError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "FiloBookError";
		this.status = status;
		this.code = code;
	}
}

export type ClientOptions = {
	/** An API key (fb_live_…), created in the dapp under API keys. It acts as the wallet that created it. */
	apiKey?: string;
	baseUrl?: string;
	/** Per-request timeout in ms (default 10000). */
	timeoutMs?: number;
	fetch?: typeof fetch;
};

type Query = Record<string, string | number | undefined | null>;

export class FiloBook {
	readonly baseUrl: string;
	private readonly apiKey?: string;
	private readonly timeoutMs: number;
	private readonly fetcher: typeof fetch;

	constructor(opts: ClientOptions = {}) {
		this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.apiKey = opts.apiKey;
		this.timeoutMs = opts.timeoutMs ?? 10_000;
		// Resolve fetch lazily so tests can stub the global after the client is built.
		this.fetcher = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
	}

	private async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
		const url = new URL(this.baseUrl + path);
		for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
		const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT };
		if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
		if (opts.body !== undefined) headers["content-type"] = "application/json";
		const res = await this.fetcher(url.toString(), {
			method,
			headers,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		const text = await res.text();
		let data: unknown = null;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			/* not JSON */
		}
		if (!res.ok) {
			const err = (data ?? {}) as { error?: string; message?: string };
			throw new FiloBookError(res.status, err.error ?? "http_error", err.message ?? `HTTP ${res.status}`);
		}
		return data as T;
	}

	async providers() {
		return (await this.request<{ providers: Provider[] }>("GET", "/v1/providers")).providers;
	}
	myProvider() {
		return this.request<ProviderMe>("GET", "/v1/providers/me");
	}
	/**
	 * Open orders you can quote. With `since` (the cursor from the previous call), only newer orders, oldest
	 * first; without it, newest first.
	 */
	feed(opts: { since?: string | null; limit?: number } = {}) {
		return this.request<{ orders: Order[]; cursor: string | null }>("GET", "/v1/feed", { query: opts });
	}
	/** Quote on an order. A re-quote must be strictly lower than your current verified quote. */
	quote(orderId: string, input: QuoteInput) {
		return this.request<Quote>("POST", `/v1/orders/${encodeURIComponent(orderId)}/quotes`, { body: input });
	}
	/** Your quotes, newest first. */
	async myQuotes(opts: { limit?: number } = {}) {
		return (await this.request<{ quotes: Quote[] }>("GET", "/v1/me/quotes", { query: opts })).quotes;
	}
}
