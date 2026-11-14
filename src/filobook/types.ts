// Mirrors filobook-sdk (typescript/src/types.ts). Only the shapes this kit uses.
// This folder will be replaced by the @filobook/sdk package once it is published to npm.
//
// API shapes, as returned by https://dapp.filobook.run. Prices are decimal USDG strings ("0.0042").

export const REQUEST_TYPES = [
	"market_data",
	"web_search",
	"scraping",
	"inference",
	"compute",
	"dataset",
	"image",
	"storage",
	"translation",
	"speech",
	"tool",
	"other",
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export type OrderStatus = "open" | "filled" | "expired" | "cancelled";
export type QuoteStatus = "verified" | "failed" | "expired" | "replaced" | "won";
export type CloseReason = "min_quotes" | "no_quote";
export type CheckName = "price_within_max" | "provider_active" | "serves_type" | "quote_not_expired" | "endpoint_reachable";
export type Check = { name: CheckName; ok: boolean; detail: string };

export type Conditions = {
	min_quotes?: number;
	min_provider_wins?: number;
	providers?: string[];
	instant_fill_at?: string;
};

export type Order = {
	id: string;
	agent: string;
	request: string;
	type: RequestType;
	max_price: string;
	rule: string | null;
	status: OrderStatus;
	quote_count: number;
	/** Best verified price this viewer may see (private quotes from others are hidden while the order is open). */
	best_quote: string | null;
	private_quotes: number;
	conditions: Conditions | null;
	batch_id: string | null;
	close_reason: CloseReason | null;
	created_at: string;
	closes_at: string;
};

export type Quote = {
	id: string;
	order_id: string;
	provider_id: string;
	provider_name: string;
	/** null while the quote is private and hidden from this viewer. */
	price: string | null;
	private: boolean;
	status: QuoteStatus;
	verification: { checks: Check[] };
	created_at: string;
	expires_at: string;
};

export type Provider = { id: string; name: string; address: string; endpoint_url: string; types: RequestType[]; active: boolean; quotes_won: number; created_at: string };

/** The provider's own view. The webhook secret is only ever shown to its owner. */
export type ProviderMe = Provider & { webhook_url: string | null; webhook_secret: string | null; webhook_status: string | null; webhook_at: string | null };

/** Body of a feed webhook (POST to the provider's webhook_url). */
export type FeedEvent = { event: "orders.created" | "test"; sent_at: string; orders: Order[] };

export type QuoteInput = {
	price: string;
	/** Quote lifetime in seconds (10–3600, default 60). */
	ttl_s?: number;
	/** Hide the price from everyone but the agent until the order closes. */
	private?: boolean;
};
