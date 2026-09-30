import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

// ============================================================================
// SESSION EXPORT (like pi's /export): builds a fully static, self-contained
// HTML page. Everything is rendered at generation time - the output contains
// NO scripts at all, because a blob:chrome-extension page inherits the
// extension CSP (script-src 'self') which blocks inline scripts. Native
// <details> elements provide the collapsible sections.
// ============================================================================

export interface SessionExportHeader {
	sessionId: string;
	title: string;
	model: string;
	thinkingLevel?: string;
	messageCount: number;
	totalTokens: number;
	totalCost: number;
}

export interface SessionExportTools {
	name: string;
	description: string;
}

export interface SessionExportInput {
	header: SessionExportHeader;
	systemPrompt?: string;
	tools?: SessionExportTools[];
	/** Messages along the active branch, as stored (raw session fidelity). */
	messages: AgentMessage[];
	/** Messages after browserMessageTransformer - what the LLM actually receives. */
	llmMessages: Message[];
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function formatTime(msg: AgentMessage): string {
	const ts = (msg as { timestamp?: number }).timestamp;
	return ts ? new Date(ts).toLocaleString() : "";
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				const b = block as { type?: string; text?: string };
				if (b.type === "text") return b.text ?? "";
				if (b.type === "image") return "[image]";
				return `[${b.type ?? "block"}]`;
			})
			.join("\n");
	}
	return JSON.stringify(content ?? null, null, 2);
}

function pre(text: string, cls?: string): string {
	return `<pre${cls ? ` class="${cls}"` : ""}>${escapeHtml(text)}</pre>`;
}

function usageHtml(usage: unknown): string {
	const u = usage as { input?: number; output?: number; cost?: { total?: number } } | undefined;
	if (!u || (!u.input && !u.output)) return "";
	const parts: string[] = [];
	if (u.input) parts.push(`↑${u.input.toLocaleString()}`);
	if (u.output) parts.push(`↓${u.output.toLocaleString()}`);
	if (u.cost?.total) parts.push(`$${u.cost.total.toFixed(4)}`);
	return parts.length ? `<div class="usage">${parts.join(" · ")}</div>` : "";
}

function contentBlocksHtml(content: unknown): string {
	if (!Array.isArray(content)) return pre(textOfContent(content));
	const out: string[] = [];
	for (const block of content) {
		const b = block as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
		if (b.type === "text") {
			out.push(pre(b.text ?? ""));
		} else if (b.type === "thinking") {
			out.push(`<details class="sub"><summary>Thinking</summary>${pre(b.thinking ?? "", "thinking")}</details>`);
		} else if (b.type === "toolCall") {
			out.push(
				`<div class="toolcall">Tool call: <code>${escapeHtml(b.name ?? "")}</code>` +
					`<details class="sub"><summary>arguments</summary>${pre(JSON.stringify(b.arguments ?? {}, null, 2))}</details></div>`,
			);
		} else {
			out.push(pre(`[${b.type ?? "block"}]`, "muted"));
		}
	}
	return out.join("\n");
}

function rawJsonDetails(msg: unknown): string {
	return `<details class="sub"><summary>Raw JSON</summary>${pre(JSON.stringify(msg, null, 2))}</details>`;
}

function renderMessage(msg: AgentMessage): string {
	const time = formatTime(msg);
	const timeHtml = time ? `<span class="time">${escapeHtml(time)}</span>` : "";
	let cls = "other";
	let badge = String(msg.role);
	let body = "";

	switch (msg.role) {
		case "user": {
			cls = "user";
			badge = "User";
			body = pre(textOfContent(msg.content));
			break;
		}
		case "user-with-attachments": {
			cls = "user";
			badge = "User";
			const m = msg as unknown as { attachments?: unknown[]; content: unknown };
			const atts = m.attachments?.length ? `<div class="muted">${m.attachments.length} attachment(s)</div>` : "";
			body = atts + pre(textOfContent(m.content));
			break;
		}
		case "assistant": {
			cls = "assistant";
			badge = "Assistant";
			const m = msg as unknown as { content: unknown; usage?: unknown };
			body = contentBlocksHtml(m.content) + usageHtml(m.usage);
			break;
		}
		case "toolResult": {
			const m = msg as unknown as { toolName?: string; isError?: boolean; content: unknown };
			cls = m.isError ? "toolresult error" : "toolresult";
			badge = `Tool: ${m.toolName ?? "result"}`;
			body = pre(textOfContent(m.content));
			break;
		}
		case "navigation": {
			cls = "nav";
			badge = "Navigation";
			const m = msg as unknown as { url?: string; title?: string };
			const label = escapeHtml(m.title || m.url || "");
			body = `<div>Navigated to <a href="${escapeHtml(m.url ?? "")}">${label}</a></div>`;
			break;
		}
		case "welcome": {
			cls = "nav";
			badge = "Welcome";
			body = `<div class="muted">Welcome message</div>`;
			break;
		}
		case "compaction": {
			cls = "compaction";
			badge = "Compaction";
			const m = msg as unknown as { summary?: string; tokensBefore?: number };
			body =
				`<div class="muted">Context compacted (~${(m.tokensBefore ?? 0).toLocaleString()} tokens summarized)</div>` +
				pre(m.summary ?? "");
			break;
		}
		case "artifact": {
			cls = "nav";
			badge = "Artifact";
			const m = msg as unknown as { name?: string; path?: string };
			body = `<div class="muted">Artifact: ${escapeHtml(m.name ?? m.path ?? "")}</div>`;
			break;
		}
		default: {
			body = pre(JSON.stringify(msg, null, 2).slice(0, 2000));
		}
	}

	return `<div class="msg ${cls}"><span class="badge">${escapeHtml(badge)}</span>${timeHtml}${body}${rawJsonDetails(msg)}</div>`;
}

function renderLlmMessages(messages: Message[]): string {
	return messages
		.map(
			(m) =>
				`<div class="llm-msg"><span class="badge">${escapeHtml(m.role)}</span>${pre(textOfContent(m.content))}</div>`,
		)
		.join("\n");
}

const STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0; background: #181820; color: #e6e6ea; font: 13px/1.55 ui-sans-serif, system-ui, sans-serif; }
  .container { max-width: 980px; margin: 0 auto; padding: 24px 16px 80px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 22px 0 6px; }
  .subtle { color: #9a9aa6; font-size: 12px; }
  .card { background: #22222a; border: 1px solid #33333d; border-radius: 10px; padding: 12px 14px; margin: 12px 0; }
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 6px 18px; }
  .meta-grid div span { color: #9a9aa6; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 4px 0; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { font-family: ui-monospace, Menlo, monospace; background: #2c2c36; border-radius: 4px; padding: 1px 5px; }
  details { border: 1px solid #33333d; border-radius: 8px; margin: 6px 0; }
  details > summary { cursor: pointer; padding: 7px 10px; color: #9a9aa6; font-size: 12px; user-select: none; }
  details[open] > summary { border-bottom: 1px solid #33333d; }
  details > *:not(summary) { padding: 8px 10px; }
  .sub { background: #26262f; }
  .msg { border-left: 3px solid #44444f; padding: 8px 12px; margin: 10px 0; background: #22222a; border-radius: 6px; }
  .msg.user { border-left-color: #e08c3a; }
  .msg.assistant { border-left-color: #4a8fd4; }
  .msg.toolresult { border-left-color: #7a5fd0; }
  .msg.toolresult.error { border-left-color: #d44a4a; }
  .msg.nav, .msg.welcome, .msg.artifact { border-left-color: #4aa678; background: #1f2622; }
  .msg.compaction { border-left-color: #d4a24a; background: #26221a; }
  .badge { display: inline-block; font-size: 11px; font-weight: 600; color: #cfd0d8; background: #2c2c36; border-radius: 4px; padding: 1px 7px; margin-right: 8px; }
  .time { color: #7c7c88; font-size: 11px; }
  .usage { color: #7c7c88; font-size: 11px; margin-top: 4px; }
  .thinking { color: #a8a8b4; }
  .muted { color: #8a8a96; }
  .toolcall { margin: 6px 0; }
  .llm-msg { border-top: 1px solid #2c2c36; padding: 8px 0; }
  .llm-msg pre { max-height: 320px; overflow-y: auto; }
  a { color: #7db2e8; }
`;

export function buildSessionExportHtml(input: SessionExportInput): string {
	const { header } = input;
	const parts: string[] = [];

	parts.push(`<h1>${escapeHtml(header.title || "Untitled session")}</h1>`);
	parts.push(`<div class="subtle">Exported by Sitegeist on ${escapeHtml(new Date().toLocaleString())}</div>`);
	parts.push(`<div class="card meta-grid">`);
	parts.push(`<div><span>Session:</span> ${escapeHtml(header.sessionId)}</div>`);
	parts.push(
		`<div><span>Model:</span> ${escapeHtml(header.model)}${header.thinkingLevel ? ` (${escapeHtml(header.thinkingLevel)})` : ""}</div>`,
	);
	parts.push(`<div><span>Messages:</span> ${header.messageCount}</div>`);
	parts.push(
		`<div><span>Tokens:</span> ${header.totalTokens.toLocaleString()}${header.totalCost ? ` · $${header.totalCost.toFixed(4)}` : ""}</div>`,
	);
	parts.push(`</div>`);

	if (input.systemPrompt) {
		parts.push(
			`<details><summary>System Prompt (${input.systemPrompt.length.toLocaleString()} chars)</summary>${pre(input.systemPrompt)}</details>`,
		);
	}
	if (input.tools && input.tools.length > 0) {
		parts.push(`<details><summary>Tools (${input.tools.length})</summary>`);
		for (const tool of input.tools) {
			parts.push(
				`<div class="card"><code>${escapeHtml(tool.name)}</code> <span class="muted">${escapeHtml(tool.description)}</span></div>`,
			);
		}
		parts.push(`</details>`);
	}
	parts.push(
		`<details><summary>LLM Request View — actual prompt messages sent to the model (${input.llmMessages.length})</summary>${renderLlmMessages(input.llmMessages)}</details>`,
	);

	parts.push(`<h2>Transcript</h2>`);
	for (const msg of input.messages) {
		parts.push(renderMessage(msg));
	}

	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Sitegeist Session Export — ${escapeHtml(header.title || "Untitled session")}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="container">
${parts.join("\n")}
</div>
</body>
</html>`;
}
