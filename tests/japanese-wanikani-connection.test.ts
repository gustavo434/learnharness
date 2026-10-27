import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WaniKaniConnection } from "../src/store/japanese/wanikani-connection.ts";
import { WaniKaniError, type WaniKaniCache } from "../src/store/japanese/wanikani.ts";

const now = new Date("2026-09-29T12:00:00.000Z");
const fakeToken = "fake-wanikani-test-token-never-real";
function cache(character = "猫", user = "simulated-user"): WaniKaniCache {
	return {
		version: 1, syncedAt: now.toISOString(), user: { id: user, level: 19, maxLevelGranted: 60 },
		assignments: [{ subjectId: 1, type: "kanji", srsStage: 2, startedAt: now.toISOString(), availableAt: now.toISOString() }],
		statistics: [], mistakes: [],
		subjects: [{ id: 1, type: "kanji", characters: character, meanings: ["cat"], readings: ["ねこ"], level: 1, fetchedAt: now.toISOString() }],
	};
}
async function options() {
	const root = await mkdtemp(join(tmpdir(), "learn-wanikani-connection-"));
	return { cwd: root, credentialsDir: join(root, "private"), now: () => now };
}

test("saved token survives a new connection instance and startup fetches fresh data", async () => {
	const opts = await options();
	const first = new WaniKaniConnection({ ...opts, sync: async (token) => { assert.equal(token, fakeToken); return cache(); } });
	assert.equal((await first.connect(fakeToken)).state, "ready");
	assert.match(first.context()!, /猫/);
	const credentialPath = join(opts.credentialsDir, "credentials.json");
	assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
	assert.equal((await stat(opts.credentialsDir)).mode & 0o777, 0o700);
	assert.doesNotMatch(await readFile(join(opts.cwd, ".memory/wanikani/cache.json"), "utf8"), new RegExp(fakeToken));
	assert.doesNotMatch(first.context()!, new RegExp(fakeToken));
	let calls = 0;
	const restarted = new WaniKaniConnection({ ...opts, sync: async (token, previous) => {
		calls++;
		assert.equal(token, fakeToken);
		assert.equal(previous?.subjects[0]?.characters, "猫");
		return cache("犬");
	} });
	await restarted.refresh();
	assert.equal(calls, 1);
	assert.equal(restarted.status().state, "ready");
	assert.match(restarted.context()!, /犬/);
	assert.doesNotMatch(restarted.context()!, /猫/);
});

test("offline startup labels matching cache stale; rejected credentials disable it", async () => {
	const opts = await options();
	await new WaniKaniConnection({ ...opts, sync: async () => cache() }).connect(fakeToken);
	const offline = new WaniKaniConnection({ ...opts, sync: async () => { throw new WaniKaniError("network"); } });
	assert.equal((await offline.refresh()).state, "stale");
	assert.match(offline.context()!, /STALE/);
	const rejected = new WaniKaniConnection({ ...opts, sync: async () => { throw new WaniKaniError("authentication"); } });
	assert.equal((await rejected.refresh()).state, "unavailable");
	assert.equal(rejected.context(), undefined);
	const afterRejection = new WaniKaniConnection({ ...opts, sync: async () => { throw new WaniKaniError("network"); } });
	assert.equal((await afterRejection.refresh()).state, "unavailable");
	assert.equal(afterRejection.context(), undefined);
});

test("a failed credential save leaves no temporary copy of the token", async () => {
	const opts = await options();
	await mkdir(join(opts.credentialsDir, "credentials.json"), { recursive: true });
	const connection = new WaniKaniConnection({ ...opts, sync: async () => cache() });
	const result = await connection.connect(fakeToken);
	assert.equal(result.connected, false);
	assert.match(result.message!, /could not be saved/);
	assert.deepEqual(await readdir(opts.credentialsDir), ["credentials.json"]);
	assert.equal(connection.context(), undefined);
});

test("failed replacement preserves old credentials, while a new account receives no old cache", async () => {
	const opts = await options();
	let reject = false;
	const connection = new WaniKaniConnection({ ...opts, sync: async (token, previous) => {
		if (reject) throw new Error(`Fake failure that includes ${token}`);
		if (token !== fakeToken) { assert.equal(previous, undefined); return cache("鳥", "second-user"); }
		return cache();
	} });
	await connection.connect(fakeToken);
	reject = true;
	const failed = await connection.connect("replacement-secret");
	assert.equal(failed.connected, true);
	assert.doesNotMatch(failed.message!, /replacement-secret/);
	assert.equal(JSON.parse(await readFile(join(opts.credentialsDir, "credentials.json"), "utf8")).token, fakeToken);
	assert.match(connection.context()!, /猫/);
	reject = false;
	await connection.connect("replacement-secret");
	assert.match(connection.context()!, /鳥/);
	assert.doesNotMatch(connection.context()!, /猫/);
});

test("a token changed outside this process cannot reuse another token's cached progress", async () => {
	const opts = await options();
	await new WaniKaniConnection({ ...opts, sync: async () => cache() }).connect(fakeToken);
	await writeFile(join(opts.credentialsDir, "credentials.json"), JSON.stringify({ version: 1, token: "another-account-token" }));
	const switched = new WaniKaniConnection({ ...opts, sync: async (_token, previous) => {
		assert.equal(previous, undefined);
		throw new WaniKaniError("network");
	} });
	assert.equal((await switched.refresh()).state, "unavailable");
	assert.equal(switched.context(), undefined);
});

test("disconnect wins over an in-flight refresh and is remembered by the next process", async () => {
	const opts = await options();
	let resolveSync: ((cache: WaniKaniCache) => void) | undefined;
	let reportStarted!: () => void;
	const started = new Promise<void>((resolve) => { reportStarted = resolve; });
	let waiting = false;
	const connection = new WaniKaniConnection({ ...opts, sync: async () => {
		if (!waiting) return cache();
		reportStarted();
		return new Promise((resolve) => { resolveSync = resolve; });
	} });
	await connection.connect(fakeToken);
	waiting = true;
	const refresh = connection.refresh();
	await started;
	const disconnect = connection.disconnect();
	assert.equal(connection.context(), undefined);
	resolveSync!(cache("犬"));
	await Promise.all([refresh, disconnect]);
	assert.equal(connection.status().connected, false);
	assert.equal(connection.context(), undefined);
	const restarted = new WaniKaniConnection({ ...opts, sync: async () => { throw new Error("Must not fetch without a token"); } });
	assert.equal((await restarted.refresh()).state, "disconnected");
	assert.equal(restarted.context(), undefined);
});

test("disconnect also cancels a connect requested before credential initialization finishes", async () => {
	const opts = await options();
	const connection = new WaniKaniConnection({ ...opts, sync: async () => { throw new Error("Cancelled connect must not fetch"); } });
	const connecting = connection.connect(fakeToken);
	const disconnecting = connection.disconnect();
	await Promise.all([connecting, disconnecting]);
	assert.equal(connection.status().connected, false);
	assert.equal(JSON.parse(await readFile(join(opts.credentialsDir, "credentials.json"), "utf8")).token, null);
});

test("a corrupt derived cache is replaced without exposing any credential errors", async () => {
	const opts = await options();
	await new WaniKaniConnection({ ...opts, sync: async () => cache() }).connect(fakeToken);
	await writeFile(join(opts.cwd, ".memory/wanikani/cache.json"), "not-json");
	const restarted = new WaniKaniConnection({ ...opts, sync: async (_token, previous) => {
		assert.equal(previous, undefined);
		return cache("犬");
	} });
	assert.equal((await restarted.refresh()).state, "ready");
	assert.match(restarted.context()!, /犬/);
});
