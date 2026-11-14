// Serve a provider with node:http and run tick() on a timer. node:http is also available in Bun and Deno, so
// this one file covers all three.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Provider } from "../provider";

/** Webhook deliveries are small. Anything bigger is refused with 413. */
const MAX_BODY_BYTES = 1024 * 1024;

export type ServeOptions = {
	port?: number;
	host?: string;
	/** Seconds between ticks. 0 turns the timer off (for example when an outside cron calls /tick). Default 60. */
	tickIntervalS?: number;
	log?: (event: string, data?: Record<string, unknown>) => void;
};

async function toRequest(req: IncomingMessage): Promise<Request | null> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) return null;
		chunks.push(chunk);
	}
	const headers = new Headers();
	for (const [k, v] of Object.entries(req.headers)) {
		if (Array.isArray(v)) for (const item of v) headers.append(k, item);
		else if (v !== undefined) headers.set(k, v);
	}
	const method = req.method ?? "GET";
	// Only the path matters to the provider, so a fixed origin avoids trusting the Host header.
	return new Request(new URL(req.url ?? "/", "http://localhost"), {
		method,
		headers,
		body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
	});
}

async function send(res: ServerResponse, response: Response) {
	res.statusCode = response.status;
	response.headers.forEach((value, key) => res.setHeader(key, value));
	res.end(Buffer.from(await response.arrayBuffer()));
}

export async function serve(provider: Provider, opts: ServeOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
	const log = opts.log ?? ((event, data) => console.log(JSON.stringify({ event, ...data })));
	const server = createServer(async (req, res) => {
		try {
			const request = await toRequest(req);
			if (!request) {
				res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "payload_too_large" }));
				req.destroy();
				return;
			}
			await send(res, await provider.fetch(request));
		} catch (e) {
			log("server.error", { message: (e as Error)?.message ?? String(e) });
			if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "internal" }));
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.port ?? 8787, opts.host ?? "0.0.0.0", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	const url = `http://${opts.host === "0.0.0.0" || !opts.host ? "localhost" : opts.host}:${port}`;

	const intervalS = opts.tickIntervalS ?? 60;
	let timer: ReturnType<typeof setInterval> | undefined;
	if (intervalS > 0) {
		void provider.tick();
		timer = setInterval(() => void provider.tick(), intervalS * 1000);
	}
	log("server.listening", { url, tick_interval_s: intervalS });

	return {
		url,
		close: () =>
			new Promise<void>((resolve) => {
				if (timer) clearInterval(timer);
				server.close(() => resolve());
				server.closeAllConnections?.();
			}),
	};
}
