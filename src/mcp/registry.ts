import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createExtractDocumentTool } from "@mariozechner/pi-web-ui";
import { getSitegeistStorage } from "../storage/app-storage.js";
import { AgentSchedulerTool } from "../tools/agent-scheduler.js";
import { AgentTaskTool } from "../tools/agent-task.js";
import { BookmarksTool } from "../tools/bookmarks.js";
import { BrowserExtensionsTool } from "../tools/browser-extensions.js";
import { BrowserWorkspaceTool } from "../tools/browser-workspace.js";
import { DebuggerTool } from "../tools/debugger.js";
import { ExtractImageTool } from "../tools/extract-image.js";
import { skillTool } from "../tools/index.js";
import { NativeInputEventsRuntimeProvider } from "../tools/NativeInputEventsRuntimeProvider.js";
import { NavigateTool } from "../tools/navigate.js";
import { HttpRuntimeProvider } from "../tools/repl/http.js";
import { createReplTool } from "../tools/repl/repl.js";
import { BrowserJsRuntimeProvider, NavigateRuntimeProvider } from "../tools/repl/runtime-providers.js";
import { SetupTool } from "../tools/setup.js";

/**
 * Tools exposed over the MCP bridge, in addition to the tool instance an
 * optional per-call prepare hook (runs before execute, e.g. to pin window
 * state for the current call).
 */
export interface McpToolEntry {
	tool: AgentTool<any, any>;
	prepare?: () => Promise<void>;
}

/** Tool descriptor announced to the MCP bridge via `hello`. */
export interface McpCatalogEntry {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

/**
 * Build the tool set exposed over MCP. This mirrors the sidepanel agent's
 * toolsFactory, minus tools that require interactive sidepanel UI
 * (ask_user_which_element). The debugger tool is only included when debugger
 * mode is enabled, matching the sidepanel agent.
 */
export async function createMcpToolEntries(): Promise<McpToolEntry[]> {
	const navigateTool = new NavigateTool();

	const replTool = createReplTool();
	replTool.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");
	// Same provider shape as the sidepanel agent, minus the ChatPanel-owned
	// attachment/artifact providers, which do not exist in the MCP path.
	replTool.runtimeProvidersFactory = () => {
		const httpProvider = new HttpRuntimeProvider();
		const pageProviders = [new NativeInputEventsRuntimeProvider(), httpProvider];
		return [...pageProviders, new BrowserJsRuntimeProvider(pageProviders), new NavigateRuntimeProvider(navigateTool)];
	};

	const extractDocumentTool = createExtractDocumentTool();
	const storage = getSitegeistStorage();
	const corsProxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
	const corsProxyUrl = await storage.settings.get<string>("proxy.url");
	if (corsProxyEnabled && corsProxyUrl) {
		extractDocumentTool.corsProxyUrl = `${corsProxyUrl}/?url=`;
	}

	const extractImageTool = new ExtractImageTool();
	const extractImageEntry: McpToolEntry = {
		tool: extractImageTool,
		// The sidepanel pins screenshots to its own window; resolve per call.
		prepare: async () => {
			const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
			extractImageTool.windowId = tab?.windowId;
		},
	};

	const entries: McpToolEntry[] = [
		{ tool: navigateTool },
		{ tool: replTool },
		{ tool: extractDocumentTool },
		extractImageEntry,
		{ tool: new BookmarksTool() },
		{ tool: new BrowserExtensionsTool() },
		{ tool: new BrowserWorkspaceTool() },
		{ tool: new AgentSchedulerTool() },
		{ tool: new AgentTaskTool() },
		{ tool: new SetupTool() },
		{ tool: skillTool },
	];

	const stored = await chrome.storage.local.get("debuggerMode");
	if (stored.debuggerMode) {
		entries.push({ tool: new DebuggerTool() });
	}

	return entries;
}

/** Convert tool entries into the catalog announced to the bridge. */
export function toCatalog(entries: McpToolEntry[]): McpCatalogEntry[] {
	return entries.map(({ tool }) => ({
		name: tool.name,
		description: String(tool.description),
		inputSchema: tool.parameters as unknown as Record<string, unknown>,
	}));
}
