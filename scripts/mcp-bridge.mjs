#!/usr/bin/env node

/**
 * Sitegeist MCP bridge.
 *
 * A stdio MCP server (for pi and other MCP clients) that relays tool calls
 * over a loopback WebSocket to the Sitegeist Chrome extension side panel:
 *
 *   MCP client (pi) --stdio--> this process <--ws://127.0.0.1:<port>-- side panel
 *
 * The side panel always connects out (the browser never accepts inbound
 * sockets). When it connects it announces its agent tools in a `hello`
 * message; the bridge exposes exactly that catalog via `tools/list` and
 * forwards `tools/call` requests to the panel. Tool results, errors and
 * cancellations are relayed back.
 *
 * Multiple MCP clients (pi sessions) can run at the same time. Only one
 * process can hold the WebSocket port, so:
 *
 * - The first bridge binds the port and becomes the MASTER: it serves the
 *   WebSocket endpoint for the side panel plus an HTTP JSON-RPC endpoint
 *   (POST /rpc) and health check (GET /health).
 * - Bridges that find the port taken probe /health; when the holder is a
 *   sitegeist bridge they become PROXIES: they serve their own stdio MCP
 *   client and forward requests to the master over /rpc. Proxies poll the
 *   tool catalog and re-announce changes to their client, and if the master
 *   dies a proxy takes over the port automatically.
 * - If the port is held by something that is not a sitegeist bridge, the
 *   process retries for a while (covers hot-reload restart races) and then
 *   exits with an error.
 *
 * The bridge is normally spawned by the MCP client itself (see
 * scripts/mcp-register.mjs); running it manually is only needed for
 * debugging or for other MCP clients:
 *
 *   node scripts/mcp-bridge.mjs [--port 8377]
 *
 * The port must match Settings > MCP Bridge in the extension (default 8377,
 * or the SITEGEIST_MCP_PORT environment variable).
 *
 * Logs go to stderr only; stdout carries the MCP protocol.
 */

import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let WebSocketServer;
try {
	({ WebSocketServer } = require("ws"));
} catch {
	console.error("[sitegeist-mcp] The 'ws' package is missing. Run 'npm install' in the sitegeist repo first.");
	process.exit(1);
}

const pkg = require("../package.json");

function log(message) {
	console.error(`[sitegeist-mcp] ${message}`);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const CLI_ARGS = process.argv.slice(2);
let port = Number(process.env.SITEGEIST_MCP_PORT) || 8377;
for (let i = 0; i < CLI_ARGS.length; i++) {
	if (CLI_ARGS[i] === "--port") {
		port = Number(CLI_ARGS[i + 1]);
		i++;
	} else if (CLI_ARGS[i]?.startsWith("--port=")) {
		port = Number(CLI_ARGS[i].slice("--port=".length));
	}
}
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
	log(`Invalid port: ${port}`);
	process.exit(1);
}

const BASE_URL = `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------------------
// Shared MCP state
// ---------------------------------------------------------------------------

/** Tool catalog announced by the side panel, or null before the first hello. */
let catalog = null;
let catalogJson = "null";
/** Live side panel connections (master only). */
const clients = new Set();
/** The connection tool calls are routed to (latest hello, or a survivor). */
let active = null;
/** callId -> { mcpId, ws, aborted } for in-flight tool calls (master only). */
const pendingCalls = new Map();
let nextCallId = 1;
/** MCP clients that received the initial state (for list_changed pushes). */
let stdioClientReady = false;
/** When true, the stdio pump forwards to the master instead of serving locally. */
let proxyMode = false;

const SERVER_INSTRUCTIONS =
	"Control the user's Chrome browser through the Sitegeist extension side panel. " +
	"Tools cover tab navigation and switching, in-page JavaScript via the repl tool " +
	"(browserjs and trusted input events), document and image extraction, bookmarks, " +
	"tab/history/downloads management, extension management, agent task scheduling and " +
	"browser skill authoring. The Sitegeist side panel must be open in Chrome; while it " +
	"is closed all tools fail. 'Current tab' means the active tab of the window the " +
	"panel is attached to.";

function makeInitializeResult(params) {
	const requested = params && typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
	return {
		protocolVersion: requested,
		capabilities: { tools: { listChanged: true } },
		serverInfo: { name: "sitegeist", version: pkg.version || "0.0.0" },
		instructions: SERVER_INSTRUCTIONS,
	};
}

function makeToolsList() {
	const tools = (catalog || []).map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
	}));
	return { tools };
}

/**
 * Handle an incoming JSON-RPC message (from stdio in master mode, or
 * forwarded over HTTP in proxy mode). Returns a response object for
 * requests, or null for notifications.
 */
async function handleRpcMessage(message) {
	if (typeof message !== "object" || message === null) return null;

	// A response from the client (we never send requests; ignore).
	if (!("method" in message)) return null;

	if (!("id" in message)) {
		// Notification.
		if (message.method === "notifications/cancelled") handleCancelled(message.params);
		return null;
	}

	const { id, method, params } = message;
	if (typeof id !== "number" && typeof id !== "string") return null;

	switch (method) {
		case "initialize":
			return makeInitializeResult(params);
		case "tools/list":
			return makeToolsList();
		case "tools/call":
			return handleToolsCall(id, params);
		case "ping":
			return {};
		default:
			return { jsonrpcError: { code: -32601, message: `Method not found: ${method}` } };
	}
}

function handleCancelled(params) {
	if (typeof params?.requestId !== "number" && typeof params?.requestId !== "string") return;
	for (const [callId, entry] of pendingCalls) {
		if (entry.mcpId !== params.requestId) continue;
		entry.aborted = true;
		if (entry.ws && entry.ws.readyState === 1) {
			try {
				entry.ws.send(JSON.stringify({ type: "abort", id: callId }));
			} catch {
				// Connection is going away regardless.
			}
		}
		log(`call #${callId} cancelled by client`);
	}
}

async function handleToolsCall(id, params) {
	const name = params?.name;
	if (typeof name !== "string") {
		return { jsonrpcError: { code: -32602, message: "tools/call requires a tool name" } };
	}
	const args = params?.arguments ?? {};
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return { jsonrpcError: { code: -32602, message: "tools/call arguments must be an object" } };
	}
	if (!active || active.readyState !== 1) {
		return {
			content: [
				{
					type: "text",
					text: "Sitegeist side panel is not connected. Open the Sitegeist side panel in Chrome; the panel connects to the bridge automatically.",
				},
			],
			isError: true,
		};
	}

	const callId = nextCallId++;
	pendingCalls.set(callId, { mcpId: id, ws: active, aborted: false });
	const payload = JSON.stringify({ type: "call", id: callId, tool: name, args });
	log(`call #${callId} -> ${name}`);
	try {
		active.send(payload);
	} catch (error) {
		pendingCalls.delete(callId);
		return {
			content: [{ type: "text", text: `Failed to forward tool call: ${error?.message || error}` }],
			isError: true,
		};
	}
	// The response is sent asynchronously by handleExtensionResult.
	return undefined;
}

function respond(id, handlerResult) {
	if (handlerResult === undefined) return; // tools/call still in flight
	if (handlerResult?.jsonrpcError) {
		sendStdio({ jsonrpc: "2.0", id, error: handlerResult.jsonrpcError });
		return;
	}
	sendStdio({ jsonrpc: "2.0", id, result: handlerResult ?? {} });
}

// ---------------------------------------------------------------------------
// Master: side panel WebSocket relay + HTTP /rpc forwarding endpoint
// ---------------------------------------------------------------------------

function setCatalogFromHello(tools) {
	const json = JSON.stringify(tools ?? null);
	if (json === catalogJson) return false;
	catalogJson = json;
	catalog = tools ?? [];
	return true;
}

function notifyToolsChanged() {
	if (!stdioClientReady) return;
	sendStdio({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
}

function handleClientMessage(ws, data) {
	let message;
	try {
		message = JSON.parse(data.toString());
	} catch {
		return;
	}
	if (typeof message !== "object" || message === null) return;

	switch (message.type) {
		case "hello": {
			if (!clients.has(ws)) return;
			const changed = setCatalogFromHello(message.tools);
			active = ws;
			const names = (catalog || []).map((tool) => tool.name).join(", ");
			log(`side panel v${message.version || "?"} connected (${(catalog || []).length} tools: ${names})`);
			if (changed) notifyToolsChanged();
			break;
		}
		case "result": {
			const entry = pendingCalls.get(message.id);
			if (!entry || entry.ws !== ws) return;
			pendingCalls.delete(message.id);
			const mcpId = entry.mcpId;
			if (entry.aborted) {
				// The client already cancelled; pi drops unknown responses with a
				// log entry, so swallow late results instead.
				log(`call #${message.id} result arrived after cancellation, dropped`);
				return;
			}
			if (message.ok) {
				const result = {
					content: Array.isArray(message.content) ? message.content : [{ type: "text", text: "(empty result)" }],
				};
				if (message.details !== undefined && message.details !== null) {
					result.structuredContent = message.details;
				}
				deliverResult(mcpId, { result });
				log(`call #${message.id} ok`);
			} else {
				deliverResult(mcpId, {
					result: {
						content: [{ type: "text", text: `Error: ${message.error || "unknown error"}` }],
						isError: true,
					},
				});
				log(`call #${message.id} failed: ${message.error}`);
			}
			break;
		}
		case "pong":
			break;
		default:
			break;
	}
}

/**
 * Deliver a tools/call response. Master-mode calls made on behalf of a proxy
 * (via HTTP /rpc) carry an httpWaiter; their results go to the HTTP response
 * instead of our own stdio client.
 */
function deliverResult(mcpId, response) {
	const waiter = httpWaiters.get(mcpId);
	if (waiter) {
		httpWaiters.delete(mcpId);
		waiter(response);
		return;
	}
	if ("result" in response) rpcResult(mcpId, response.result);
	else if ("error" in response) rpcError(mcpId, response.error.code, response.error.message);
}

/** mcpId -> resolve callback for tools/call requests forwarded over HTTP. */
const httpWaiters = new Map();

function cleanupClient(ws) {
	clients.delete(ws);
	if (active === ws) {
		active = null;
		// Fail in-flight calls that were routed to the dead connection.
		for (const [callId, entry] of pendingCalls) {
			if (entry.ws !== ws) continue;
			pendingCalls.delete(callId);
			if (!entry.aborted) {
				deliverResult(entry.mcpId, {
					result: {
						content: [
							{ type: "text", text: "Sitegeist side panel disconnected while the tool call was running." },
						],
						isError: true,
					},
				});
			}
		}
		// Promote another live panel so later calls keep working.
		for (const candidate of clients) {
			if (candidate.readyState === 1) {
				active = candidate;
				log("switched active side panel connection");
				break;
			}
		}
	}
	log(`side panel disconnected (${clients.size} remaining)`);
}

function startMaster(httpServer) {
	proxyMode = false;
	const handleMasterRequest = (req, res) => {
		if (req.method === "GET" && req.url === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ sitegeist: true, role: "master" }));
			return;
		}
		if (req.method === "POST" && req.url === "/rpc") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", async () => {
				let message;
				try {
					message = JSON.parse(body);
				} catch {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "invalid JSON" }));
					return;
				}
				const isRequest = message && typeof message === "object" && "method" in message && "id" in message;
				const reply = (responseObj) => {
					if (!res.writableEnded) {
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify(responseObj));
					}
				};
				const normalize = (r) => (r?.jsonrpcError ? { error: r.jsonrpcError } : { result: r ?? {} });
				try {
					if (!isRequest) {
						await handleRpcMessage(message);
						res.writeHead(204);
						res.end();
						return;
					}
					if (message.method !== "tools/call") {
						reply(normalize(await handleRpcMessage(message)));
						return;
					}
					// tools/call: park the HTTP response until the side panel replies.
					const timer = setTimeout(() => {
						if (httpWaiters.delete(message.id)) {
							reply({
								result: {
									content: [{ type: "text", text: "Bridge timed out waiting for the side panel." }],
									isError: true,
								},
							});
						}
					}, 300000);
					httpWaiters.set(message.id, reply);
					const syncResult = await handleRpcMessage(message);
					if (syncResult !== undefined) {
						// Rejected before reaching the panel (bad args, no panel, ...).
						clearTimeout(timer);
						httpWaiters.delete(message.id);
						reply(normalize(syncResult));
					}
				} catch (error) {
					if (!res.writableEnded) {
						res.writeHead(500, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: error?.message || String(error) }));
					}
				}
			});
			return;
		}
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("sitegeist mcp bridge: WebSocket endpoint or /rpc\n");
	};
	httpServer.on("request", handleMasterRequest);

	const wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024 * 1024 });

	wss.on("connection", (ws, request) => {
		log(`inbound connection from ${request.socket.remoteAddress} (origin: ${request.headers.origin || "none"})`);
		clients.add(ws);
		ws.isAlive = true;
		ws.on("pong", () => {
			ws.isAlive = true;
		});
		ws.on("message", (data) => handleClientMessage(ws, data));
		ws.on("close", () => cleanupClient(ws));
		ws.on("error", (error) => log(`side panel connection error: ${error?.message || error}`));
	});

	// Drop connections that stop answering pings (half-open sockets).
	const heartbeat = setInterval(() => {
		for (const ws of clients) {
			if (!ws.isAlive) {
				ws.terminate();
				continue;
			}
			ws.isAlive = false;
			try {
				ws.ping();
			} catch {
				ws.terminate();
			}
		}
	}, 25000);

	httpServer.on("error", (error) => {
		// Should not happen: we only start the master after binding succeeded.
		log(`WebSocket server error: ${error?.message || error}`);
		process.exit(1);
	});

	log(`master: listening on ws://127.0.0.1:${port} (waiting for the Sitegeist side panel to connect)`);

	const shutdownMaster = () => {
		clearInterval(heartbeat);
		try {
			wss.close();
		} catch {
			// Ignore.
		}
		for (const ws of clients) {
			try {
				ws.terminate();
			} catch {
				// Ignore.
			}
		}
		process.exit(0);
	};
	process.on("SIGINT", () => shutdownMaster());
	process.on("SIGTERM", () => shutdownMaster());
}

// ---------------------------------------------------------------------------
// stdio transport (newline-delimited JSON-RPC)
// ---------------------------------------------------------------------------

function sendStdio(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcResult(id, result) {
	sendStdio({ jsonrpc: "2.0", id, result });
}

function rpcError(id, code, message) {
	sendStdio({ jsonrpc: "2.0", id, error: { code, message } });
}

let stdioBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	stdioBuffer += chunk;
	for (;;) {
		const newlineIndex = stdioBuffer.indexOf("\n");
		if (newlineIndex < 0) break;
		const line = stdioBuffer.slice(0, newlineIndex);
		stdioBuffer = stdioBuffer.slice(newlineIndex + 1);
		const trimmed = line.trim();
		if (!trimmed) continue;
		void (proxyMode ? proxyHandleLine(trimmed) : onStdioLine(trimmed));
	}
});
process.stdin.on("end", () => {
	log("stdin closed, shutting down");
	process.exit(0);
});

async function onStdioLine(line) {
	let message;
	try {
		message = JSON.parse(line);
	} catch (error) {
		log(`Failed to parse message: ${error?.message || error}`);
		return;
	}
	const isRequest = typeof message === "object" && message !== null && "id" in message;
	if (isRequest && message.method === "initialize") stdioClientReady = true;
	const response = await handleRpcMessage(message);
	// undefined = tools/call still in flight (answered via the side panel); null = notification
	if (isRequest && response !== undefined) respond(message.id, response);
}

// ---------------------------------------------------------------------------
// Proxy mode: forward stdio MCP to the master over HTTP /rpc
// ---------------------------------------------------------------------------

const PROXY_POLL_MS = 5000;
const PROXY_RETRY_MS = 2000;

/** Unique prefix so concurrent proxies never collide in the master's maps. */
const PROXY_NONCE = Math.random().toString(36).slice(2, 10);
let proxySeq = 0;
/** stdio id -> forwarded ("p<n>") id, so cancellations map correctly. */
const proxyForwarded = new Map();

async function rpcFetch(body) {
	const res = await fetch(`${BASE_URL}/rpc`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (res.status === 204) return undefined;
	return res.json();
}

async function proxyHandleLine(line) {
	let message;
	try {
		message = JSON.parse(line);
	} catch (error) {
		log(`Failed to parse message: ${error?.message || error}`);
		return;
	}
	if (typeof message !== "object" || message === null || !("method" in message)) return;

	if (!("id" in message)) {
		// Notification: forward. Cancellations must be re-id'd to match the
		// forwarded ids the master knows about.
		if (message.method === "notifications/cancelled") {
			const forwarded = proxyForwarded.get(message.params?.requestId);
			if (forwarded !== undefined) {
				message = { ...message, params: { ...message.params, requestId: forwarded } };
			} else {
				return; // response already arrived; nothing to cancel
			}
		}
		try {
			await rpcFetch(message);
		} catch {
			log("master unreachable, dropped notification");
		}
		return;
	}

	const { id, method, params } = message;

	switch (method) {
		case "initialize":
			stdioClientReady = true;
			sendStdio({ jsonrpc: "2.0", id, result: makeInitializeResult(params) });
			return;
		case "ping":
			sendStdio({ jsonrpc: "2.0", id, result: {} });
			return;
		default:
			break;
	}

	// Everything else goes to the master. Requests are re-id'd ("p-<nonce>-<n>")
	// so concurrent proxies never collide with each other's ids in the master.
	const forwardedId = `p-${PROXY_NONCE}-${++proxySeq}`;
	if (typeof id === "number" || typeof id === "string") proxyForwarded.set(id, forwardedId);
	try {
		const response = await rpcFetch({
			jsonrpc: "2.0",
			id: forwardedId,
			method,
			...(params !== undefined ? { params } : {}),
		});
		proxyForwarded.delete(id);
		if (response?.error) {
			sendStdio({ jsonrpc: "2.0", id, error: response.error });
		} else if (response && "result" in response) {
			sendStdio({ jsonrpc: "2.0", id, result: response.result });
		} else {
			sendStdio({ jsonrpc: "2.0", id, result: {} });
		}
	} catch (error) {
		proxyForwarded.delete(id);
		sendStdio({
			jsonrpc: "2.0",
			id,
			error: { code: -32000, message: `Sitegeist master bridge unreachable: ${error?.message || error}` },
		});
		// The master may have died; try to take over its port.
		void promoteIfMasterGone();
	}
}

let promoting = false;
async function promoteIfMasterGone() {
	if (promoting) return;
	promoting = true;
	try {
		const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1500) });
		if (res.ok) return; // master still alive; transient error
	} catch {
		// Master is gone: try to become it.
	} finally {
		promoting = false;
	}
	const bound = await tryBind();
	if (bound) {
		if (proxyPollTimer) clearInterval(proxyPollTimer);
		if (proxyKeepAlive) clearInterval(proxyKeepAlive);
		log("promoted to master after previous master disappeared");
		startMaster(bound);
	}
}

let lastForwardedCatalog = "null";
async function pollCatalog() {
	if (!stdioClientReady) return;
	try {
		const response = await rpcFetch({ jsonrpc: "2.0", id: `poll${Date.now()}`, method: "tools/list" });
		const json = JSON.stringify(response?.result?.tools ?? null);
		if (json !== lastForwardedCatalog) {
			const hadPrevious = lastForwardedCatalog !== "null";
			lastForwardedCatalog = json;
			if (hadPrevious || stdioClientReady) {
				sendStdio({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
			}
		}
	} catch {
		// Master hiccup; check whether it died and take over if so.
		void promoteIfMasterGone();
	}
}

let proxyPollTimer = null;
let proxyKeepAlive = null;

function startProxy() {
	proxyMode = true;
	log(`proxy: forwarding to master on ${BASE_URL}`);
	proxyPollTimer = setInterval(() => void pollCatalog(), PROXY_POLL_MS);
	// First poll right away so an already-connected panel's catalog appears
	// in tools/list_changed as soon as the client initializes.
	void pollCatalog();
	proxyKeepAlive = setInterval(() => {}, 1 << 30); // keep the process alive
	process.on("SIGINT", () => {
		clearInterval(proxyKeepAlive);
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		clearInterval(proxyKeepAlive);
		process.exit(0);
	});
}

// ---------------------------------------------------------------------------
// Startup: try to become master; fall back to proxy; retry on races
// ---------------------------------------------------------------------------

const BIND_RETRY_MS = 500;
const BIND_RETRY_WINDOW_MS = 15000;

function tryBind() {
	return new Promise((resolve) => {
		// A bare server: if binding succeeds, startMaster() attaches the request
		// handler and the WebSocket upgrade to THIS server (no re-bind race).
		const server = createServer();
		let settled = false;
		server.once("error", () => {
			if (!settled) {
				settled = true;
				resolve(null);
			}
		});
		server.listen(port, "127.0.0.1", () => {
			if (!settled) {
				settled = true;
				resolve(server);
			}
		});
	});
}

async function isSitegeistBridge() {
	try {
		const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1500) });
		if (!res.ok) return false;
		const body = await res.json();
		return body?.sitegeist === true;
	} catch {
		return false;
	}
}

async function main() {
	const deadline = Date.now() + BIND_RETRY_WINDOW_MS;
	for (;;) {
		const bound = await tryBind();
		if (bound) {
			// We own the port: attach the master handlers to the bound server.
			startMaster(bound);
			return;
		}
		if (await isSitegeistBridge()) {
			startProxy();
			return;
		}
		if (Date.now() >= deadline) {
			log(
				`Port ${port} is in use by another process (not a sitegeist bridge). Stop it or pick another port via --port.`,
			);
			process.exit(1);
		}
		// Another sitegeist bridge may be mid-restart (hot reload race); retry.
		await new Promise((resolve) => setTimeout(resolve, BIND_RETRY_MS));
	}
}

void main();

// Guard against EPIPE when the MCP client disappears mid-write.
process.stdout.on("error", (error) => {
	if (error?.code === "EPIPE") process.exit(0);
});
process.on("uncaughtException", (error) => {
	log(`Uncaught exception: ${error?.stack || error}`);
});
