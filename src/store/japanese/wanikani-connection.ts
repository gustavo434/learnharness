// Adapted from gustavo434/learn (61df62e). Keep API behavior and fixtures together.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { buildWaniKaniContext, isWaniKaniCache, syncWaniKani, type WaniKaniCache } from "./wanikani.ts";

export interface WaniKaniConnectionOptions {
	cwd: string;
	credentialsDir: string;
	cacheDir?: string;
	fetch?: typeof fetch;
	now?: () => Date;
	timeoutMs?: number;
	sync?: typeof syncWaniKani;
}

import type { WaniKaniStatus } from "../../core/japanese.ts";
export type { WaniKaniStatus } from "../../core/japanese.ts";

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

async function readJson(path: string): Promise<unknown> {
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const temporary = join(dir, `.${name}.${randomUUID()}.tmp`);
	const file = await open(temporary, "wx", 0o600);
	try {
		try {
			await file.writeFile(JSON.stringify(value));
			await file.sync();
		} finally { await file.close(); }
		await rename(temporary, join(dir, name));
	} catch (error) {
		await unlink(temporary).catch(() => {});
		throw error;
	}
}

function safeFailure(error: unknown): string {
	const code = (error as { code?: string })?.code;
	if (code === "authentication") return "WaniKani rejected the API token. Replace it in Settings → Japanese.";
	if (code === "rate_limit") return "WaniKani is rate limiting requests. Try refreshing later.";
	if (code === "timeout") return "WaniKani did not respond in time.";
	if (code === "network") return "WaniKani could not be reached.";
	if (code === "invalid_response") return "WaniKani returned data that could not be read.";
	return "The WaniKani connection could not be saved or refreshed.";
}

/** A private credential and a token-bound, replaceable project cache; neither is tutor evidence. */
export class WaniKaniConnection {
	private token?: string;
	private cache?: WaniKaniCache;
	private stale = false;
	private message?: string;
	private initialized?: Promise<void>;
	private pending: Promise<void> = Promise.resolve();
	private generation = 0;
	private readonly cacheDir: string;

	constructor(private readonly options: WaniKaniConnectionOptions) {
		this.cacheDir = options.cacheDir ?? join(options.cwd, ".memory", "wanikani");
	}

	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.pending.then(operation, operation);
		this.pending = result.then(() => {}, () => {});
		return result;
	}

	async initialize(): Promise<void> {
		if (!this.initialized) {
			const generation = this.generation;
			this.initialized = this.serial(async () => {
				try {
					const saved = await readJson(join(this.options.credentialsDir, "credentials.json")) as { version?: unknown; token?: unknown } | undefined;
					if (generation !== this.generation) return;
					if (!saved || saved.token === null) return;
					if (saved.version !== 1 || typeof saved.token !== "string" || !saved.token.trim()) throw new Error("Invalid credential file");
					this.token = saved.token;
					try {
						const envelope = await readJson(join(this.cacheDir, "cache.json")) as { tokenHash?: unknown; cache?: unknown } | undefined;
						if (generation !== this.generation) return;
						if (envelope?.tokenHash === tokenHash(this.token) && isWaniKaniCache(envelope.cache)) {
							this.cache = envelope.cache;
							this.stale = true;
						}
					} catch { /* A broken derived cache is replaced by the next successful sync. */ }
				} catch {
					this.message = "The saved WaniKani connection could not be read. Reconnect in Settings → Japanese.";
				}
			});
		}
		await this.initialized;
	}

	private async fetchCache(token: string, previous?: WaniKaniCache): Promise<WaniKaniCache> {
		return (this.options.sync ?? syncWaniKani)(token, previous, {
			fetch: this.options.fetch, now: this.options.now?.(), timeoutMs: this.options.timeoutMs,
		});
	}

	async refresh(): Promise<WaniKaniStatus> {
		await this.initialize();
		const generation = this.generation;
		return this.serial(async () => {
			if (!this.token || generation !== this.generation) return this.status();
			const token = this.token;
			try {
				const fresh = await this.fetchCache(token, this.cache);
				if (generation !== this.generation) return this.status();
				this.cache = fresh;
				this.stale = false;
				this.message = undefined;
				try { await writeJson(this.cacheDir, "cache.json", { tokenHash: tokenHash(token), cache: fresh }); }
				catch { if (generation === this.generation) this.message = "Progress refreshed, but the offline WaniKani cache could not be saved."; }
			} catch (error) {
				if (generation !== this.generation) return this.status();
				this.message = safeFailure(error);
				this.stale = Boolean(this.cache);
				if ((error as { code?: string })?.code === "authentication") {
					this.cache = undefined;
					this.stale = false;
					try { await writeJson(this.cacheDir, "cache.json", { tokenHash: tokenHash(token), cache: null }); } catch { /* Context remains disabled if cache invalidation cannot be persisted. */ }
				}
			}
			return this.status();
		});
	}

	async connect(value: string): Promise<WaniKaniStatus> {
		const token = value.trim();
		if (!token || token.length > 512 || /\s|[\u0000-\u001f\u007f-\u009f]/u.test(token)) {
			this.message = "Enter a valid WaniKani personal API token in the masked prompt.";
			return this.status();
		}
		const generation = ++this.generation;
		await this.initialize();
		return this.serial(async () => {
			if (generation !== this.generation) return this.status();
			try {
				const fresh = await this.fetchCache(token, token === this.token ? this.cache : undefined);
				if (generation !== this.generation) return this.status();
				await writeJson(this.options.credentialsDir, "credentials.json", { version: 1, token });
				if (generation !== this.generation) return this.status();
				this.token = token;
				this.cache = fresh;
				this.stale = false;
				this.message = undefined;
				try { await writeJson(this.cacheDir, "cache.json", { tokenHash: tokenHash(token), cache: fresh }); }
				catch { this.message = "Connected, but the offline WaniKani cache could not be saved."; }
			} catch (error) {
				if (generation === this.generation) this.message = safeFailure(error);
			}
			return this.status();
		});
	}

	async disconnect(): Promise<WaniKaniStatus> {
		++this.generation;
		this.token = undefined;
		this.cache = undefined;
		this.stale = false;
		this.message = undefined;
		await this.serial(async () => {
			try {
				await writeJson(this.options.credentialsDir, "credentials.json", { version: 1, token: null });
				await writeJson(this.cacheDir, "cache.json", { cache: null });
			} catch {
				this.message = "Disconnected for this run, but clearing the saved connection failed. Reconnect or disconnect again before closing the app.";
			}
		});
		return this.status();
	}

	status(): WaniKaniStatus {
		return {
			connected: Boolean(this.token),
			state: !this.token ? "disconnected" : !this.cache ? "unavailable" : this.stale ? "stale" : "ready",
			syncedAt: this.cache?.syncedAt, level: this.cache?.user.level, message: this.message,
			activeItemCount: this.cache?.assignments.length, mistakeSignalCount: this.cache?.mistakes.length,
		};
	}

	context(): string | undefined {
		return this.token && this.cache ? buildWaniKaniContext(this.cache, { stale: this.stale, now: this.options.now?.() }) : undefined;
	}
}
