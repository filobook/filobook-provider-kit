import { describe, expect, it } from "vitest";
import { WebhookError, signWebhook, verifyWebhook } from "../src/filobook/webhook";
import vectors from "./fixtures/webhook-vectors.json";

describe("webhook signature vectors", () => {
	for (const v of vectors.sign) {
		it(`signs ${v.body.slice(0, 40)}…`, async () => {
			expect(await signWebhook(vectors.secret, v.timestamp, v.body)).toBe(v.signature);
		});
	}

	for (const v of vectors.verify) {
		it(`verify: ${v.name}`, async () => {
			const run = verifyWebhook({ secret: vectors.secret, body: v.body, timestamp: v.timestamp, signature: v.signature, now: v.now, toleranceS: v.tolerance_s });
			if (v.ok) {
				await expect(run).resolves.toEqual(JSON.parse(v.body));
			} else {
				await expect(run).rejects.toBeInstanceOf(WebhookError);
				await expect(run).rejects.toMatchObject({ code: v.error });
			}
		});
	}

	it("accepts the body as bytes", async () => {
		const v = vectors.verify[0];
		const bytes = new TextEncoder().encode(v.body);
		await expect(verifyWebhook({ secret: vectors.secret, body: bytes, timestamp: v.timestamp, signature: v.signature, now: v.now })).resolves.toMatchObject({ event: "orders.created" });
	});

	it("rejects a correctly signed body that is not JSON", async () => {
		const sig = await signWebhook(vectors.secret, "1767225600", "not json");
		await expect(verifyWebhook({ secret: vectors.secret, body: "not json", timestamp: "1767225600", signature: sig, now: 1767225600 })).rejects.toMatchObject({ code: "malformed" });
	});
});
