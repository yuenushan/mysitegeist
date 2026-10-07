// Fullscreen artifact viewer page (viewer.html entry).
//
// This page is a regular extension page, so it is subject to the strict
// extension CSP and cannot render artifact HTML with inline scripts itself.
// It hosts the manifest-declared sandbox.html in a fullscreen iframe instead
// and hands the staged artifact over via the sandbox-load postMessage
// protocol (see static/sandbox.js). The artifact content is staged in
// chrome.storage.session by openArtifactInTab() in utils/artifact-viewer.ts.

const statusEl = document.getElementById("status");
const iframeHost = document.getElementById("iframe-host");

interface StagedArtifact {
	filename?: string;
	html?: string;
}

async function main(): Promise<void> {
	const key = new URLSearchParams(location.search).get("key");
	if (!key) {
		showError("No artifact key in URL. Reopen the artifact from the side panel.");
		return;
	}

	let entry: StagedArtifact | undefined;
	try {
		const stored = await chrome.storage.session.get(key);
		entry = stored[key] as StagedArtifact | undefined;
	} catch (err) {
		showError(`Failed to read staged artifact: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	if (!entry?.html) {
		showError("The artifact is no longer available. Reopen it from the side panel.");
		return;
	}

	if (entry.filename) {
		document.title = entry.filename;
	}
	renderInSandbox(entry.html);
}

function renderInSandbox(html: string): void {
	const iframe = document.createElement("iframe");
	iframe.sandbox.add("allow-scripts");
	iframe.sandbox.add("allow-modals");
	iframe.style.cssText = "width:100%;height:100%;border:none;display:block;";
	iframe.src = chrome.runtime.getURL("sandbox.html");

	const readyHandler = (e: MessageEvent) => {
		if (e.data?.type !== "sandbox-ready" || e.source !== iframe.contentWindow) return;
		window.removeEventListener("message", readyHandler);
		if (statusEl) statusEl.style.display = "none";
		iframe.contentWindow?.postMessage({ type: "sandbox-load", sandboxId: "artifact-viewer", code: html }, "*");
	};
	window.addEventListener("message", readyHandler);

	// Backstop: if sandbox.html never signals ready (blocked load), surface it
	// instead of showing an empty page forever.
	window.setTimeout(() => {
		if (statusEl && statusEl.style.display !== "none") {
			showError("Sandbox failed to load. Reload the tab or reopen the artifact from the side panel.");
		}
	}, 10_000);

	iframeHost?.appendChild(iframe);
}

function showError(message: string): void {
	if (statusEl) {
		statusEl.textContent = message;
		statusEl.style.display = "block";
	}
}

void main();
