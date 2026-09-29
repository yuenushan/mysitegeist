import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { registerToolRenderer, renderHeader, type ToolRenderer, type ToolRenderResult } from "@mariozechner/pi-web-ui";
import { type Static, Type } from "@sinclair/typebox";
import { html } from "lit";
import { LayoutGrid } from "lucide";

const WORKSPACE_TOOL_DESCRIPTION = `Manage the browser workspace: tabs, tab groups, history, recently closed sessions, downloads and the reading list.

Operations:
- list_tabs: List open tabs (optionally filter by URL substring or group title). Includes id, title, url, groupId, pinned, audible, muted.
- close_tabs: Close tabs by ids. Closing MORE than 5 tabs requires confirm: true (destructive).
- group_tabs: Put tabs into a (new) group with optional title and color. Colors: grey, blue, red, yellow, green, pink, purple, cyan, orange.
- ungroup_tabs: Remove tabs from their group.
- search_history: Search browsing history. Defaults: last 30 days, max 50 results.
- recently_closed: List recently closed tabs/windows (max 20).
- restore_closed: Reopen a recently closed tab/window. Without sessionId restores the most recent one.
- list_downloads: List download items (optionally filter by query string or state: in_progress/complete/interrupted).
- download_action: Control a download: pause | resume | cancel | show (open containing folder) | open (open the file).
- reading_list: Reading list operations (keyed by URL): add {url, title?} | list | mark_read {readingUrl, hasBeenRead?} | remove {readingUrl}.

Notes:
- Tab/group/download ids are numbers; reading list ids are strings. Fetch ids via the list operations first.
- There are deliberately no operations to clear history or reading list data (accident prevention).
- close_tabs (>5) and download_action 'cancel' are destructive and require confirm: true.`;

const workspaceSchema = Type.Object({
	operation: Type.Union(
		[
			Type.Literal("list_tabs"),
			Type.Literal("close_tabs"),
			Type.Literal("group_tabs"),
			Type.Literal("ungroup_tabs"),
			Type.Literal("search_history"),
			Type.Literal("recently_closed"),
			Type.Literal("restore_closed"),
			Type.Literal("list_downloads"),
			Type.Literal("download_action"),
			Type.Literal("reading_list"),
		],
		{ description: "Which workspace operation to perform" },
	),
	ids: Type.Optional(
		Type.Array(Type.Number(), { description: "Tab ids (for 'close_tabs', 'group_tabs', 'ungroup_tabs')" }),
	),
	filter: Type.Optional(
		Type.Object(
			{
				url: Type.Optional(Type.String({ description: "Only tabs whose URL contains this substring" })),
				groupTitle: Type.Optional(Type.String({ description: "Only tabs in the group with this title" })),
			},
			{ description: "Filter for 'list_tabs'" },
		),
	),
	groupTitle: Type.Optional(Type.String({ description: "Group title for 'group_tabs'" })),
	color: Type.Optional(
		Type.Union(
			[
				Type.Literal("grey"),
				Type.Literal("blue"),
				Type.Literal("red"),
				Type.Literal("yellow"),
				Type.Literal("green"),
				Type.Literal("pink"),
				Type.Literal("purple"),
				Type.Literal("cyan"),
				Type.Literal("orange"),
			],
			{ description: "Group color for 'group_tabs'" },
		),
	),
	query: Type.Optional(
		Type.Union([Type.String({ description: "Free-text query (for 'search_history', 'list_downloads')" })], {
			description: "Query text",
		}),
	),
	daysBack: Type.Optional(Type.Number({ description: "How many days back to search history (default 30)" })),
	max: Type.Optional(
		Type.Number({ description: "Max results for 'search_history' (default 50) or 'list_downloads' (default 50)" }),
	),
	state: Type.Optional(
		Type.Union([Type.Literal("in_progress"), Type.Literal("complete"), Type.Literal("interrupted")], {
			description: "Download state filter for 'list_downloads'",
		}),
	),
	sessionId: Type.Optional(Type.String({ description: "Session id for 'restore_closed' (from recently_closed)" })),
	id: Type.Optional(Type.Number({ description: "Download id for 'download_action'" })),
	action: Type.Optional(
		Type.Union(
			[
				Type.Literal("pause"),
				Type.Literal("resume"),
				Type.Literal("cancel"),
				Type.Literal("show"),
				Type.Literal("open"),
			],
			{ description: "Action for 'download_action'" },
		),
	),
	confirm: Type.Optional(
		Type.Boolean({
			description: "Must be true for close_tabs of more than 5 tabs, and for download_action 'cancel'",
		}),
	),
	readingAction: Type.Optional(
		Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("mark_read"), Type.Literal("remove")], {
			description: "Sub-action for 'reading_list'",
		}),
	),
	readingUrl: Type.Optional(Type.String({ description: "Reading list entry URL (for 'mark_read', 'remove')" })),
	hasBeenRead: Type.Optional(Type.Boolean({ description: "Read state for 'mark_read' (default true)" })),
	url: Type.Optional(Type.String({ description: "URL for reading_list 'add'" })),
	title: Type.Optional(Type.String({ description: "Title for reading_list 'add'" })),
});

type WorkspaceParams = Static<typeof workspaceSchema>;

interface WorkspaceDetails {
	operation: string;
	count: number;
	summary: string;
}

function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	const message = typeof error === "string" ? error : (error as { message?: string })?.message;
	return new Error(message || "Unknown Chrome API error");
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw toError(error);
	}
}

function slimTab(tab: chrome.tabs.Tab) {
	const out: Record<string, unknown> = {
		id: tab.id,
		title: tab.title,
		url: tab.url,
		groupId: tab.groupId,
		pinned: tab.pinned,
	};
	if (tab.audible !== undefined) out.audible = tab.audible;
	if (tab.mutedInfo) out.muted = tab.mutedInfo.muted;
	if (tab.windowId !== undefined) out.windowId = tab.windowId;
	return out;
}

const HISTORY_MAX_RESULTS = 100;
const DOWNLOAD_MAX_RESULTS = 100;

// ============================================================================
// TOOL
// ============================================================================

export class BrowserWorkspaceTool implements AgentTool<typeof workspaceSchema, WorkspaceDetails> {
	label = "Workspace";
	name = "browser_workspace";
	description = WORKSPACE_TOOL_DESCRIPTION;
	parameters = workspaceSchema;

	async execute(
		_toolCallId: string,
		args: WorkspaceParams,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<WorkspaceDetails>> {
		switch (args.operation) {
			case "list_tabs":
				return this.listTabs(args.filter);
			case "close_tabs":
				return this.closeTabs(args.ids, args.confirm === true);
			case "group_tabs":
				return this.groupTabs(args);
			case "ungroup_tabs":
				return this.ungroupTabs(args.ids);
			case "search_history":
				return this.searchHistory(args);
			case "recently_closed":
				return this.recentlyClosed();
			case "restore_closed":
				return this.restoreClosed(args.sessionId);
			case "list_downloads":
				return this.listDownloads(args);
			case "download_action":
				return this.downloadAction(args.id, args.action, args.confirm === true);
			case "reading_list":
				return this.readingList(args);
			default:
				throw new Error(`Unknown operation: ${args.operation}`);
		}
	}

	private async listTabs(
		filter: { url?: string; groupTitle?: string } | undefined,
	): Promise<AgentToolResult<WorkspaceDetails>> {
		const tabs = await call(() => chrome.tabs.query({}));
		let groups: Map<number, string> | undefined;
		if (filter?.groupTitle) {
			groups = new Map((await call(() => chrome.tabGroups.query({}))).map((g) => [g.id, g.title ?? ""]));
		}

		const visible = tabs
			.filter((tab) => {
				if (!tab.url || tab.url.startsWith("chrome-extension://")) return false;
				if (filter?.url && !tab.url.includes(filter.url)) return false;
				if (filter?.groupTitle) {
					if (tab.groupId === undefined || tab.groupId === -1) return false;
					if (groups?.get(tab.groupId) !== filter.groupTitle) return false;
				}
				return true;
			})
			.map(slimTab);

		const details: WorkspaceDetails = {
			operation: "list_tabs",
			count: visible.length,
			summary: `Listed ${visible.length} tab(s)`,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(visible) }],
			details,
		};
	}

	private async closeTabs(ids: number[] | undefined, confirm: boolean): Promise<AgentToolResult<WorkspaceDetails>> {
		if (!ids || ids.length === 0) throw new Error("'ids' (tab id array) is required for close_tabs operation");
		if (ids.length > 5 && !confirm) {
			throw new Error(
				`close_tabs is about to close ${ids.length} tabs. This is destructive — re-run with confirm: true to proceed.`,
			);
		}

		const closed: { id: number; title?: string }[] = [];
		for (const id of ids) {
			const tab = await call(() => chrome.tabs.get(id));
			await call(() => chrome.tabs.remove(id));
			closed.push({ id, title: tab.title });
		}

		const details: WorkspaceDetails = {
			operation: "close_tabs",
			count: closed.length,
			summary: `Closed ${closed.length} tab(s)`,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(closed) }],
			details,
		};
	}

	private async groupTabs(args: WorkspaceParams): Promise<AgentToolResult<WorkspaceDetails>> {
		if (!args.ids || args.ids.length === 0)
			throw new Error("'ids' (tab id array) is required for group_tabs operation");

		// The typings want a single id or a non-empty tuple; the runtime accepts any array
		const groupId = await call(() => chrome.tabs.group({ tabIds: args.ids as [number, ...number[]] }));
		let finalTitle: string | undefined;
		const update: chrome.tabGroups.UpdateProperties = {};
		if (args.title !== undefined) update.title = args.title;
		if (args.color !== undefined) update.color = args.color as chrome.tabGroups.Color;
		if (Object.keys(update).length > 0) {
			const group = await call(() => chrome.tabGroups.update(groupId, update));
			finalTitle = group?.title;
		}

		const details: WorkspaceDetails = {
			operation: "group_tabs",
			count: args.ids.length,
			summary: `Grouped ${args.ids.length} tab(s) into group ${groupId}${finalTitle ? ` ("${finalTitle}")` : ""}`,
		};
		return {
			content: [{ type: "text", text: JSON.stringify({ groupId, tabIds: args.ids, ...update }) }],
			details,
		};
	}

	private async ungroupTabs(ids: number[] | undefined): Promise<AgentToolResult<WorkspaceDetails>> {
		if (!ids || ids.length === 0) throw new Error("'ids' (tab id array) is required for ungroup_tabs operation");
		// The typings want a single id or a non-empty tuple; the runtime accepts any array
		await call(() => chrome.tabs.ungroup(ids as [number, ...number[]]));

		const details: WorkspaceDetails = {
			operation: "ungroup_tabs",
			count: ids.length,
			summary: `Ungrouped ${ids.length} tab(s)`,
		};
		return {
			content: [{ type: "text", text: `Ungrouped ${ids.length} tab(s)` }],
			details,
		};
	}

	private async searchHistory(args: WorkspaceParams): Promise<AgentToolResult<WorkspaceDetails>> {
		if (args.query === undefined) throw new Error("'query' is required for search_history operation");
		const daysBack = args.daysBack ?? 30;
		const max = Math.min(args.max ?? 50, HISTORY_MAX_RESULTS);
		const startTime = Date.now() - daysBack * 24 * 60 * 60 * 1000;

		const results = await call(() => chrome.history.search({ text: args.query ?? "", startTime, maxResults: max }));
		const items = results.map((item) => ({
			url: item.url,
			title: item.title,
			lastVisitTime: item.lastVisitTime,
			visitCount: item.visitCount,
		}));

		const details: WorkspaceDetails = {
			operation: "search_history",
			count: items.length,
			summary: `Found ${items.length} history item(s) for "${args.query}" (last ${daysBack} days)`,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(items) }],
			details,
		};
	}

	private async recentlyClosed(): Promise<AgentToolResult<WorkspaceDetails>> {
		const sessions = await call(() => chrome.sessions.getRecentlyClosed({ maxResults: 20 }));
		const items = sessions.map((session) => {
			if (session.tab) {
				return {
					type: "tab" as const,
					sessionId: session.tab.sessionId,
					title: session.tab.title,
					url: session.tab.url,
				};
			}
			if (session.window) {
				return {
					type: "window" as const,
					sessionId: session.window.sessionId,
					tabCount: session.window.tabs?.length ?? 0,
				};
			}
			return { type: "unknown" as const };
		});

		const details: WorkspaceDetails = {
			operation: "recently_closed",
			count: items.length,
			summary: `Found ${items.length} recently closed item(s)`,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(items) }],
			details,
		};
	}

	private async restoreClosed(sessionId: string | undefined): Promise<AgentToolResult<WorkspaceDetails>> {
		const session = await call(() => (sessionId ? chrome.sessions.restore(sessionId) : chrome.sessions.restore()));
		const restored = session.tab
			? { type: "tab" as const, title: session.tab.title, url: session.tab.url, id: session.tab.id }
			: session.window
				? { type: "window" as const, tabCount: session.window.tabs?.length ?? 0, id: session.window.id }
				: { type: "unknown" as const };

		const details: WorkspaceDetails = {
			operation: "restore_closed",
			count: 1,
			summary: `Restored closed ${"type" in restored ? restored.type : "item"}`,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(restored) }],
			details,
		};
	}

	private async listDownloads(args: WorkspaceParams): Promise<AgentToolResult<WorkspaceDetails>> {
		const max = Math.min(args.max ?? 50, DOWNLOAD_MAX_RESULTS);
		const searchQuery: chrome.downloads.DownloadQuery = {
			limit: max,
			orderBy: ["-startTime"],
		};
		if (args.query !== undefined) searchQuery.query = [args.query];
		if (args.state !== undefined) searchQuery.state = args.state as chrome.downloads.State;

		const items = (await call(() => chrome.downloads.search(searchQuery))).slice(0, max).map((item) => ({
			id: item.id,
			filename: item.filename,
			url: item.url,
			state: item.state,
			bytesReceived: item.bytesReceived,
			totalSize: item.totalBytes,
			paused: item.paused,
		}));

		const details: WorkspaceDetails = {
			operation: "list_downloads",
			count: items.length,
			summary: `Listed ${items.length} download item(s)`,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(items) }],
			details,
		};
	}

	private async downloadAction(
		id: number | undefined,
		action: "pause" | "resume" | "cancel" | "show" | "open" | undefined,
		confirm: boolean,
	): Promise<AgentToolResult<WorkspaceDetails>> {
		if (id === undefined) throw new Error("'id' (download id) is required for download_action operation");
		if (action === undefined) throw new Error("'action' is required for download_action operation");
		if (action === "cancel" && !confirm) {
			throw new Error(
				"download_action 'cancel' aborts the download. This is destructive — re-run with confirm: true to proceed.",
			);
		}

		const [item] = await call(() => chrome.downloads.search({ id }));
		if (!item) throw new Error(`Download "${id}" not found`);

		switch (action) {
			case "pause":
				await call(() => chrome.downloads.pause(id));
				break;
			case "resume":
				await call(() => chrome.downloads.resume(id));
				break;
			case "cancel":
				await call(() => chrome.downloads.cancel(id));
				break;
			case "show":
				chrome.downloads.show(id);
				break;
			case "open":
				chrome.downloads.open(id);
				break;
		}

		const details: WorkspaceDetails = {
			operation: "download_action",
			count: 1,
			summary: `${action} on download "${item.filename?.split("/").pop() || id}"`,
		};
		return {
			content: [
				{
					type: "text",
					text: `Performed '${action}' on download ${id} (${item.filename?.split("/").pop() || "unknown file"})`,
				},
			],
			details,
		};
	}

	private async readingList(args: WorkspaceParams): Promise<AgentToolResult<WorkspaceDetails>> {
		const action = args.readingAction;
		if (!action) throw new Error("'readingAction' is required for reading_list operation");

		if (action === "add") {
			if (args.url === undefined) throw new Error("'url' is required for reading_list add");
			const title = args.title ?? args.url;
			await call(() =>
				chrome.readingList.addEntry({
					url: args.url!,
					title,
					hasBeenRead: false,
				}),
			);
			const details: WorkspaceDetails = {
				operation: "reading_list",
				count: 1,
				summary: `Added "${title}" to reading list`,
			};
			return {
				content: [{ type: "text", text: `Added "${title}" (${args.url}) to the reading list` }],
				details,
			};
		}

		if (action === "list") {
			const items = await call(() => chrome.readingList.query({}));
			const list = items.map((item) => ({
				url: item.url,
				title: item.title,
				hasBeenRead: item.hasBeenRead,
				creationTime: item.creationTime,
			}));
			const details: WorkspaceDetails = {
				operation: "reading_list",
				count: list.length,
				summary: `Listed ${list.length} reading list item(s)`,
			};
			return {
				content: [{ type: "text", text: JSON.stringify(list) }],
				details,
			};
		}

		if (action === "mark_read") {
			if (args.readingUrl === undefined) throw new Error("'readingUrl' is required for reading_list mark_read");
			// Entries are keyed by URL; find the target in a full listing
			const all = await call(() => chrome.readingList.query({}));
			const item = all.find((e) => e.url === args.readingUrl);
			if (!item) throw new Error(`Reading list entry "${args.readingUrl}" not found`);
			await call(() =>
				chrome.readingList.updateEntry({
					url: args.readingUrl!,
					hasBeenRead: args.hasBeenRead ?? true,
				}),
			);
			const details: WorkspaceDetails = {
				operation: "reading_list",
				count: 1,
				summary: `Marked "${item.title}" as ${args.hasBeenRead === false ? "unread" : "read"}`,
			};
			return {
				content: [
					{ type: "text", text: `Marked "${item.title}" as ${args.hasBeenRead === false ? "unread" : "read"}` },
				],
				details,
			};
		}

		// remove
		if (args.readingUrl === undefined) throw new Error("'readingUrl' is required for reading_list remove");
		const items = await call(() => chrome.readingList.query({}));
		const item = items.find((e) => e.url === args.readingUrl);
		if (!item) throw new Error(`Reading list entry "${args.readingUrl}" not found`);
		await call(() => chrome.readingList.removeEntry({ url: args.readingUrl! }));
		const details: WorkspaceDetails = {
			operation: "reading_list",
			count: 1,
			summary: `Removed "${item.title}" from reading list`,
		};
		return {
			content: [{ type: "text", text: `Removed "${item.title}" (${item.url}) from the reading list` }],
			details,
		};
	}
}

// ============================================================================
// RENDERER
// ============================================================================

const workspaceRenderer: ToolRenderer<WorkspaceParams, WorkspaceDetails> = {
	render(
		params: WorkspaceParams | undefined,
		result: ToolResultMessage<WorkspaceDetails> | undefined,
	): ToolRenderResult {
		const operation = params?.operation ?? "workspace";
		const label = operation.replace(/_/g, " ");
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";

		return {
			content: html`${renderHeader(state, LayoutGrid, label)}`,
			isCustom: false,
		};
	},
};

export function registerBrowserWorkspaceRenderer() {
	registerToolRenderer("browser_workspace", workspaceRenderer);
}
