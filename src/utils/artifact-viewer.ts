// ============================================================================
// ARTIFACT FULLSCREEN VIEW: opens artifact content in a full browser tab.
//
// HTML artifacts cannot be opened as a blob: tab directly - a
// blob:chrome-extension page inherits the strict extension CSP
// (script-src 'self') which blocks inline scripts (same constraint as
// session export, see export-html.ts). Instead the HTML is staged in
// chrome.storage.session and viewer.html renders it through the permissive
// sandbox.html iframe - the same mechanism the side panel preview uses.
//
// Non-HTML content (images, PDFs, plain text) contains no scripts and is
// opened as a blob URL directly, so Chrome's native viewers handle it.
// ============================================================================

import { Toast } from "../components/Toast.js";

const VIEWER_KEY_PREFIX = "artifact-viewer:";

export function openArtifactInTab(
	filename: string,
	external: { content: string | Uint8Array; mimeType: string },
): void {
	if (external.mimeType === "text/html" && typeof external.content === "string") {
		void openHtmlArtifactInTab(filename, external.content);
		return;
	}
	const blob = new Blob([toBlobPart(external.content)], { type: external.mimeType });
	window.open(URL.createObjectURL(blob), "_blank");
}

function toBlobPart(content: string | Uint8Array): BlobPart {
	if (content instanceof Uint8Array) {
		return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
	}
	return content;
}

async function openHtmlArtifactInTab(filename: string, html: string): Promise<void> {
	// Keyed by filename so reopening the same artifact overwrites its entry
	// (bounded storage) and reloading the viewer tab re-renders the latest
	// staged version. Entries live in session storage and die with the browser.
	const key = `${VIEWER_KEY_PREFIX}${filename}`;
	try {
		await chrome.storage.session.set({ [key]: { filename, html } });
	} catch (err) {
		// storage.session quota exceeded: fall back to a plain blob tab. Inline
		// scripts will be blocked by the extension CSP, but static content and
		// external <script src> (CDN) still render.
		console.error("Failed to stage artifact for fullscreen view:", err);
		Toast.error("Artifact too large for fullscreen view, opened without scripts");
		const blob = new Blob([html], { type: "text/html" });
		window.open(URL.createObjectURL(blob), "_blank");
		return;
	}
	await chrome.tabs.create({
		url: chrome.runtime.getURL(`viewer.html?key=${encodeURIComponent(key)}`),
	});
}
