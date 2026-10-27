import assert from "node:assert/strict";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { composeJapaneseInstructions, japaneseTools } from "../src/agent/japanese.ts";
import { composeInstructions, createPracticeAgent, createProberAgent, createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { createProberTools, probeExplainTool } from "../src/agent/tools.ts";
import { DEFAULT_JAPANESE_SETTINGS } from "../src/core/japanese.ts";

const profile = { ...DEFAULT_JAPANESE_SETTINGS, defaultMinutes: 15, interests: ["ゲーム"], wanikaniContext: "WaniKani fixture: 寄る（よる）" };

test("Japanese role instructions replace conflicting pedagogy and keep WaniKani out of upstream prompts", () => {
	for (const kind of ["prober", "teacher", "practice"] as const) {
		const prompt = composeJapaneseInstructions(kind, profile);
		assert.match(prompt, /Judge meaning and form in context, never by exact string match/);
		assert.match(prompt, /寄る/);
		assert.match(prompt, /ゲーム/);
		assert.match(prompt, /15/);
		assert.doesNotMatch(prompt, /A strand that never breaks is not done|No other teaching methods come close/);
		assert.doesNotMatch(composeInstructions(kind), /WaniKani fixture/);
	}
	assert.match(composeJapaneseInstructions("prober", profile), /three or four brief/);
	assert.match(composeJapaneseInstructions("teacher", profile), /begin; do not request plan approval/);
	assert.match(composeJapaneseInstructions("practice", profile), /semantic|semantically/);
});

test("Japanese tools keep the original schema and implementations immutable", () => {
	const before = JSON.stringify(probeExplainTool.parameters);
	const [adapted] = japaneseTools([probeExplainTool]);
	assert.equal(adapted!.execute, probeExplainTool.execute);
	assert.match(adapted!.parameters.properties.correctAnswer.description, /Equivalent valid answers/);
	assert.equal(JSON.stringify(probeExplainTool.parameters), before);
	assert.deepEqual(adapted!.parameters.required, probeExplainTool.parameters.required);
});

test("real prober factory uses Japanese rubrics, accepts a brief assessment without a failure ceiling, and queues handoff", async () => {
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([fauxToolCall("probe_done", { assessment: { strands: [{ strand: "reading", assessment: "Understands a causal sentence; production and ceiling untested." }] } })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("次は短い会話をしましょう。")])]);
	const delivered: unknown[] = [];
	const ctx = { chatId: "fixture", chatStore: { getChat: () => ({ messages: [] }) }, deliver: (value: unknown) => { delivered.push(value); } } as unknown as Parameters<typeof createProberTools>[0];
	const agent = createProberAgent(ctx, { japanese: profile, engine: { model: faux.getModel(), streamFn: faux.streamSimple }, toolToggles: { explain: true } });
	assert.match(agent.state.systemPrompt, /寄る/);
	assert(agent.state.tools.some((tool) => tool.name === "recall"));
	assert.doesNotMatch(agent.state.tools.find((tool) => tool.name === "probe_done")!.description, /every strand.*bracketed/);
	await agent.prompt("Start Japanese practice");
	assert.equal(delivered.length, 1);
});

test("teacher and practice factories receive Japanese context while profile-free factories retain upstream behavior", () => {
	const faux = createFauxCore({});
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const teacher = createTeacherAgent(undefined, { japanese: profile, engine });
	assert.match(teacher.state.systemPrompt, /寄る/);
	const practice = createPracticeAgent({ chatId: "fixture", chatStore: { getChat: () => ({ messages: [] }) } }, { japanese: profile, engine });
	assert.match(practice.state.systemPrompt, /寄る/);
	assert.equal(createTeacherAgent(undefined, { engine }).state.systemPrompt, composeInstructions("teacher"));
});
