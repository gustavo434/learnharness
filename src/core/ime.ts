/** Leave composition keys to the input method, including Safari's final
 * confirmation event (keyCode 229 can outlive isComposing). Accept native
 * events and React's wrapper without importing React into the core. */
export function isComposingKey(event: {
	isComposing?: boolean;
	keyCode?: number;
	nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
	const native = event.nativeEvent ?? event;
	return event.isComposing === true || native.isComposing === true
		|| event.keyCode === 229 || native.keyCode === 229;
}
