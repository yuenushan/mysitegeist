/** Plain-data shapes shared between the in-page outline collector (serialized
 * into the page via chrome.scripting) and the pure formatter/test code. */

export interface OutlineElementRaw {
	tag: string;
	kind: "link" | "button" | "input" | "select" | "textarea" | "other" | "iframe";
	id?: string;
	name?: string;
	testid?: string;
	ariaLabel?: string;
	placeholder?: string;
	text?: string;
	href?: string;
	type?: string;
	value?: string;
	disabled?: boolean;
	parentClass?: string;
	parentTag?: string;
	index: number;
}

export interface OutlineSnapshot {
	title: string;
	url: string;
	readyState: string;
	headings: string[];
	elements: OutlineElementRaw[];
	iframes: OutlineElementRaw[];
	totalInteractive: number;
	/** true when the node budget was hit - DOM walk ended early */
	truncatedDom: boolean;
}

export interface SettleOptions {
	/** DOM quiescence window considered "settled" (ms) */
	idleMs: number;
	/** hard cap for the whole settle wait (ms) */
	maxWaitMs: number;
}

export interface SettleResult {
	readyState: string;
	settleMs: number;
}
