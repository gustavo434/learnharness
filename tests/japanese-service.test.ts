import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJapaneseService, japaneseResponse } from "../src/server/japanese.ts";
import { createJapaneseSettingsStore } from "../src/store/japanese/settings.ts";
import { WaniKaniConnection } from "../src/store/japanese/wanikani-connection.ts";
import { WaniKaniError, type WaniKaniCache } from "../src/store/japanese/wanikani.ts";
import { DEFAULT_JAPANESE_SETTINGS, parseJapaneseSettings } from "../src/core/japanese.ts";

const token = "fake-japanese-service-token";
const stamp = new Date("2026-10-27T12:00:00Z");
const cache = (characters: string): WaniKaniCache => ({
	version: 1, syncedAt: stamp.toISOString(), user: { id: "fixture", level: 19, maxLevelGranted: 60 },
	assignments: [{ subjectId: 1, type: "vocabulary", srsStage: 2, startedAt: stamp.toISOString(), availableAt: stamp.toISOString() }],
	statistics: [], mistakes: [], subjects: [{ id: 1, type: "vocabulary", characters, meanings: ["stop by"], readings: ["よる"], level: 1, fetchedAt: stamp.toISOString() }],
});

test("Japanese preferences default on, survive restart separately, and reject invalid/corrupt records", async () => {
	const directory = await mkdtemp(join(tmpdir(), "lh-japanese-settings-"));
	const store = createJapaneseSettingsStore(directory);
	assert.deepEqual(store.read(), DEFAULT_JAPANESE_SETTINGS);
	store.write({ enabled: false, defaultMinutes: 15, interests: [" ゲーム "] });
	assert.deepEqual(createJapaneseSettingsStore(directory).read(), { enabled: false, defaultMinutes: 15, interests: ["ゲーム"] });
	for (const value of [null, { ...DEFAULT_JAPANESE_SETTINGS, defaultMinutes: 0 }, { ...DEFAULT_JAPANESE_SETTINGS, interests: [null] }, { ...DEFAULT_JAPANESE_SETTINGS, token: "do-not-save" }]) assert.throws(() => parseJapaneseSettings(value));
	await writeFile(join(directory, "settings.json"), "broken");
	assert.throws(() => store.read(), /could not be read/);
	assert.equal(await readFile(join(directory, "settings.json"), "utf8"), "broken");
});

test("service refreshes once across concurrent lesson agents, renews context, survives restart, and disconnects", async () => {
	const directory = await mkdtemp(join(tmpdir(), "lh-japanese-service-"));
	const settings = createJapaneseSettingsStore(join(directory, "preferences"));
	let count = 0;
	let clock = 0;
	let word = "寄る";
	let offline = false;
	const options = { cwd: directory, credentialsDir: join(directory, "private"), cacheDir: join(directory, "cache"), now: () => stamp,
		sync: async (secret: string) => { assert.equal(secret, token); count++; if (offline) throw new WaniKaniError("network"); return cache(word); } };
	const connection = new WaniKaniConnection(options);
	const service = createJapaneseService(connection, settings, () => clock);
	const connected = await service.command({ action: "connect", token });
	assert.equal(connected.wanikani.state, "ready");
	const profiles = await Promise.all([service.profile(), service.profile(), service.status()]);
	assert.equal(count, 1);
	assert.match(JSON.stringify(profiles), /寄る/);
	assert.doesNotMatch(JSON.stringify(profiles), new RegExp(token));
	clock += 16 * 60_000; word = "帰る";
	const profile = await service.profile();
	assert.equal(count, 2);
	assert.match(profile!.wanikaniContext!, /帰る/);
	assert.doesNotMatch(profile!.wanikaniContext!, /寄る/);
	offline = true; clock += 16 * 60_000;
	assert.match((await service.profile())!.wanikaniContext!, /STALE/);
	const restarted = createJapaneseService(new WaniKaniConnection(options), settings);
	assert.match((await restarted.profile())!.wanikaniContext!, /帰る/);
	await service.command({ action: "settings", settings: { ...DEFAULT_JAPANESE_SETTINGS, enabled: false } });
	assert.equal(await service.profile(), undefined);
	assert.equal((await service.command({ action: "disconnect" })).wanikani.connected, false);
	assert.equal(connection.context(), undefined);
});

test("credential mutations reject cross-origin forms and oversized JSON without reflecting secrets", async () => {
	const invalidHeaders: Record<string, string>[] = [{}, { origin: "https://other.invalid", "content-type": "application/json", "x-learnharness-japanese": "1" }, { origin: "http://localhost", "content-type": "text/plain", "x-learnharness-japanese": "1" }];
	for (const headers of invalidHeaders) {
		const response = await japaneseResponse(new Request("http://localhost/api/japanese", { method: "POST", headers, body: JSON.stringify({ action: "connect", token }) }));
		assert.equal(response.status, 403);
		assert.doesNotMatch(await response.text(), new RegExp(token));
	}
	const response = await japaneseResponse(new Request("http://localhost/api/japanese", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json", "x-learnharness-japanese": "1" }, body: JSON.stringify({ action: "connect", token: "x".repeat(5000) }) }));
	assert.equal(response.status, 413);
});
