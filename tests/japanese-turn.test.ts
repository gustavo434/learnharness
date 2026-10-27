import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-japanese-turn-"));
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.OPENROUTER_API_KEY = "fake-test-provider-key";
const token = "fake-wanikani-turn-token";
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	const url = new URL(String(input));
	assert.equal(url.origin, "https://api.wanikani.com");
	assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
	const now = new Date().toISOString();
	if (url.pathname === "/v2/user") return Response.json({ object: "user", data: { id: "fixture", level: 19, subscription: { max_level_granted: 60 } } });
	let data: unknown[] = [];
	if (url.pathname === "/v2/assignments") data = [{ object: "assignment", data: { subject_id: 1, subject_type: "vocabulary", srs_stage: 2, hidden: false, started_at: now, available_at: now, burned_at: null } }];
	if (url.pathname === "/v2/subjects") data = [{ id: 1, object: "vocabulary", data: { characters: "寄る", level: 1, hidden_at: null, meanings: [{ meaning: "stop by", accepted_answer: true, primary: true }], readings: [{ reading: "よる", accepted_answer: true, primary: true }] } }];
	return Response.json({ object: "collection", data, pages: { next_url: null } });
};
after(() => { globalThis.fetch = original; });

const { japaneseResponse } = await import("../src/server/japanese.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { createProberAgent } = await import("../src/agent/teacher-agent.ts");
const { runningTurn, settledTurnResponse } = await import("../src/server/turn-runs.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");

test("actual turn composition supplies current WaniKani context to the model and persists no token or snapshot", async () => {
	const connected = await japaneseResponse(new Request("http://localhost/api/japanese", { method: "POST", headers: { origin: "http://localhost", "x-learnharness-japanese": "1", "content-type": "application/json" }, body: JSON.stringify({ action: "connect", token }) }));
	assert.equal((await connected.json()).wanikani.state, "ready");
	const record = chatStore.createChat("Japanese fixture");
	chatStore.saveSettings(record.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const faux = createFauxCore({});
	let sentPrompt = "";
	faux.setResponses([(context) => {
		sentPrompt = JSON.stringify(context.messages.filter((message) => message.role === "system"));
		return fauxAssistantMessage([fauxToolCall("recall", { question: "日本語で、今晩の予定を一文で教えてください。", correctAnswer: "Example: 買い物に行きます。Accept any natural statement of an evening plan." })], { stopReason: "toolUse" });
	}]);
	const response = await handleChatRequest(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: record.id, input: { type: "text", text: "Start a short Japanese session" } }) }), (options) => createProberAgent({ chatId: record.id, chatStore, deliver: () => {}, jobStore: { createJob: () => { throw new Error("No background jobs in fixture"); } } as never, spawn: () => {} }, { ...options, engine: { model: faux.getModel(), streamFn: faux.streamSimple } }));
	assert.equal(response.status, 200, await response.text());
	const turn = runningTurn(record.id);
	if (turn) await new Response(turn.subscribe()).text();
	else await settledTurnResponse(record.id).text();
	assert.match(sentPrompt, /寄る/);
	assert.match(sentPrompt, /natural alternative wording/);
	assert.doesNotMatch(sentPrompt, new RegExp(token));
	const saved = JSON.stringify(chatStore.getChat(record.id));
	assert.match(saved, /日本語で/);
	assert.doesNotMatch(saved, new RegExp(token));
	assert.doesNotMatch(saved, /WaniKani material preferences/);
});

test("unreadable Japanese preferences refuse before a turn starts and do not strand liveness", async () => {
	const record = chatStore.createChat("Corrupt preferences fixture");
	chatStore.saveSettings(record.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	fs.writeFileSync(path.join(directory, "data/japanese/settings.json"), "broken");
	const response = await handleChatRequest(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: record.id, input: { type: "text", text: "Start Japanese" } }) }));
	assert.equal(response.status, 503);
	assert.match(await response.text(), /Japanese preferences could not be loaded/);
	assert.equal(isTurnRunning(record.id), false);
	assert.equal(chatStore.getChat(record.id)!.messages.length, 0);
});
