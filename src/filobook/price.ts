// Mirrors filobook-sdk (typescript/src/protocol.ts): price parsing and formatting.
// This folder will be replaced by the @filobook/sdk package once it is published to npm.
//
// Prices travel as decimal USDG strings. Inside the kit they are integers in micro-USDG. Never use floats.

/** 1 USDG = 1,000,000 micro-USDG. */
export const UNIT = 1_000_000;
/** Largest price the API accepts, in micro-USDG (1,000,000 USDG). */
export const MAX_PRICE_MICRO = 1_000_000 * UNIT;

/** "0.0042" → 4200. null unless it is a positive decimal with at most 7 integer digits and 6 decimals, ≤ 1,000,000. */
export function parsePrice(text: string): number | null {
	if (typeof text !== "string") return null;
	const m = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(text.trim());
	if (!m) return null;
	const micro = Number(m[1]) * UNIT + Number((m[2] ?? "").padEnd(6, "0"));
	if (micro <= 0 || micro > MAX_PRICE_MICRO) return null;
	return micro;
}

/** 4200 → "0.0042". Exact; trailing zeros dropped. */
export function formatMicro(micro: number): string {
	const sign = micro < 0 ? "-" : "";
	const abs = Math.abs(Math.trunc(micro));
	const whole = Math.floor(abs / UNIT);
	const frac = String(abs % UNIT).padStart(6, "0").replace(/0+$/, "");
	return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}
