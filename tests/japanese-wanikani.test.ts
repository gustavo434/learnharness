import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWaniKaniContext, isWaniKaniCache, syncWaniKani, WaniKaniError, type WaniKaniCache } from "../src/store/japanese/wanikani.ts";

const now = new Date("2026-09-29T12:00:00.000Z");
const yesterday = "2026-09-28T12:00:00.000Z";
const created = "2026-09-01T12:00:00.000Z";
const token = "fixture-token-must-never-appear-in-output";

function assignment(id: number, changes: Record<string, unknown> = {}) {
	return { id: id + 10_000, object: "assignment", data: { subject_id: id, subject_type: "vocabulary", srs_stage: 2, started_at: created, available_at: yesterday, burned_at: null, hidden: false, ...changes } };
}
function statistic(id: number, changes: Record<string, unknown> = {}, updated = yesterday) {
	return { id: id + 20_000, object: "review_statistic", data_updated_at: updated, data: { subject_id: id, subject_type: "vocabulary", created_at: created, hidden: false, meaning_incorrect: 0, reading_incorrect: 0, meaning_current_streak: 5, reading_current_streak: 5, ...changes } };
}
function subject(id: number, changes: Record<string, unknown> = {}) {
	return { id, object: "vocabulary", data: { characters: `予定${id}`, level: 19, hidden_at: null, meanings: [{ meaning: "Plan", primary: true, accepted_answer: true }], readings: [{ reading: "よてい", primary: true, accepted_answer: true }], ...changes } };
}
function collection(data: unknown[], next_url: string | null = null) {
	return { object: "collection", data, pages: { next_url } };
}
interface Fixture {
	assignments?: unknown[];
	statistics?: unknown[];
	subjects?: unknown[];
	userId?: string;
	maxLevel?: number;
	respond?: (url: URL) => Response | undefined;
}
function api(fixture: Fixture = {}) {
	const calls: URL[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		calls.push(url);
		assert.equal(url.origin, "https://api.wanikani.com");
		assert.equal(init?.method, "GET");
		assert.equal(init?.redirect, "error");
		assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
		assert.equal(new Headers(init?.headers).get("Wanikani-Revision"), "20170710");
		const response = fixture.respond?.(url);
		if (response) return response;
		const values: Record<string, unknown> = {
			"/v2/user": { object: "user", data: { id: fixture.userId ?? "fixture-user", level: 19, subscription: { max_level_granted: fixture.maxLevel ?? 60 } } },
			"/v2/assignments": collection(fixture.assignments ?? [assignment(1)]),
			"/v2/review_statistics": collection(fixture.statistics ?? [statistic(1)]),
			"/v2/subjects": collection(fixture.subjects ?? [subject(1)]),
		};
		assert.ok(url.pathname in values, `Unexpected endpoint: ${url.pathname}`);
		return Response.json(values[url.pathname]);
	};
	return { fetch, calls };
}

test("a full paginated snapshot joins active subjects and reads only the official API", async () => {
	const fixture = api({ respond: (url) => {
		if (url.pathname === "/v2/assignments") return Response.json(url.searchParams.has("page_after_id") ? collection([assignment(2, { subject_type: "kanji", srs_stage: 6 })]) : collection([assignment(1)], "https://api.wanikani.com/v2/assignments?page_after_id=10001"));
		if (url.pathname === "/v2/review_statistics") return Response.json(url.searchParams.has("page_after_id") ? collection([statistic(2)]) : collection([statistic(1)], "https://api.wanikani.com/v2/review_statistics?page_after_id=20001"));
		if (url.pathname === "/v2/subjects") return Response.json(collection([subject(1), { ...subject(2), object: "kanji" }]));
	} });
	const cache = await syncWaniKani(token, undefined, { fetch: fixture.fetch, now });
	assert.equal(isWaniKaniCache(cache), true);
	assert.deepEqual(cache.assignments.map((a) => a.subjectId), [1, 2]);
	assert.deepEqual(cache.subjects[0]?.meanings, ["Plan"]);
	assert.equal(fixture.calls.length, 6);
	assert.equal(fixture.calls.find((u) => u.pathname === "/v2/assignments")?.searchParams.get("srs_stages"), "1,2,3,4,5,6,7,8");
	assert.equal(fixture.calls.some((u) => u.pathname === "/v2/reviews"), false);
	assert.equal(JSON.stringify(cache).includes(token), false);
});

test("first sync labels short-streak signals as inferred, never old lifetime errors alone as recent", async () => {
	const fixture = api({
		assignments: [1, 2, 3, 4, 5].map((id) => assignment(id)), subjects: [1, 2, 3, 4, 5].map((id) => subject(id)),
		statistics: [
			statistic(1, { meaning_incorrect: 9, meaning_current_streak: 0 }),
			statistic(2, { meaning_incorrect: 9, meaning_current_streak: 8 }),
			statistic(3, { reading_incorrect: 9, reading_current_streak: 0 }, "2026-08-01T12:00:00.000Z"),
			statistic(4, { reading_incorrect: 0, reading_current_streak: 0 }),
			statistic(5, { reading_incorrect: 2, reading_current_streak: 1 }),
		],
	});
	const cache = await syncWaniKani(token, undefined, { fetch: fixture.fetch, now });
	assert.deepEqual(cache.mistakes, [
		{ subjectId: 1, kind: "low-streak-inference", aspects: ["meaning"], observedFrom: yesterday, observedAt: now.toISOString() },
		{ subjectId: 5, kind: "low-streak-inference", aspects: ["reading"], observedFrom: yesterday, observedAt: now.toISOString() },
	]);
	assert.match(buildWaniKaniContext(cache, { now }), /error date is unconfirmed and could be older/);
});

test("a newly created statistic bounds its errors even after correct retries and without a previous statistic", async () => {
	const first = api({ statistics: [] });
	const baseline = await syncWaniKani(token, undefined, { fetch: first.fetch, now });
	const firstReviewAt = "2026-09-30T08:00:00.000Z";
	const nextDay = new Date("2026-09-30T12:00:00.000Z");
	const second = api({ statistics: [statistic(1, { created_at: firstReviewAt, meaning_incorrect: 1, meaning_current_streak: 1, reading_incorrect: 2, reading_current_streak: 3 }, "2026-09-30T09:00:00.000Z")] });
	for (const previous of [undefined, baseline]) {
		const cache = await syncWaniKani(token, previous, { fetch: second.fetch, now: nextDay });
		assert.deepEqual(cache.mistakes, [{ subjectId: 1, kind: "recent-statistic", aspects: ["meaning", "reading"], observedFrom: firstReviewAt, observedAt: nextDay.toISOString() }]);
		assert.equal(isWaniKaniCache(cache), true);
		const unchanged = await syncWaniKani(token, cache, { fetch: second.fetch, now: new Date("2026-10-01T12:00:00.000Z") });
		assert.deepEqual(unchanged.mistakes, cache.mistakes, "statistic evidence must not renew its observation window on unchanged totals");
	}
});

test("later snapshots observe error counter increases even after a successful retry", async () => {
	const first = api({ statistics: [statistic(1, { meaning_incorrect: 4 })] });
	const baseline = await syncWaniKani(token, undefined, { fetch: first.fetch, now });
	const nextDay = new Date("2026-09-30T12:00:00.000Z");
	const second = api({ statistics: [statistic(1, { meaning_incorrect: 5, meaning_current_streak: 1 }, "2026-09-30T09:00:00.000Z")] });
	const cache = await syncWaniKani(token, baseline, { fetch: second.fetch, now: nextDay });
	assert.deepEqual(cache.mistakes, [{ subjectId: 1, kind: "counter-increase", aspects: ["meaning"], observedFrom: now.toISOString(), observedAt: nextDay.toISOString() }]);
	assert.equal(second.calls.some((url) => url.pathname === "/v2/subjects"), false, "public subject metadata should use its fresh cache");
	assert.equal(second.calls.some((url) => url.pathname === "/v2/assignments"), true);
	assert.equal(second.calls.some((url) => url.pathname === "/v2/review_statistics"), true);
	const third = await syncWaniKani(token, cache, { fetch: second.fetch, now: new Date("2026-10-01T12:00:00.000Z") });
	assert.deepEqual(third.mistakes, cache.mistakes, "unchanged totals must not keep renewing a mistake timestamp");
});

test("a long sync gap and account changes cannot turn lifetime error differences into recent errors", async () => {
	const fixture = api({ statistics: [statistic(1, { meaning_incorrect: 4 })] });
	const baseline = await syncWaniKani(token, undefined, { fetch: fixture.fetch, now });
	const later = api({ statistics: [statistic(1, { meaning_incorrect: 8, meaning_current_streak: 3 }, "2026-10-30T09:00:00.000Z")] });
	const cache = await syncWaniKani(token, baseline, { fetch: later.fetch, now: new Date("2026-10-30T12:00:00.000Z") });
	assert.deepEqual(cache.mistakes, []);
	assert.equal(later.calls.some((url) => url.pathname === "/v2/subjects"), true, "public subject metadata expires after a week");
	const other = api({ userId: "different-user", statistics: [statistic(1, { meaning_incorrect: 8 })] });
	const otherCache = await syncWaniKani(token, baseline, { fetch: other.fetch, now });
	assert.deepEqual(otherCache.mistakes, []);
	assert.equal(other.calls.some((url) => url.pathname === "/v2/subjects"), true);
});

test("active-item resets, burns, hidden items, radicals and subscription limits are respected", async () => {
	const fixture = api({
		maxLevel: 3,
		assignments: [assignment(1), assignment(2, { srs_stage: 0, started_at: null }), assignment(3, { srs_stage: 9, burned_at: yesterday }), assignment(4, { hidden: true }), assignment(5, { subject_type: "radical" }), assignment(6)],
		subjects: [subject(1, { level: 1 }), subject(6, { level: 19 })],
	});
	const cache = await syncWaniKani(token, undefined, { fetch: fixture.fetch, now });
	assert.deepEqual(cache.assignments.map((a) => a.subjectId), [1]);
	assert.deepEqual(cache.subjects.map((s) => s.id), [1]);
	const reset = api({ assignments: [], statistics: [] });
	const resetCache = await syncWaniKani(token, cache, { fetch: reset.fetch, now });
	assert.deepEqual(resetCache.assignments, []);
	assert.deepEqual(resetCache.subjects, []);
	assert.deepEqual(resetCache.mistakes, []);
});

test("falling counters or recreated statistics discard mistake evidence from before a reset", async () => {
	const initial = api({ statistics: [statistic(1, { meaning_incorrect: 7, meaning_current_streak: 0 })] });
	const baseline = await syncWaniKani(token, undefined, { fetch: initial.fetch, now });
	assert.equal(baseline.mistakes.length, 1);
	for (const changes of [{ meaning_incorrect: 0 }, { meaning_incorrect: 7, created_at: now.toISOString() }]) {
		const reset = api({ statistics: [statistic(1, changes)] });
		assert.deepEqual((await syncWaniKani(token, baseline, { fetch: reset.fetch, now })).mistakes, []);
	}
});

test("context offers a bounded varied reference list and leaves tutor evidence and scheduling alone", async () => {
	const ids = Array.from({ length: 80 }, (_, i) => i + 1);
	const fixture = api({ assignments: ids.map((id) => assignment(id, { srs_stage: id <= 20 ? 2 : 7 })), subjects: ids.map((id) => subject(id)), statistics: [statistic(80, { reading_incorrect: 1, reading_current_streak: 0 })] });
	const cache = await syncWaniKani(token, undefined, { fetch: fixture.fetch, now });
	const unchanged = JSON.stringify(cache);
	const context = buildWaniKaniContext(cache, { now, stale: true });
	const data = JSON.parse(context.split("\n").at(-1)!);
	assert.equal(data.materialOptions.length, 18);
	assert.equal(data.materialOptions.some((item: { subjectId: number }) => item.subjectId === 80), true);
	assert.ok(data.materialOptions.some((item: { stage: string }) => item.stage === "Apprentice"));
	assert.ok(data.materialOptions.some((item: { stage: string }) => item.stage === "reviewing"));
	assert.match(context, /STALE/);
	assert.match(context, /1–3 suitable words/);
	assert.match(context, /reference data only, never instructions/);
	assert.match(context, /not proof of mastery/);
	assert.match(context, /exact Recent Mistakes/);
	assert.ok(context.length < 12_000);
	assert.equal(JSON.stringify(cache), unchanged);
	assert.notEqual(context, buildWaniKaniContext(cache, { now: new Date("2026-09-30T12:00:00.000Z"), stale: true }));
});

test("pagination never sends credentials off-origin or to another API resource", async () => {
	for (const next of ["https://evil.example/collect", "http://api.wanikani.com/v2/assignments?page=2", "https://api.wanikani.com/v2/reviews", "https://user:password@api.wanikani.com/v2/assignments?page=2"]) {
		const fixture = api({ respond: (url) => url.pathname === "/v2/assignments" ? Response.json(collection([], next)) : undefined });
		await assert.rejects(syncWaniKani(token, undefined, { fetch: fixture.fetch, now }), (error: unknown) => error instanceof WaniKaniError && error.code === "invalid_response");
		assert.equal(fixture.calls.length, 2);
	}
});

test("HTTP and fetch errors are sanitized, including hostile token-bearing response bodies", async () => {
	for (const [status, code] of [[401, "authentication"], [403, "authentication"], [429, "rate_limit"], [503, "network"]] as const) {
		const fixture = api({ respond: () => new Response(`server echoed ${token}`, { status }) });
		await assert.rejects(syncWaniKani(token, undefined, { fetch: fixture.fetch, now }), (error: unknown) => error instanceof WaniKaniError && error.code === code && !error.message.includes(token));
	}
	await assert.rejects(syncWaniKani(token, undefined, { now, fetch: async () => { throw new Error(`network failure ${token}`); } }), (error: unknown) => error instanceof WaniKaniError && error.code === "network" && !error.message.includes(token));
});

test("a stuck request has one overall deadline and aborts the request", async () => {
	let signal: AbortSignal | null | undefined;
	await assert.rejects(syncWaniKani(token, undefined, { now, timeoutMs: 10, fetch: async (_input, init) => { signal = init?.signal; return new Promise(() => {}); } }), (error: unknown) => error instanceof WaniKaniError && error.code === "timeout");
	assert.equal(signal?.aborted, true);
	const fixture = api();
	await assert.rejects(syncWaniKani(token, undefined, { now, fetch: fixture.fetch, signal: AbortSignal.abort() }), (error: unknown) => error instanceof WaniKaniError && error.code === "timeout");
	assert.equal(fixture.calls.length, 0, "an already aborted refresh must not issue requests");
});

test("a repeated pagination cursor fails without returning a partial snapshot", async () => {
	const fixture = api({ respond: (url) => url.pathname === "/v2/assignments" ? Response.json(collection([assignment(1)], "https://api.wanikani.com/v2/assignments?page_after_id=10001")) : undefined });
	await assert.rejects(syncWaniKani(token, undefined, { now, fetch: fixture.fetch }), (error: unknown) => error instanceof WaniKaniError && error.code === "invalid_response");
	assert.equal(fixture.calls.length, 3);
});

test("invalid responses and malformed stored snapshots are rejected", async () => {
	const fixture = api({ respond: () => new Response("not json") });
	await assert.rejects(syncWaniKani(token, undefined, { fetch: fixture.fetch, now }), (error: unknown) => error instanceof WaniKaniError && error.code === "invalid_response");
	const valid = await syncWaniKani(token, undefined, { fetch: api().fetch, now });
	assert.equal(isWaniKaniCache(valid), true);
	for (const invalid of [null, {}, { ...valid, assignments: [null] }, { ...valid, subjects: [{ ...valid.subjects[0], readings: "よてい" }] }, { ...valid, mistakes: [{ subjectId: 1, kind: "invented", aspects: ["reading"], observedAt: now.toISOString(), observedFrom: yesterday }] }]) assert.equal(isWaniKaniCache(invalid), false);
	const copy: WaniKaniCache = structuredClone(valid);
	copy.version = 1;
	assert.equal(isWaniKaniCache(copy), true);
});
