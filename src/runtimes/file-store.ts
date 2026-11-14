// A Store backed by one JSON file. Uses node:fs, which Node, Bun and Deno all provide. Good for a single
// process on a VPS or in a container with a volume. For several replicas, use a shared store (Redis, a database).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Store } from "../store";

type Entry = { v: string; e?: number };

export class FileStore implements Store {
	private data: Map<string, Entry> | null = null;
	private loading: Promise<Map<string, Entry>> | null = null;
	private writing: Promise<void> = Promise.resolve();

	constructor(
		readonly path: string,
		private readonly now: () => number = Date.now,
	) {}

	private load(): Promise<Map<string, Entry>> {
		if (this.data) return Promise.resolve(this.data);
		this.loading ??= (async () => {
			const map = new Map<string, Entry>();
			try {
				const parsed = JSON.parse(await readFile(this.path, "utf8")) as Record<string, Entry>;
				for (const [k, entry] of Object.entries(parsed)) if (typeof entry?.v === "string") map.set(k, entry);
			} catch (e) {
				if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
			}
			this.data = map;
			return map;
		})();
		return this.loading;
	}

	async get(key: string): Promise<string | null> {
		const data = await this.load();
		const entry = data.get(key);
		if (!entry) return null;
		if (entry.e !== undefined && entry.e <= this.now()) return null;
		return entry.v;
	}

	async put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void> {
		const data = await this.load();
		data.set(key, opts?.ttlSeconds ? { v: value, e: this.now() + opts.ttlSeconds * 1000 } : { v: value });
		await this.flush(data);
	}

	/** Writes are queued so they never interleave; each one replaces the file atomically (write + rename). */
	private flush(data: Map<string, Entry>): Promise<void> {
		const write = async () => {
			const now = this.now();
			for (const [k, entry] of data) if (entry.e !== undefined && entry.e <= now) data.delete(k);
			await mkdir(dirname(this.path), { recursive: true });
			const tmp = `${this.path}.tmp`;
			await writeFile(tmp, JSON.stringify(Object.fromEntries(data)), { mode: 0o600 });
			await rename(tmp, this.path);
		};
		this.writing = this.writing.catch(() => {}).then(write);
		return this.writing;
	}
}
