// Use the kit inside your own server or framework: build a provider, mount provider.fetch on any route that
// speaks the Fetch API, and call provider.tick() about once a minute.
//
//   import { createProvider, MemoryStore } from "./src";
//   const provider = createProvider({ apiKey, webhookSecret, store: new MemoryStore() });

export { createProvider, type HandleOptions, type Provider, type ProviderConfig, type TickResult } from "./provider";
export { configFromEnv, type EnvVars } from "./env";
export { MemoryStore, type Store } from "./store";
export { RULES, LIMITS, type Rule, type Rules } from "./rules";
export type { Logger, Outcome, RunResult } from "./quoter";
