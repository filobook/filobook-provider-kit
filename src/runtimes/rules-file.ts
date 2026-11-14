// Price rules from outside the build, for the prebuilt Docker image and the standalone server:
//
//   RULES_FILE  path to a JSON file, e.g. /config/rules.json
//   RULES_JSON  the same JSON inline, for hosts where mounting a file is awkward
//
// The JSON has the same shape as RULES in src/rules.ts:
//   { "web_search": { "price": "0.04", "floor": "0.025" }, "scraping": { "price": "0.08", "floor": "0.05", "undercut": { "step": "0.001" } } }
//
// Neither set: the RULES compiled into src/rules.ts are used. A bad file stops the server at start-up instead of
// quoting with wrong prices.

import { readFileSync } from "node:fs";
import { REQUEST_TYPES, type RequestType } from "../filobook/types";
import { validateRules, type Rules } from "../rules";

export class RulesError extends Error {}

export function parseRules(text: string, source: string): Rules {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (e) {
		throw new RulesError(`${source} is not valid JSON: ${(e as Error).message}`);
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new RulesError(`${source} must be a JSON object keyed by request type`);
	const unknownTypes = Object.keys(data).filter((k) => !REQUEST_TYPES.includes(k as RequestType));
	if (unknownTypes.length) throw new RulesError(`${source}: unknown request type(s) ${unknownTypes.join(", ")}. Valid: ${REQUEST_TYPES.join(", ")}`);
	for (const [type, rule] of Object.entries(data)) {
		if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new RulesError(`${source}: ${type} must be an object like { "price": "0.04", "floor": "0.025" }`);
		const r = rule as Record<string, unknown>;
		if (typeof r.price !== "string" || typeof r.floor !== "string") throw new RulesError(`${source}: ${type}.price and ${type}.floor must be strings like "0.04"`);
	}
	const rules = data as Rules;
	const problems = validateRules(rules);
	if (problems.length) throw new RulesError(`${source}: ${problems.join("; ")}`);
	if (!Object.keys(rules).length) throw new RulesError(`${source} has no rules, so nothing would ever be quoted`);
	return rules;
}

/** Rules from RULES_JSON or RULES_FILE, or undefined when neither is set. Throws RulesError on a bad value. */
export function loadRules(env: { RULES_FILE?: string; RULES_JSON?: string }, read: (path: string) => string = (p) => readFileSync(p, "utf8")): Rules | undefined {
	if (env.RULES_JSON) return parseRules(env.RULES_JSON, "RULES_JSON");
	if (env.RULES_FILE) {
		let text: string;
		try {
			text = read(env.RULES_FILE);
		} catch (e) {
			throw new RulesError(`cannot read RULES_FILE ${env.RULES_FILE}: ${(e as Error).message}`);
		}
		return parseRules(text, `RULES_FILE ${env.RULES_FILE}`);
	}
	return undefined;
}
