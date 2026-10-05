/** Diagnostics for failed string-replacement updates (skill tool "update").
 * Pure functions, importable without a browser for smoke testing. */

/**
 * Finds the longest run of consecutive words from oldString that exists in
 * content (case-insensitive) and returns it with surrounding context.
 * Returns null when nothing plausible matches.
 */
export function closestSnippet(content: string, oldString: string): { snippet: string; context: string } | null {
	const needle = oldString.replace(/\s+/g, " ").trim();
	if (needle.length < 4) return null;
	const haystack = content.replace(/\s+/g, " ");
	const lowerHaystack = haystack.toLowerCase();
	const words = needle.split(" ");
	for (let len = Math.min(words.length, 12); len >= 2; len--) {
		for (let start = 0; start + len <= words.length; start++) {
			const candidate = words.slice(start, start + len).join(" ");
			const idx = lowerHaystack.indexOf(candidate.toLowerCase());
			if (idx >= 0) {
				const from = Math.max(0, idx - 40);
				const to = Math.min(haystack.length, idx + candidate.length + 40);
				const context = (from > 0 ? "…" : "") + haystack.slice(from, to) + (to < haystack.length ? "…" : "");
				return { snippet: candidate, context };
			}
		}
	}
	return null;
}

/**
 * Builds the error message for a failed string-replacement update, showing the
 * agent where the content actually is instead of a bare "old_string not found".
 */
export function describeUpdateMiss(field: string, content: string, oldString: string): string {
	if (!content || !content.trim()) {
		return `Update failed: ${field} field is empty — nothing to replace. Use create or rewrite instead.`;
	}
	const lowerContent = content.toLowerCase();
	const lowerOld = oldString.toLowerCase();
	if (oldString.trim() && lowerContent.includes(lowerOld)) {
		return `Update failed: old_string not found in ${field} field, but a case-insensitive match exists — use the exact casing from the field.`;
	}
	const closest = closestSnippet(content, oldString);
	if (closest) {
		return `Update failed: old_string not found in ${field} field. Closest matching content near "${closest.snippet}":\n${closest.context}`;
	}
	const head = content.replace(/\s+/g, " ").slice(0, 160);
	return `Update failed: old_string not found in ${field} field. No similar content found. Field starts with: "${head}"`;
}
