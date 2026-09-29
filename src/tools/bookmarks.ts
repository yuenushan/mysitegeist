import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { registerToolRenderer, renderHeader, type ToolRenderer, type ToolRenderResult } from "@mariozechner/pi-web-ui";
import { type Static, Type } from "@sinclair/typebox";
import { html } from "lit";
import { Bookmark } from "lucide";

const BOOKMARKS_TOOL_DESCRIPTION = `Manage the browser's bookmarks via the Chrome Bookmarks API.

Operations:
- list_tree: List the bookmark tree (slim nodes). Use maxDepth to limit depth (default 3).
- search: Search bookmarks by query string (matches title/url) or by {title, url} object.
- get_recent: Get the most recently added bookmarks (numberOfItems, default 10).
- create: Create a bookmark (with url) or a folder (without url), optionally at parentId/index.
- update: Rename a bookmark/folder (and/or change its url). Use list_tree/search first to get ids.
- move: Move a bookmark/folder to another parent (parentId) and/or position (index).
- remove: Delete a single bookmark or an EMPTY folder. Fails on non-empty folders; use remove_tree for those.
- remove_tree: Recursively delete a bookmark folder and ALL its contents. Requires confirm: true.

Notes:
- Node ids are strings (e.g. "1" = Bookmarks Bar, "2" = Other Bookmarks). Use list_tree/search first to get ids.
- The root and the special top-level folders ("0", "1", "2") cannot be removed or moved.
- All mutations are visible immediately in the browser's bookmark manager.`;

const bookmarksSchema = Type.Object({
	operation: Type.Union(
		[
			Type.Literal("list_tree"),
			Type.Literal("search"),
			Type.Literal("get_recent"),
			Type.Literal("create"),
			Type.Literal("update"),
			Type.Literal("move"),
			Type.Literal("remove"),
			Type.Literal("remove_tree"),
		],
		{ description: "Which bookmark operation to perform" },
	),
	query: Type.Optional(
		Type.Union(
			[
				Type.String({ description: "Free-text query matched against bookmark titles and URLs (for 'search')" }),
				Type.Object(
					{
						title: Type.Optional(Type.String({ description: "Match bookmark title" })),
						url: Type.Optional(Type.String({ description: "Match bookmark URL" })),
					},
					{ description: "Field-specific query (for 'search')" },
				),
			],
			{ description: "Search query (required for 'search')" },
		),
	),
	maxDepth: Type.Optional(Type.Number({ description: "Max tree depth for 'list_tree' (default 3)" })),
	numberOfItems: Type.Optional(Type.Number({ description: "Number of items for 'get_recent' (default 10)" })),
	id: Type.Optional(Type.String({ description: "Bookmark/folder node id (for 'move', 'remove', 'remove_tree')" })),
	parentId: Type.Optional(Type.String({ description: "Target parent folder id (for 'create', 'move')" })),
	title: Type.Optional(
		Type.String({
			description: "Title for 'create'; new title for 'update'",
		}),
	),
	url: Type.Optional(
		Type.String({ description: "URL for 'create'. Omit to create a folder. For 'update': new URL (optional)" }),
	),
	index: Type.Optional(Type.Number({ description: "Position within the parent (0-based, for 'create' and 'move')" })),
	confirm: Type.Optional(Type.Boolean({ description: "Must be explicitly true for 'remove_tree'" })),
});

type BookmarksParams = Static<typeof bookmarksSchema>;

interface BookmarkNodeSlim {
	id: string;
	title: string;
	url?: string;
	parentId?: string;
	index?: number;
	children?: BookmarkNodeSlim[];
}

interface BookmarksDetails {
	operation: string;
	nodeCount: number;
	summary: string;
	truncated?: boolean;
}

// Special folders that must never be removed or moved
const PROTECTED_IDS = new Set(["0", "1", "2"]);

// ============================================================================
// HELPERS
// ============================================================================

/** Normalize a chrome API error into a friendly Error. */
function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	const message = typeof error === "string" ? error : (error as { message?: string })?.message;
	if (message?.includes("can't be found") || message?.includes("not found")) {
		return new Error(`Bookmark node not found: ${message}`);
	}
	return new Error(message || "Unknown bookmarks API error");
}

function slimNode(node: chrome.bookmarks.BookmarkTreeNode, depth: number, maxDepth: number): BookmarkNodeSlim {
	const slim: BookmarkNodeSlim = {
		id: node.id,
		title: node.title,
	};
	if (node.url !== undefined) slim.url = node.url;
	if (node.parentId !== undefined) slim.parentId = node.parentId;
	if (node.index !== undefined) slim.index = node.index;
	if (node.children && depth < maxDepth) {
		slim.children = node.children.map((child) => slimNode(child, depth + 1, maxDepth));
	}
	return slim;
}

function countNodes(nodes: BookmarkNodeSlim[]): number {
	let count = nodes.length;
	for (const node of nodes) {
		if (node.children) count += countNodes(node.children);
	}
	return count;
}

function countLeaves(nodes: chrome.bookmarks.BookmarkTreeNode[]): number {
	let count = 0;
	for (const node of nodes) {
		if (node.url) count++;
		if (node.children) count += countLeaves(node.children);
	}
	return count;
}

/** Call a chrome.bookmarks promise API and normalize rejections. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw toError(error);
	}
}

// ============================================================================
// TOOL
// ============================================================================

export class BookmarksTool implements AgentTool<typeof bookmarksSchema, BookmarksDetails> {
	label = "Bookmarks";
	name = "bookmarks";
	description = BOOKMARKS_TOOL_DESCRIPTION;
	parameters = bookmarksSchema;

	async execute(
		_toolCallId: string,
		args: BookmarksParams,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<BookmarksDetails>> {
		switch (args.operation) {
			case "list_tree":
				return this.listTree(args.maxDepth ?? 3);
			case "search":
				return this.search(args.query);
			case "get_recent":
				return this.getRecent(args.numberOfItems ?? 10);
			case "create":
				return this.create(args);
			case "update":
				return this.update(args);
			case "move":
				return this.move(args);
			case "remove":
				return this.remove(args.id);
			case "remove_tree":
				return this.removeTree(args.id, args.confirm === true);
			default:
				throw new Error(`Unknown operation: ${args.operation}`);
		}
	}

	private async listTree(maxDepth: number): Promise<AgentToolResult<BookmarksDetails>> {
		const [root] = await call(() => chrome.bookmarks.getTree());
		if (!root) throw new Error("Bookmarks tree is empty");

		const children = root.children ?? [];
		const nodes = children.map((child) => slimNode(child, 0, maxDepth - 1));
		const totalLeaves = countLeaves(children);
		const depthLimited = nodes.some((n) => hasDepthLimitedChildren(n, maxDepth - 1));

		const details: BookmarksDetails = {
			operation: "list_tree",
			nodeCount: totalLeaves,
			summary: `Listed bookmark tree up to depth ${maxDepth} (${totalLeaves} bookmarks)`,
			truncated: depthLimited || undefined,
		};

		const note = depthLimited
			? `\n(Note: tree truncated at depth ${maxDepth}. Pass a higher maxDepth to see more.)`
			: "";
		return {
			content: [{ type: "text", text: JSON.stringify({ nodes, totalBookmarks: totalLeaves }) + note }],
			details,
		};
	}

	private async search(
		query: string | { title?: string; url?: string } | undefined,
	): Promise<AgentToolResult<BookmarksDetails>> {
		if (query === undefined) throw new Error("'query' is required for search operation");
		const results = await call(() => chrome.bookmarks.search(query as chrome.bookmarks.SearchQuery));
		const nodes = results.map((node) => slimNode(node, 0, 0));

		const details: BookmarksDetails = {
			operation: "search",
			nodeCount: nodes.length,
			summary: `Found ${nodes.length} bookmark(s)`,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(nodes) }],
			details,
		};
	}

	private async getRecent(numberOfItems: number): Promise<AgentToolResult<BookmarksDetails>> {
		const results = await call(() => chrome.bookmarks.getRecent(numberOfItems));
		const nodes = results.map((node) => slimNode(node, 0, 0));

		const details: BookmarksDetails = {
			operation: "get_recent",
			nodeCount: nodes.length,
			summary: `Fetched ${nodes.length} recent bookmark(s)`,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(nodes) }],
			details,
		};
	}

	private async create(args: BookmarksParams): Promise<AgentToolResult<BookmarksDetails>> {
		if (args.title === undefined) throw new Error("'title' is required for create operation");
		if (args.id !== undefined) throw new Error("'id' is not used by create operation");

		const created = await call(() =>
			chrome.bookmarks.create({
				parentId: args.parentId,
				title: args.title,
				url: args.url,
				index: args.index,
			}),
		);

		const kind = args.url ? "bookmark" : "folder";
		const details: BookmarksDetails = {
			operation: "create",
			nodeCount: 1,
			summary: `Created ${kind} "${created.title}" (id ${created.id})`,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(slimNode(created, 0, 0)) }],
			details,
		};
	}

	private async update(args: BookmarksParams): Promise<AgentToolResult<BookmarksDetails>> {
		const id = args.id;
		if (id === undefined) throw new Error("'id' is required for update operation");
		if (args.title === undefined && args.url === undefined) {
			throw new Error("Provide at least one of 'title' or 'url' for update operation");
		}
		if (PROTECTED_IDS.has(id)) {
			throw new Error(`Cannot update special folder with id "${id}" (root/Bookmarks Bar/Other Bookmarks)`);
		}

		const [node] = await call(() => chrome.bookmarks.get(id));
		if (!node) throw new Error(`Bookmark node "${id}" not found`);

		const changes: { title?: string; url?: string } = {};
		if (args.title !== undefined) changes.title = args.title;
		if (args.url !== undefined) {
			if (node.url === undefined) {
				throw new Error(`"${node.title}" is a folder and cannot have a URL`);
			}
			changes.url = args.url;
		}

		const updated = await call(() => chrome.bookmarks.update(id, changes));

		const details: BookmarksDetails = {
			operation: "update",
			nodeCount: 1,
			summary: `Renamed "${node.title}" to "${updated.title}"`,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(slimNode(updated, 0, 0)) }],
			details,
		};
	}

	private async move(args: BookmarksParams): Promise<AgentToolResult<BookmarksDetails>> {
		const id = args.id;
		if (id === undefined) throw new Error("'id' is required for move operation");
		if (PROTECTED_IDS.has(id)) {
			throw new Error(`Cannot move special folder with id "${id}" (root/Bookmarks Bar/Other Bookmarks)`);
		}

		const [node] = await call(() => chrome.bookmarks.get(id));
		if (!node) throw new Error(`Bookmark node "${id}" not found`);

		const moved = await call(() =>
			chrome.bookmarks.move(id, {
				parentId: args.parentId,
				index: args.index,
			}),
		);

		const details: BookmarksDetails = {
			operation: "move",
			nodeCount: 1,
			summary: `Moved "${node.title}" to parent ${moved.parentId} at index ${moved.index}`,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(slimNode(moved, 0, 0)) }],
			details,
		};
	}

	private async remove(id: string | undefined): Promise<AgentToolResult<BookmarksDetails>> {
		if (id === undefined) throw new Error("'id' is required for remove operation");
		if (PROTECTED_IDS.has(id)) {
			throw new Error(`Cannot remove special folder with id "${id}" (root/Bookmarks Bar/Other Bookmarks)`);
		}

		const [node] = await call(() => chrome.bookmarks.get(id));
		if (!node) throw new Error(`Bookmark node "${id}" not found`);
		if (node.children && node.children.length > 0) {
			throw new Error(
				`"${node.title}" is a folder with ${node.children.length} children and cannot be removed by 'remove'. ` +
					`Use operation 'remove_tree' with confirm: true to delete it recursively.`,
			);
		}

		await call(() => chrome.bookmarks.remove(id));

		const details: BookmarksDetails = {
			operation: "remove",
			nodeCount: 1,
			summary: `Removed "${node.title}" (id ${id})`,
		};
		return {
			content: [{ type: "text", text: `Removed "${node.title}" (id ${id})` }],
			details,
		};
	}

	private async removeTree(id: string | undefined, confirm: boolean): Promise<AgentToolResult<BookmarksDetails>> {
		if (id === undefined) throw new Error("'id' is required for remove_tree operation");
		if (!confirm) {
			throw new Error(
				"'remove_tree' recursively deletes a folder and ALL its contents. " +
					"This is destructive — re-run with confirm: true to proceed.",
			);
		}
		if (PROTECTED_IDS.has(id)) {
			throw new Error(`Cannot remove special folder with id "${id}" (root/Bookmarks Bar/Other Bookmarks)`);
		}

		const [node] = await call(() => chrome.bookmarks.get(id));
		if (!node) throw new Error(`Bookmark node "${id}" not found`);
		const deletedLeaves = node.children ? countLeaves(node.children) : 0;

		await call(() => chrome.bookmarks.removeTree(id));

		const details: BookmarksDetails = {
			operation: "remove_tree",
			nodeCount: deletedLeaves,
			summary: `Removed folder "${node.title}" and ${deletedLeaves} bookmark(s) inside`,
		};
		return {
			content: [
				{
					type: "text",
					text: `Removed folder "${node.title}" (id ${id}) and ${deletedLeaves} bookmark(s) inside it`,
				},
			],
			details,
		};
	}
}

function hasDepthLimitedChildren(node: BookmarkNodeSlim, remainingDepth: number): boolean {
	if (remainingDepth <= 0) return false;
	if (node.children === undefined) return false;
	// If the slim node has no children array it means the source node had children but they were cut off
	return node.children.some((child) => hasDepthLimitedChildren(child, remainingDepth - 1));
}

// ============================================================================
// RENDERER
// ============================================================================

const bookmarksRenderer: ToolRenderer<BookmarksParams, BookmarksDetails> = {
	render(
		params: BookmarksParams | undefined,
		result: ToolResultMessage<BookmarksDetails> | undefined,
	): ToolRenderResult {
		const operation = params?.operation ?? "bookmarks";
		const label = operation.replace(/_/g, " ");
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";

		return {
			content: html`
				${renderHeader(state, Bookmark, label)}
			`,
			isCustom: false,
		};
	},
};

export function registerBookmarksRenderer() {
	registerToolRenderer("bookmarks", bookmarksRenderer);
}
