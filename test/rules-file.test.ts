import { describe, expect, it } from "vitest";
import { loadRules, parseRules, RulesError } from "../src/runtimes/rules-file";

describe("RULES_FILE / RULES_JSON", () => {
	it("returns undefined when neither is set, so the compiled RULES are used", () => {
		expect(loadRules({})).toBeUndefined();
	});

	it("reads rules from RULES_JSON", () => {
		const rules = loadRules({ RULES_JSON: '{"web_search":{"price":"0.04","floor":"0.025"}}' });
		expect(rules).toEqual({ web_search: { price: "0.04", floor: "0.025" } });
	});

	it("prefers RULES_JSON over RULES_FILE", () => {
		const read = () => '{"scraping":{"price":"0.08","floor":"0.05"}}';
		expect(loadRules({ RULES_JSON: '{"web_search":{"price":"0.04","floor":"0.025"}}', RULES_FILE: "/x.json" }, read)).toHaveProperty("web_search");
	});

	it("reads rules from RULES_FILE", () => {
		const read = (p: string) => {
			expect(p).toBe("/config/rules.json");
			return '{"scraping":{"price":"0.08","floor":"0.05","undercut":{"step":"0.001"},"ttl_s":120}}';
		};
		expect(loadRules({ RULES_FILE: "/config/rules.json" }, read)).toEqual({ scraping: { price: "0.08", floor: "0.05", undercut: { step: "0.001" }, ttl_s: 120 } });
	});

	it("reports an unreadable file", () => {
		const read = () => {
			throw new Error("ENOENT");
		};
		expect(() => loadRules({ RULES_FILE: "/missing.json" }, read)).toThrow(/cannot read RULES_FILE/);
	});

	it.each([
		["not json", "{", /not valid JSON/],
		["an array", "[]", /JSON object/],
		["an unknown type", '{"websearch":{"price":"0.04","floor":"0.02"}}', /unknown request type/],
		["a number price", '{"web_search":{"price":0.04,"floor":"0.02"}}', /must be strings/],
		["floor above price", '{"web_search":{"price":"0.02","floor":"0.04"}}', /above price/],
		["no rules", "{}", /no rules/],
	])("rejects %s", (_name, text, message) => {
		expect(() => parseRules(text, "RULES_JSON")).toThrow(RulesError);
		expect(() => parseRules(text, "RULES_JSON")).toThrow(message);
	});
});
