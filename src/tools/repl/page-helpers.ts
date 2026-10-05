/** Page-context helper functions injected into every browserjs() execution.
 * Plain JS source string (not a serialized TS function) so it survives the
 * wrapper marker injection verbatim. Kept import-free so it is unit-testable
 * (syntax check) in node. Declared as function declarations BEFORE skill
 * library code, so skills can intentionally override any of them. */
export const PAGE_HELPERS_CODE = `
function __sg_sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/** querySelector that also descends into open shadow roots and same-origin iframes. */
function deepQueryAll(selector, root) {
  const out = [];
  let budget = 8000;
  const start = root || document;
  const visit = function (container, depth) {
    if (!container || depth > 8 || budget <= 0) return;
    const kids = container.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      if (budget <= 0) return;
      const el = kids[i];
      budget--;
      try { if (typeof el.matches === "function" && el.matches(selector)) out.push(el); } catch (e) {}
      if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
      if (el.tagName === "IFRAME") {
        try { if (el.contentDocument) visit(el.contentDocument, depth + 1); } catch (e) { /* cross-origin */ }
      }
      visit(el, depth + 1);
    }
  };
  visit(start, 0);
  return out;
}

function deepQuery(selector, root) {
  const found = deepQueryAll(selector, root);
  return found.length > 0 ? found[0] : null;
}

/** Poll until an element (selector string) or condition (function) appears. Returns the value. Throws on timeout. */
async function waitFor(target, opts) {
  const timeout = (opts && opts.timeout) || 10000;
  const interval = (opts && opts.interval) || 200;
  const t0 = Date.now();
  for (;;) {
    let value = null;
    if (typeof target === "string") {
      value = deepQuery(target);
    } else {
      try { value = target(); } catch (e) { value = null; }
    }
    if (value) return value;
    if (Date.now() - t0 >= timeout) {
      const what = typeof target === "string" ? " (selector: " + target + ")" : "";
      throw new Error("waitFor: condition not met within " + timeout + "ms" + what);
    }
    await __sg_sleep(interval);
  }
}

/** Poll until an element (selector) has disappeared. Throws on timeout. */
async function waitForGone(selector, opts) {
  const timeout = (opts && opts.timeout) || 10000;
  const interval = (opts && opts.interval) || 200;
  const t0 = Date.now();
  for (;;) {
    const remaining = deepQueryAll(selector);
    if (remaining.length === 0) return true;
    if (Date.now() - t0 >= timeout) {
      throw new Error("waitForGone: " + selector + " still present after " + timeout + "ms (" + remaining.length + " matches)");
    }
    await __sg_sleep(interval);
  }
}
`;
