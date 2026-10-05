import type { OutlineElementRaw, OutlineSnapshot, SettleOptions, SettleResult } from "../types/page-outline.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_ELEMENTS = 25;
const MAX_HEADINGS = 6;
const MAX_IFRAMES = 4;
const MAX_OUTPUT_CHARS = 4000;
const MAX_OUTLINE_TEXT = 60;

// ============================================================================
// IN-PAGE SETTLE WAIT (serialized via chrome.scripting.executeScript)
// ============================================================================

/**
 * Runs inside the page: waits for document readyState "complete", then for DOM
 * mutation quiescence. Keeps SPA navigations from returning a half-rendered
 * outline, replacing the hand-rolled setTimeout polling the agent used to do.
 */
async function settleInPage(options: SettleOptions): Promise<SettleResult> {
	const started = Date.now();
	const maxWaitMs = options.maxWaitMs;
	const idleMs = options.idleMs;
	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

	// Phase 1: readyState complete (bounded)
	while (document.readyState !== "complete") {
		if (Date.now() - started >= maxWaitMs) break;
		await sleep(100);
	}

	// A nearly-empty body at this point usually means a SPA that renders after
	// load - give the framework more headroom. A content-rich page gets a short
	// quiescence window so ad/analytics churn does not slow every navigate down.
	const bodyText = document.body?.innerText || "";
	const isSparse = bodyText.trim().length < 200;
	const quiesceMax = isSparse ? maxWaitMs : Math.min(maxWaitMs, 2000);

	// Phase 2: DOM mutation quiescence (bounded)
	let lastMutation = Date.now();
	const observer = new MutationObserver(() => {
		lastMutation = Date.now();
	});
	observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
	try {
		while (Date.now() - lastMutation < idleMs) {
			if (Date.now() - started >= quiesceMax) break;
			await sleep(100);
		}
	} finally {
		observer.disconnect();
	}

	return { readyState: document.readyState, settleMs: Date.now() - started };
}

// ============================================================================
// IN-PAGE COLLECTOR (serialized via chrome.scripting.executeScript)
// ============================================================================

/**
 * Runs inside the page: walks the DOM (piercing open shadow roots and
 * same-origin iframes) and returns a plain snapshot. Locator picking and
 * formatting happen outside (pure, testable) in formatPageOutline().
 */
function collectOutlineInPage(options: {
	maxElements: number;
	maxHeadings: number;
	maxIframes: number;
}): OutlineSnapshot {
	const maxElements = options.maxElements;
	const maxHeadings = options.maxHeadings;
	const maxIframes = options.maxIframes;
	const NODE_BUDGET = 6000;
	let visited = 0;

	const raw: OutlineElementRaw[] = [];
	const iframes: OutlineElementRaw[] = [];
	const headings: string[] = [];
	let totalInteractive = 0;
	let truncatedDom = false;

	const trimmed = (value: string | null | undefined, cap: number): string | undefined => {
		if (!value) return undefined;
		const collapsed = value.replace(/\s+/g, " ").trim();
		if (!collapsed) return undefined;
		return collapsed.length > cap ? collapsed.slice(0, cap - 1) + "…" : collapsed;
	};

	const describe = (el: Element): OutlineElementRaw | null => {
		const tag = el.tagName.toLowerCase();
		if (tag === "iframe") {
			const frame = el as HTMLIFrameElement;
			iframes.push({
				tag,
				kind: "iframe",
				id: el.id || undefined,
				name: el.getAttribute("name") || undefined,
				text: trimmed(frame.src, 100),
				index: 1,
			});
			return null;
		}
		totalInteractive++;
		const interactive = el as HTMLInputElement;
		let text = trimmed(el.getAttribute("aria-label"), MAX_OUTLINE_TEXT) || trimmed(el.textContent, MAX_OUTLINE_TEXT);
		if (tag === "input" || tag === "textarea") {
			const placeholder = trimmed(interactive.getAttribute("placeholder"), MAX_OUTLINE_TEXT);
			const value = trimmed(interactive.value, 30);
			text = value || placeholder || text;
		}
		const parent = el.parentElement;
		let siblingIndex = 1;
		if (parent) {
			const sameTag = parent.querySelectorAll(":scope > " + tag);
			for (let i = 0; i < sameTag.length; i++) {
				if (sameTag[i] === el) {
					siblingIndex = i + 1;
					break;
				}
			}
		}
		return {
			tag,
			kind:
				tag === "a"
					? "link"
					: tag === "button" || el.getAttribute("role") === "button"
						? "button"
						: tag === "input"
							? "input"
							: tag === "select"
								? "select"
								: tag === "textarea"
									? "textarea"
									: "other",
			id: el.id || undefined,
			name: el.getAttribute("name") || undefined,
			testid: el.getAttribute("data-testid") || el.getAttribute("data-test") || undefined,
			ariaLabel: trimmed(el.getAttribute("aria-label"), MAX_OUTLINE_TEXT),
			placeholder: el.getAttribute("placeholder") || undefined,
			text: text || undefined,
			href: tag === "a" ? trimmed(el.getAttribute("href"), 80) : undefined,
			type: tag === "input" ? interactive.getAttribute("type") || undefined : undefined,
			value: tag === "input" ? trimmed(interactive.value, 30) : undefined,
			disabled: (interactive as HTMLInputElement).disabled || undefined,
			parentClass: parent?.className ? String(parent.className).split(/\s+/)[0] || undefined : undefined,
			parentTag: parent ? parent.tagName.toLowerCase() : undefined,
			index: siblingIndex,
		};
	};

	const matches = (el: Element): boolean => {
		try {
			return el.matches(
				'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [contenteditable="true"], [onclick]',
			);
		} catch {
			return false;
		}
	};

	const visible = (el: Element): boolean => {
		const withCheck = el as Element & { checkVisibility?: () => boolean };
		if (typeof withCheck.checkVisibility === "function") {
			try {
				return withCheck.checkVisibility();
			} catch {
				/* fall through */
			}
		}
		const asHtml = el as HTMLElement;
		return asHtml.offsetWidth > 0 || asHtml.offsetHeight > 0;
	};

	const visit = (container: Document | ShadowRoot | Element, depth: number): void => {
		if (truncatedDom || depth > 8) return;
		const children = container.children;
		if (!children) return;
		for (let i = 0; i < children.length; i++) {
			if (truncatedDom) return;
			const el = children[i];
			visited++;
			if (visited > NODE_BUDGET) {
				truncatedDom = true;
				return;
			}
			if (matches(el) && visible(el) && raw.length < maxElements) {
				const entry = describe(el);
				if (entry) raw.push(entry);
			}
			if (el.tagName === "H1" || el.tagName === "H2" || el.tagName === "H3") {
				if (headings.length < maxHeadings) {
					const text = trimmed(el.textContent, 80);
					if (text) headings.push(el.tagName.toLowerCase() + ": " + text);
				}
			}
			if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
			if (el.tagName === "IFRAME") {
				if (iframes.length < maxIframes + 1) {
					try {
						const doc = (el as HTMLIFrameElement).contentDocument;
						if (doc) visit(doc, depth + 1);
					} catch {
						// cross-origin iframe - DOM not reachable
					}
				}
			}
			visit(el, depth + 1);
		}
	};

	visit(document, 0);

	return {
		title: document.title || "",
		url: location.href,
		readyState: document.readyState,
		headings,
		elements: raw,
		iframes: iframes.slice(0, maxIframes),
		totalInteractive,
		truncatedDom,
	};
}

// ============================================================================
// PURE FORMATTING (unit-testable)
// ============================================================================

const cssEscapeValue = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const validCssIdentifier = (value: string): boolean => /^[A-Za-z_][\w-]*$/.test(value);

/** Best-effort re-findable locator: unique attributes first, positional last. */
export function pickLocator(el: OutlineElementRaw): string {
	if (el.id && validCssIdentifier(el.id)) return "#" + el.id;
	if (el.testid) return `[data-testid="${cssEscapeValue(el.testid)}"]`;
	if (el.name && el.tag !== "iframe") return `${el.tag}[name="${cssEscapeValue(el.name)}"]`;
	if (el.ariaLabel) return `${el.tag}[aria-label="${cssEscapeValue(el.ariaLabel)}"]`;
	if (el.placeholder) return `${el.tag}[placeholder="${cssEscapeValue(el.placeholder)}"]`;
	if (el.kind === "link" && el.href && /^[^"'\s]{1,40}$/.test(el.href)) {
		const path = el.href.replace(/^https?:\/\/[^/]+/, "");
		if (path.length > 1) return `a[href*="${cssEscapeValue(path)}"]`;
	}
	if (el.parentTag) return `${el.parentTag} > ${el.tag}:nth-of-type(${el.index})`;
	return `${el.tag}:nth-of-type(${el.index})`;
}

const elementLabel = (el: OutlineElementRaw): string => {
	if (el.kind === "input" || el.kind === "textarea") {
		const bits: string[] = [el.type && el.type !== "text" ? `type=${el.type}` : ""].filter(Boolean);
		if (el.value) bits.push(`value="${el.value}"`);
		else if (el.placeholder) bits.push(`placeholder="${el.placeholder}"`);
		return bits.join(" ") || el.tag;
	}
	const label = el.text || el.ariaLabel || (el.kind === "link" && el.href ? el.href : el.tag);
	return `"${label}"`;
};

/** Formats a snapshot into the compact text block appended to navigate output. */
export function formatPageOutline(snapshot: OutlineSnapshot): string {
	const lines: string[] = [];
	lines.push(`Page: ${snapshot.title || "(untitled)"} — readyState=${snapshot.readyState}`);

	if (snapshot.headings.length > 0) {
		lines.push(`Headings: ${snapshot.headings.join(" | ")}`);
	}

	const elements = snapshot.elements.slice(0, MAX_ELEMENTS);
	if (elements.length > 0) {
		const more = Math.max(0, snapshot.totalInteractive - elements.length);
		lines.push(`Interactive elements (${elements.length}${more > 0 ? ` of ~${snapshot.totalInteractive}` : ""}):`);
		for (const el of elements) {
			lines.push(`  - ${el.kind} ${pickLocator(el)} ${elementLabel(el)}${el.disabled ? " [disabled]" : ""}`);
		}
	} else {
		lines.push("Interactive elements: none found");
	}

	if (snapshot.iframes.length > 0) {
		lines.push(`Iframes (${snapshot.iframes.length}):`);
		for (const f of snapshot.iframes) {
			lines.push(`  - ${pickLocator(f)} src=${f.text || "(none)"}`);
		}
	}

	if (snapshot.truncatedDom) lines.push("Note: DOM walk truncated (very large page)");

	let text = lines.join("\n");
	if (text.length > MAX_OUTPUT_CHARS) {
		text = text.slice(0, MAX_OUTPUT_CHARS) + "\n  … (outline truncated)";
	}
	return text;
}

// ============================================================================
// ORCHESTRATION (chrome.scripting)
// ============================================================================

export interface PageOutlineResult {
	outline?: string;
	error?: string;
	settleMs?: number;
}

const SETTLE_OPTIONS: SettleOptions = { idleMs: 600, maxWaitMs: 5000 };

/**
 * Waits for the page to settle, then collects a compact interactive-element
 * overview. Never throws - failures degrade to an error note so navigation
 * itself still succeeds (chrome://, PDF viewer, discarded tabs, etc.).
 */
export async function collectPageOutline(tabId: number, maxElements = MAX_ELEMENTS): Promise<PageOutlineResult> {
	try {
		const settleResults = await chrome.scripting.executeScript<[SettleOptions], Promise<SettleResult>>({
			target: { tabId },
			func: settleInPage,
			args: [SETTLE_OPTIONS],
		});
		const settleMs = settleResults[0]?.result?.settleMs;

		const collectResults = await chrome.scripting.executeScript<
			[{ maxElements: number; maxHeadings: number; maxIframes: number }],
			OutlineSnapshot
		>({
			target: { tabId },
			func: collectOutlineInPage,
			args: [{ maxElements, maxHeadings: MAX_HEADINGS, maxIframes: MAX_IFRAMES }],
		});
		const snapshot = collectResults[0]?.result;
		if (!snapshot) {
			return { error: "outline unavailable: page returned no data", settleMs };
		}
		return { outline: formatPageOutline(snapshot), settleMs };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const short = message.length > 140 ? message.slice(0, 140) + "…" : message;
		return { error: `outline unavailable: ${short}` };
	}
}
