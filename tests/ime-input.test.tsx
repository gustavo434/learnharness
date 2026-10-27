import assert from "node:assert/strict";
import { after, test } from "node:test";
import { parseHTML } from "linkedom";
import React, { act } from "react";
import { isComposingKey } from "../src/core/ime.ts";

const { window } = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
// LinkeDOM supports input events but does not advertise the browser property.
Object.defineProperty(window.document, "oninput", { value: null, configurable: true });
Object.assign(globalThis, {
	React, window, document: window.document, HTMLElement: window.HTMLElement,
	HTMLInputElement: window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { Composer } = await import("../components/composer.tsx");
const { PracticeDock } = await import("../components/practice-dock.tsx");
const { QuestionDock } = await import("../components/question-dock.tsx");
const { ReadingThinkingField } = await import("../components/reading-thinking.tsx");
const root = createRoot(window.document.getElementById("root")!);
after(async () => { await act(async () => root.unmount()); });

function key(target: Element, properties: object) {
	const event = new window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key: "Enter", keyCode: 13, ...properties });
	target.dispatchEvent(event);
	return event;
}

test("composition detection handles native events, React wrappers and Safari's final 229", () => {
	for (const event of [{ isComposing: true }, { keyCode: 229 }, { nativeEvent: { isComposing: true } }, { nativeEvent: { isComposing: false, keyCode: 229 } }]) {
		assert.equal(isComposingKey(event), true);
	}
	assert.equal(isComposingKey({ keyCode: 13, nativeEvent: { isComposing: false } }), false);
});

test("actual response fields leave IME confirmation and cancellation untouched, then accept normal Enter", async () => {
	for (const kind of ["composer", "practice", "question", "reading"] as const) {
		let submitted = 0;
		let escaped = 0;
		const onSubmit = () => { submitted++; };
		const onEscape = () => { escaped++; };
		await act(async () => {
			if (kind === "composer") root.render(<Composer value="日本語" onChange={() => {}} busy={false} canSend onSend={onSubmit} onStop={() => {}} onEscape={onEscape} />);
			if (kind === "practice") root.render(<PracticeDock problemCallId="ime" input={{ statement: "日本語で答えてください。" }} expanded onExpand={() => {}} onSubmit={onSubmit} onEscape={onEscape} />);
			if (kind === "question") root.render(<QuestionDock toolName="recall" toolCallId="ime" input={{ question: "日本語で答えてください。", correctAnswer: "自然な例文" }} expanded onExpand={() => {}} onSubmit={onSubmit} onEscape={onEscape} initialDraft={{ text: "日本語", thinking: "", other: "", selection: { selected: new Set(), otherSelected: false, dontKnow: false }, confidenceIndex: 0 }} />);
			if (kind === "reading") root.render(<ReadingThinkingField value="日本語" onChange={() => {}} claim={false} onOpen={onSubmit} onEscape={onEscape} />);
		});
		const field = window.document.querySelector("textarea")!;
		assert(field, kind);
		for (const properties of [{ isComposing: true }, { isComposing: false, keyCode: 229 }, { key: "Escape", isComposing: true }]) {
			let event!: Event;
			await act(async () => { event = key(field, properties); });
			assert.equal(event.defaultPrevented, false, `${kind}: IME keeps its default action`);
			assert.equal(submitted, 0, `${kind}: no submission`);
			assert.equal(escaped, 0, `${kind}: no dictation cancellation`);
		}
		if (kind !== "practice") {
			await act(async () => { key(field, {}); });
			assert.equal(submitted, 1, `${kind}: normal Enter still works`);
		}
		await act(async () => root.render(null));
	}
});
