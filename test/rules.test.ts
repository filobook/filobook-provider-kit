import { describe, expect, it } from "vitest";
import { formatMicro, parsePrice } from "../src/filobook/price";
import { RULES, compileRule, decide, decideReprice, quoteOptions, validateRules, type Rule } from "../src/rules";

const o = (max_price: string, best_quote: string | null = null) => ({ max_price, best_quote });

describe("price math", () => {
	it("parses and formats exactly", () => {
		expect(parsePrice("0.0042")).toBe(4200);
		expect(parsePrice(" 1 ")).toBe(1_000_000);
		expect(parsePrice("0")).toBeNull();
		expect(parsePrice("0.0000001")).toBeNull();
		expect(parsePrice("-1")).toBeNull();
		expect(parsePrice("1e-3")).toBeNull();
		expect(formatMicro(4200)).toBe("0.0042");
		expect(formatMicro(1_000_000)).toBe("1");
		expect(formatMicro(1)).toBe("0.000001");
	});
});

describe("compileRule / validateRules", () => {
	it("accepts the shipped example rules", () => {
		expect(validateRules(RULES)).toEqual([]);
	});
	it("rejects bad rules", () => {
		expect(compileRule({ price: "abc", floor: "0.01" })).toHaveProperty("error");
		expect(compileRule({ price: "0.01", floor: "0" })).toHaveProperty("error");
		expect(compileRule({ price: "0.01", floor: "0.02" })).toHaveProperty("error");
		expect(compileRule({ price: "0.02", floor: "0.01", undercut: { step: "0" } })).toHaveProperty("error");
		expect(compileRule({ price: "0.02", floor: "0.01", ttl_s: 9 })).toHaveProperty("error");
		expect(compileRule({ price: "0.02", floor: "0.01", ttl_s: 3601 })).toHaveProperty("error");
		expect(compileRule({ price: "0.02", floor: "0.01", ttl_s: 1.5 })).toHaveProperty("error");
		expect(validateRules({ web_search: { price: "0.01", floor: "0.02" } })).toEqual(["web_search: floor 0.02 is above price 0.01"]);
	});
	it("compiles to micro-USDG", () => {
		expect(compileRule({ price: "0.04", floor: "0.025", undercut: { step: "0.001" }, ttl_s: 120 })).toEqual({
			rule: { price: 40_000, floor: 25_000, step: 1_000, ttl_s: 120, private: undefined },
		});
	});
	it("quoteOptions only includes fields that are set", () => {
		expect(quoteOptions({ price: "1", floor: "1" })).toEqual({});
		expect(quoteOptions({ price: "1", floor: "1", ttl_s: 30, private: true })).toEqual({ ttl_s: 30, private: true });
	});
});

describe("decide", () => {
	const plain: Rule = { price: "0.04", floor: "0.025" };
	const undercut: Rule = { price: "0.04", floor: "0.025", undercut: { step: "0.001" } };

	it("skips types without a rule", () => {
		expect(decide(o("0.05"), undefined)).toEqual({ skip: "no_rule" });
	});
	it("skips invalid rules instead of quoting", () => {
		expect(decide(o("0.05"), { price: "0.01", floor: "0.02" })).toMatchObject({ skip: "invalid_rule" });
	});
	it("skips orders with an unreadable max_price", () => {
		expect(decide(o("lots"), plain)).toMatchObject({ skip: "invalid_order" });
	});
	it("quotes the rule price when it fits under the max", () => {
		expect(decide(o("0.05"), plain)).toEqual({ price: "0.04" });
	});
	it("quotes exactly at the max", () => {
		expect(decide(o("0.04"), plain)).toEqual({ price: "0.04" });
	});
	it("never quotes above the max", () => {
		expect(decide(o("0.039999"), plain)).toMatchObject({ skip: "above_max" });
	});
	it("without undercut, ignores a lower best quote", () => {
		expect(decide(o("0.05", "0.03"), plain)).toEqual({ price: "0.04" });
	});
	it("with undercut and a lower visible best, quotes best - step", () => {
		expect(decide(o("0.05", "0.035"), undercut)).toEqual({ price: "0.034" });
	});
	it("with undercut and no best quote, quotes the rule price", () => {
		expect(decide(o("0.05", null), undercut)).toEqual({ price: "0.04" });
	});
	it("with undercut and a best quote at or above price, quotes the rule price", () => {
		expect(decide(o("0.05", "0.04"), undercut)).toEqual({ price: "0.04" });
		expect(decide(o("0.05", "0.045"), undercut)).toEqual({ price: "0.04" });
	});
	it("undercut lets a too-high price fit under the max", () => {
		// price 0.04 is above max 0.038, but best 0.036 - 0.001 = 0.035 fits.
		expect(decide(o("0.038", "0.036"), undercut)).toEqual({ price: "0.035" });
	});
	it("skips when undercutting would go below the floor", () => {
		expect(decide(o("0.05", "0.0255"), undercut)).toMatchObject({ skip: "below_floor" });
	});
	it("quotes exactly at the floor", () => {
		expect(decide(o("0.05", "0.026"), undercut)).toEqual({ price: "0.025" });
	});
	it("does integer math where floats would drift", () => {
		// 0.3 - 0.1 in floating point is 0.19999999999999998.
		const r: Rule = { price: "0.5", floor: "0.1", undercut: { step: "0.1" } };
		expect(decide(o("1", "0.3"), r)).toEqual({ price: "0.2" });
		const tiny: Rule = { price: "0.00001", floor: "0.000001", undercut: { step: "0.000001" } };
		expect(decide(o("1", "0.000003"), tiny)).toEqual({ price: "0.000002" });
		expect(decide(o("1", "0.000001"), tiny)).toMatchObject({ skip: "below_floor" });
	});
});

describe("decideReprice", () => {
	const undercut: Rule = { price: "0.04", floor: "0.025", undercut: { step: "0.001" } };

	it("needs an undercut rule", () => {
		expect(decideReprice(o("0.05", "0.03"), undefined, "0.04")).toEqual({ skip: "no_rule" });
		expect(decideReprice(o("0.05", "0.03"), { price: "0.04", floor: "0.025" }, "0.04")).toEqual({ skip: "no_undercut" });
	});
	it("needs a visible best quote strictly below yours", () => {
		expect(decideReprice(o("0.05", null), undercut, "0.04")).toEqual({ skip: "no_best_quote" });
		expect(decideReprice(o("0.05", "0.04"), undercut, "0.04")).toEqual({ skip: "not_beaten" });
		expect(decideReprice(o("0.05", "0.041"), undercut, "0.04")).toEqual({ skip: "not_beaten" });
	});
	it("re-quotes best - step", () => {
		expect(decideReprice(o("0.05", "0.035"), undercut, "0.04")).toEqual({ price: "0.034" });
	});
	it("stops at the floor", () => {
		expect(decideReprice(o("0.05", "0.026"), undercut, "0.03")).toEqual({ price: "0.025" });
		expect(decideReprice(o("0.05", "0.0259"), undercut, "0.03")).toMatchObject({ skip: "below_floor" });
	});
	it("a step larger than the gap still lands strictly below your quote", () => {
		expect(decideReprice(o("0.05", "0.039999"), undercut, "0.04")).toEqual({ price: "0.038999" });
	});
	it("rejects garbage prices", () => {
		expect(decideReprice(o("0.05", "0.03"), undercut, "nope")).toEqual({ skip: "invalid_order" });
	});
});
