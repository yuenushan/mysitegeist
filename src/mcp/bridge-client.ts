import { getSitegeistStorage } from "../storage/app-storage.js";
import { createMcpToolEntries, type McpToolEntry, toCatalog } from "./registry.js";

export const DEFAULT_MCP_PORT = 8377;

export type McpBridgeStatus = "disabled" | "connecting" | "connected" | "reconnecting" | "error";

export interface McpBridgeStatusInfo {
	status: McpBridgeStatus;
	port?: number;
	/** Human-readable failure detail, set for "reconnecting" and "error". */
	error?: string;
}

/** Reconnect delays; the last entry repeats until connected or disabled. */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

/** Messages the MCP bridge can send to the side panel. */
interface BridgeCallMessage {
	type: "call";
	id: number;
	tool: string;
	args?: unknown;
}
interface BridgeAbortMessage {
	type: "abort";
	id: number;
}
interface BridgePingMessage {
	type: "ping";
}
type BridgeMessage = BridgeCallMessage | BridgeAbortMessage | BridgePingMessage;

function isBridgeMessage(value: unknown): value is BridgeMessage {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return type === "call" || type === "abort" || type === "ping";
}

/**
 * Connects the side panel to the Sitegeist MCP bridge (scripts/mcp-bridge.mjs)
 * over a loopback WebSocket. The bridge relays MCP tool calls from clients
 * such as pi to the same AgentTool instances the sidepanel agent uses.
 *
 * Lifecycle: the panel connects out on load and reconnects with backoff while
 * the bridge is not running. When the panel is closed, the bridge reports
 * tool calls as failed until a panel connects again.
 */
export class McpBridgeClient {
	private tools: McpToolEntry[] = [];
	private ws: WebSocket | null = null;
	private enabled = false;
	private port = DEFAULT_MCP_PORT;
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private buildingTools = false;
	private startedOnce = false;
	private lastError: string | undefined;
	private pending = new Map<number, { controller: AbortController }>();
	private statusInfo: McpBridgeStatusInfo = { status: "disabled" };
	private statusListeners = new Set<(info: McpBridgeStatusInfo) => void>();

	/** Idempotent: connects when the bridge is enabled in settings. */
	async start(): Promise<void> {
		if (this.startedOnce) return;
		this.startedOnce = true;
		await this.loadAndConnect();
	}

	/** Re-read settings and (re)establish the connection. */
	async restart(): Promise<void> {
		this.teardownSocket();
		this.reconnectAttempt = 0;
		await this.loadAndConnect();
	}

	getStatus(): McpBridgeStatusInfo {
		return this.statusInfo;
	}

	onStatus(listener: (info: McpBridgeStatusInfo) => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	private async loadAndConnect(): Promise<void> {
		this.clearReconnectTimer();

		const storage = getSitegeistStorage();
		const enabled = await storage.settings.get<boolean>("mcp.enabled");
		this.enabled = enabled ?? true;
		const storedPort = await storage.settings.get<number>("mcp.port");
		this.port = typeof storedPort === "number" && storedPort > 0 ? storedPort : DEFAULT_MCP_PORT;

		if (!this.enabled) {
			this.setStatus({ status: "disabled", port: this.port });
			return;
		}

		if (this.tools.length === 0 && !this.buildingTools) {
			this.buildingTools = true;
			try {
				this.tools = await createMcpToolEntries();
			} catch (error) {
				console.error("[mcp] Failed to build MCP tool set:", error);
				this.setStatus({
					status: "error",
					port: this.port,
					error: error instanceof Error ? error.message : String(error),
				});
				return;
			} finally {
				this.buildingTools = false;
			}
		}

		this.setStatus({
			status: this.reconnectAttempt > 0 ? "reconnecting" : "connecting",
			port: this.port,
		});
		this.connect();
	}

	private connect(): void {
		let socket: WebSocket;
		try {
			socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			this.scheduleReconnect();
			return;
		}
		this.ws = socket;
		socket.onopen = () => {
			if (this.ws !== socket) return;
			this.reconnectAttempt = 0;
			this.lastError = undefined;
			this.send(socket, {
				type: "hello",
				version: chrome.runtime.getManifest().version,
				tools: toCatalog(this.tools),
			});
			this.setStatus({ status: "connected", port: this.port });
		};
		socket.onmessage = (event: MessageEvent) => {
			if (this.ws !== socket) return;
			this.handleMessage(socket, event.data);
		};
		socket.onclose = () => {
			this.handleSocketClosed(socket);
		};
		socket.onerror = () => {
			// No detail on the error event; the close event follows and drives reconnect.
			this.lastError = `Could not reach bridge on port ${this.port}`;
		};
	}

	private handleSocketClosed(socket: WebSocket): void {
		if (this.ws !== socket) return;
		this.ws = null;
		this.pending.clear();
		if (!this.enabled) {
			this.setStatus({ status: "disabled", port: this.port });
			return;
		}
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		this.clearReconnectTimer();
		const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
		this.reconnectAttempt++;
		this.setStatus({
			status: "reconnecting",
			port: this.port,
			error: this.lastError,
		});
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.enabled && !this.ws) this.connect();
		}, delay);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private teardownSocket(): void {
		this.clearReconnectTimer();
		const socket = this.ws;
		this.ws = null;
		this.pending.clear();
		if (!socket) return;
		socket.onopen = null;
		socket.onmessage = null;
		socket.onclose = null;
		socket.onerror = null;
		try {
			socket.close();
		} catch {
			// Already closed.
		}
	}

	private handleMessage(socket: WebSocket, data: unknown): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(typeof data === "string" ? data : String(data));
		} catch {
			return;
		}
		if (!isBridgeMessage(parsed)) return;

		if (parsed.type === "ping") {
			this.send(socket, { type: "pong" });
			return;
		}
		if (parsed.type === "abort") {
			this.pending.get(parsed.id)?.controller.abort();
			return;
		}
		if (parsed.type === "call") {
			void this.dispatchCall(socket, parsed.id, parsed.tool, parsed.args);
		}
	}

	private async dispatchCall(socket: WebSocket, id: number, toolName: string, args: unknown): Promise<void> {
		const controller = new AbortController();
		this.pending.set(id, { controller });

		let payload: Record<string, unknown>;
		try {
			const entry = this.tools.find((t) => t.tool.name === toolName);
			if (!entry) {
				throw new Error(
					`Unknown tool "${toolName}". The bridge catalog is stale - toggle the MCP Bridge setting to refresh.`,
				);
			}
			if (typeof args !== "object" || args === null || Array.isArray(args)) {
				throw new Error("Tool arguments must be an object");
			}
			await entry.prepare?.();
			const result = await entry.tool.execute(`mcp-${id}`, args as Record<string, unknown>, controller.signal);
			payload = {
				type: "result",
				id,
				ok: true,
				content: result.content,
				details: result.details,
			};
		} catch (error) {
			payload = {
				type: "result",
				id,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			this.pending.delete(id);
		}

		if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) return;
		this.send(socket, payload);
	}

	private send(socket: WebSocket, message: unknown): void {
		try {
			socket.send(JSON.stringify(message));
		} catch (error) {
			console.warn("[mcp] Failed to send message to bridge:", error);
		}
	}

	private setStatus(info: McpBridgeStatusInfo): void {
		this.statusInfo = info;
		for (const listener of this.statusListeners) {
			try {
				listener(info);
			} catch (error) {
				console.error("[mcp] Status listener failed:", error);
			}
		}
	}
}

let singleton: McpBridgeClient | null = null;

export function getMcpBridgeClient(): McpBridgeClient {
	if (!singleton) singleton = new McpBridgeClient();
	return singleton;
}
