/* Smoke test: pure logic only, no browser required. Run: npx tsx scripts/smoke-optimizations.ts */
import { strict as assert } from "node:assert";
import { formatPageOutline, pickLocator } from "../src/tools/page-outline.js";
import { PAGE_HELPERS_CODE } from "../src/tools/repl/page-helpers.js";
import type { OutlineSnapshot } from "../src/types/page-outline.js";
import { closestSnippet, describeUpdateMiss } from "../src/utils/update-miss.js";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
	try {
		fn();
		pass++;
		console.log(`  ok ${name}`);
	} catch (err) {
		fail++;
		console.error(`  FAIL ${name}: ${err}`);
	}
}

console.log("== PAGE_HELPERS_CODE ==");
test("is syntactically valid JS", () => {
	new Function(PAGE_HELPERS_CODE); // throws on syntax error
});
test("declares all five helpers", () => {
	for (const name of ["__sg_sleep", "deepQueryAll", "deepQuery", "waitFor", "waitForGone"]) {
		assert.ok(PAGE_HELPERS_CODE.includes(`function ${name}`), `missing ${name}`);
	}
});
test("waitFor throws descriptive timeout error", () => {
	assert.ok(PAGE_HELPERS_CODE.includes('"waitFor: condition not met within " + timeout + "ms"'));
});
test("deepQueryAll pierces shadowRoot and same-origin iframes", () => {
	assert.ok(PAGE_HELPERS_CODE.includes("el.shadowRoot) visit"));
	assert.ok(PAGE_HELPERS_CODE.includes("contentDocument) visit"));
});

console.log("== pickLocator ==");
test("prefers #id", () => {
	assert.equal(pickLocator({ tag: "input", kind: "input", id: "kw", index: 1 }), "#kw");
});
test("id with invalid CSS chars falls through", () => {
	const loc = pickLocator({ tag: "input", kind: "input", id: "9bad id", name: "wd", index: 1 });
	assert.equal(loc, 'input[name="wd"]');
});
test("data-testid second priority", () => {
	assert.equal(
		pickLocator({ tag: "button", kind: "button", testid: "send-btn", index: 1 }),
		'[data-testid="send-btn"]',
	);
});
test("aria-label before placeholder", () => {
	assert.equal(
		pickLocator({ tag: "button", kind: "button", ariaLabel: "Close", placeholder: "x", index: 1 }),
		'button[aria-label="Close"]',
	);
});
test("quotes in attribute values are escaped", () => {
	assert.equal(
		pickLocator({ tag: "button", kind: "button", ariaLabel: 'say "hi"', index: 1 }),
		'button[aria-label="say \\"hi\\""]',
	);
});
test("link falls back to href path substring", () => {
	assert.equal(
		pickLocator({ tag: "a", kind: "link", href: "https://x.com/video/123", index: 1 }),
		'a[href*="/video/123"]',
	);
});
test("positional fallback with parent tag", () => {
	assert.equal(
		pickLocator({ tag: "button", kind: "button", parentTag: "div", index: 2 }),
		"div > button:nth-of-type(2)",
	);
});

function snapshot(overrides: Partial<OutlineSnapshot> = {}): OutlineSnapshot {
	return {
		title: "Example Page",
		url: "https://example.com/",
		readyState: "complete",
		headings: ["h1: Hello"],
		elements: [],
		iframes: [],
		totalInteractive: 0,
		truncatedDom: false,
		...overrides,
	};
}

console.log("== formatPageOutline ==");
test("renders title, headings, elements, iframes", () => {
	const text = formatPageOutline(
		snapshot({
			elements: [
				{ tag: "a", kind: "link", id: "main-link", text: "Docs", href: "/docs", index: 1 },
				{ tag: "input", kind: "input", name: "q", type: "text", placeholder: "Search", index: 1 },
			],
			iframes: [{ tag: "iframe", kind: "iframe", id: "player", text: "https://cdn/x", index: 1 }],
			totalInteractive: 2,
		}),
	);
	assert.ok(text.includes("Page: Example Page — readyState=complete"));
	assert.ok(text.includes("h1: Hello"));
	assert.ok(text.includes('link #main-link "Docs"'));
	assert.ok(text.includes('input input[name="q"] placeholder="Search"'));
	assert.ok(text.includes("Iframes (1):"));
	assert.ok(text.includes("src=https://cdn/x"));
});
test("shows 'of ~N' when caps truncate", () => {
	const elements = Array.from({ length: 30 }, (_, i) => ({
		tag: "button",
		kind: "button" as const,
		id: `b${i}`,
		index: i + 1,
	}));
	const text = formatPageOutline(snapshot({ elements, totalInteractive: 41 }));
	assert.ok(text.includes("(25 of ~41)"));
});
test("caps output at 25 elements with 'of ~N' marker", () => {
	const elements = Array.from({ length: 60 }, (_, i) => ({
		tag: "button",
		kind: "button" as const,
		id: `b${i}`,
		text: `Button ${i}`,
		index: i + 1,
	}));
	const text = formatPageOutline(snapshot({ elements, totalInteractive: 60 }));
	assert.ok(text.includes("(25 of ~60)"));
	assert.ok(!text.includes("#b59"), "elements beyond cap must not appear");
});
test("empty page reports no interactive elements", () => {
	const text = formatPageOutline(snapshot());
	assert.ok(text.includes("Interactive elements: none found"));
});

console.log("== describeUpdateMiss / closestSnippet ==");
test("empty field suggests create/rewrite", () => {
	const msg = describeUpdateMiss("library", "", "foo");
	assert.ok(msg.includes("library field is empty"));
	assert.ok(msg.includes("create or rewrite"));
});
test("case-insensitive match hint", () => {
	const msg = describeUpdateMiss("name", "Gmail Basics", "gmail basics");
	assert.ok(msg.includes("case-insensitive match exists"));
	assert.ok(msg.includes("exact casing"));
});
test("closest snippet shows context", () => {
	const lib = "window.gmail = { sendEmail: async function() {}, archiveEmail: function(id) {} }";
	const msg = describeUpdateMiss("library", lib, "archiveMail: function(id) {}");
	assert.ok(msg.includes("Closest matching content near"));
	assert.ok(msg.includes("archiveEmail"), "should point at the real identifier");
});
test("no similar content shows field head", () => {
	const msg = describeUpdateMiss("description", "Completely unrelated words here", "zzzqqq xxxxxx");
	assert.ok(msg.includes("No similar content found"));
	assert.ok(msg.includes('Field starts with: "Completely unrelated words here"'));
});
test("closestSnippet finds longest word run", () => {
	const hit = closestSnippet("a b c d e f g", "xx b c d yy");
	assert.ok(hit);
	assert.equal(hit.snippet, "b c d");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
