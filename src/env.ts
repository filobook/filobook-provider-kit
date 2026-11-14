// Read the kit's settings from environment variables. Every runtime entry uses this, so the names are the same
// everywhere.

import { DEFAULT_BASE_URL } from "./filobook/client";
import type { ProviderConfig } from "./provider";

export type EnvVars = {
	/** Secret: an API key (fb_live_…) from the dapp's API keys page, created by your provider wallet. */
	FILOBOOK_API_KEY?: string;
	/** Secret: your provider's webhook signing secret (whsec_…), printed by scripts/register.mjs. */
	WEBHOOK_SECRET?: string;
	/** FiloBook API base URL. Defaults to https://dapp.filobook.run. */
	FILOBOOK_BASE_URL?: string;
	/** Optional secret that turns on GET|POST /tick for HTTP cron services. */
	TICK_SECRET?: string;
};

export function configFromEnv(env: EnvVars): Omit<ProviderConfig, "store"> {
	return {
		apiKey: env.FILOBOOK_API_KEY || undefined,
		webhookSecret: env.WEBHOOK_SECRET || undefined,
		baseUrl: env.FILOBOOK_BASE_URL || DEFAULT_BASE_URL,
		tickSecret: env.TICK_SECRET || undefined,
	};
}
