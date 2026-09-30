import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

// ============================================================================
// SESSION EXPORT (like pi's /export): builds a standalone HTML page that
// embeds the full session data (base64, same technique as pi) and renders it
// client-side with zero dependencies. Shows metadata, the system prompt, the
// tool list, the raw transcript, the LLM-transformed request view, and a raw
// JSON view per message.
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

// Template rendered client-side: DATA (base64 json) drives everything so the
// file stays self-contained and no server-side escaping issues can occur.
const TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Sitegeist Session Export</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #181820; color: #e6e6ea; font: 13px/1.55 ui-sans-serif, system-ui, sans-serif; }
  .container { max-width: 980px; margin: 0 auto; padding: 24px 16px 80px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
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
</style>
</head>
<body>
<div class="container" id="app"></div>
<script>
(function () {
  var app = document.getElementById("app");
  var data;
  try {
    data = JSON.parse(decodeURIComponent(escape(atob("__SESSION_DATA__"))));
  } catch (e) {
    app.textContent = "Failed to decode session data: " + e.message;
    return;
  }
  function esc(t) {
    return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  var html = [];
  html.push("<h1>" + esc(data.header.title || "Untitled session") + "</h1>");
  html.push("<div class='subtle'>Exported by Sitegeist on " + new Date().toLocaleString() + "</div>");
  html.push("<div class='card meta-grid'>");
  html.push("<div><span>Session:</span> " + esc(data.header.sessionId) + "</div>");
  html.push("<div><span>Model:</span> " + esc(data.header.model) + (data.header.thinkingLevel ? " (" + esc(data.header.thinkingLevel) + ")" : "") + "</div>");
  html.push("<div><span>Messages:</span> " + data.header.messageCount + "</div>");
  html.push("<div><span>Tokens:</span> " + data.header.totalTokens.toLocaleString() + (data.header.totalCost ? " · $" + data.header.totalCost.toFixed(4) : "") + "</div>");
  html.push("</div>");
  if (data.systemPrompt) {
    html.push("<details><summary>System Prompt (" + data.systemPrompt.length.toLocaleString() + " chars)</summary><pre>" + esc(data.systemPrompt) + "</pre></details>");
  }
  if (data.tools && data.tools.length) {
    html.push("<details><summary>Tools (" + data.tools.length + ")</summary>");
    data.tools.forEach(function (t) {
      html.push("<div class='card'><code>" + esc(t.name) + "</code> <span class='muted'>" + esc(t.description || "") + "</span></div>");
    });
    html.push("</details>");
  }
  html.push("<details><summary>LLM Request View - actual prompt messages sent to the model (" + data.llmMessages.length + ")</summary>");
  html.push(renderLlm(data.llmMessages));
  html.push("</details>");
  html.push("<h1 style='font-size:14px;margin-top:20px'>Transcript</h1>");
  data.messages.forEach(function (m) {
    html.push(renderMessage(m));
  });
  app.innerHTML = html.join("\\n");

  function badge(role) { return "<span class='badge'>" + esc(role) + "</span>"; }
  function timeOf(m) { return m.timestamp ? "<span class='time'>" + new Date(m.timestamp).toLocaleString() + "</span>" : ""; }
  function pre(t, cls) { return "<pre" + (cls ? " class='" + cls + "'" : "") + ">" + esc(t) + "</pre>"; }
  function textOf(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map(function (b) { return b.type === "text" ? (b.text || "") : "[" + (b.type || "block") + "]"; }).join("\\n");
    }
    return JSON.stringify(content, null, 2);
  }
  function renderMessage(m) {
    var cls = m.role === "user" || m.role === "user-with-attachments" ? "user"
      : m.role === "assistant" ? "assistant"
      : m.role === "toolResult" ? (m.isError ? "toolresult error" : "toolresult")
      : m.role === "navigation" || m.role === "welcome" || m.role === "artifact" ? "nav"
      : m.role === "compaction" ? "compaction" : "other";
    var out = "<div class='msg " + cls + "'>" + badge(m.role) + timeOf(m);
    if (m.role === "assistant") {
      if (Array.isArray(m.content)) {
        m.content.forEach(function (b) {
          if (b.type === "text") out += pre(b.text || "");
          else if (b.type === "thinking") out += "<details class='sub'><summary>Thinking</summary>" + pre(b.thinking || "", "thinking") + "</details>";
          else if (b.type === "toolCall") out += "<div class='toolcall'>Tool call: <code>" + esc(b.name || "") + "</code><details class='sub'><summary>arguments</summary>" + pre(JSON.stringify(b.arguments || {}, null, 2)) + "</details></div>";
          else out += pre("[" + (b.type || "block") + "]", "muted");
        });
      }
      if (m.usage) {
        var parts = [];
        if (m.usage.input) parts.push("\\u2191" + m.usage.input.toLocaleString());
        if (m.usage.output) parts.push("\\u2193" + m.usage.output.toLocaleString());
        if (m.usage.cost && m.usage.cost.total) parts.push("$" + m.usage.cost.total.toFixed(4));
        if (parts.length) out += "<div class='usage'>" + parts.join(" \\u00b7 ") + "</div>";
      }
    } else if (m.role === "toolResult") {
      out += pre(textOf(m.content));
    } else if (m.role === "navigation") {
      out += "<div>Navigated to <a href='" + esc(m.url || "") + "'>" + esc(m.title || m.url || "") + "</a></div>";
    } else if (m.role === "compaction") {
      out += "<div class='muted'>Context compacted (~" + (m.tokensBefore || 0).toLocaleString() + " tokens summarized)</div>" + pre(m.summary || "");
    } else {
      out += pre(textOf(m.content));
    }
    out += "<details class='sub'><summary>Raw JSON</summary>" + pre(JSON.stringify(m, null, 2)) + "</details>";
    return out + "</div>";
  }
  function renderLlm(msgs) {
    return msgs.map(function (m) {
      return "<div class='llm-msg'>" + badge(m.role) + pre(textOf(m.content)) + "</div>";
    }).join("");
  }
})();
</script>
</body>
</html>`;

/** UTF-8 safe base64 (btoa chokes on non-latin1; chunk to avoid stack overflow). */
function toBase64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

export function buildSessionExportHtml(input: SessionExportInput): string {
	const payload = {
		header: input.header,
		systemPrompt: input.systemPrompt ?? "",
		tools: input.tools ?? [],
		messages: input.messages,
		llmMessages: input.llmMessages,
	};
	return TEMPLATE.replace("__SESSION_DATA__", toBase64(JSON.stringify(payload)));
}
