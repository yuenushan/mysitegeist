import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Tree-shaped session model, modeled after pi 0.87.1's session format
 * (id/parentId entries + active leaf) but kept as pure data + pure functions
 * so it can be unit-tested without IndexedDB.
 *
 * Persistence contract: the tree is stored alongside the flat `messages`
 * array in SessionData (`sessionTree` field). `messages` remains the message
 * list along the active branch path, so all existing consumers (session list
 * preview, metadata, cost accumulation) keep working unchanged.
 */

export interface TreeEntry {
	id: string;
	parentId: string | null;
	timestamp: number;
	message: AgentMessage;
}

export interface SessionTree {
	entries: TreeEntry[];
	activeLeafId: string | null;
}

// ============================================================================
// CONSTRUCTION
// ============================================================================

export function createSessionTree(): SessionTree {
	return { entries: [], activeLeafId: null };
}

function entryTimestamp(message: AgentMessage): number {
	const ts = (message as { timestamp?: unknown }).timestamp;
	return typeof ts === "number" ? ts : Date.now();
}

function generateEntryId(entries: TreeEntry[]): string {
	const existing = new Set(entries.map((entry) => entry.id));
	for (let i = 0; i < 100; i++) {
		const id = crypto.randomUUID().slice(0, 8);
		if (!existing.has(id)) return id;
	}
	return crypto.randomUUID();
}

/** Append a message as a new entry under `parentId`. Returns a new tree. */
export function appendEntry(tree: SessionTree, message: AgentMessage, parentId: string | null): SessionTree {
	const entry: TreeEntry = {
		id: generateEntryId(tree.entries),
		parentId,
		timestamp: entryTimestamp(message),
		message,
	};
	return {
		entries: [...tree.entries, entry],
		activeLeafId: entry.id,
	};
}

// ============================================================================
// NAVIGATION
// ============================================================================

/**
 * Entries from the root down to `leafId` (the active branch path).
 * Defensive against cycles and dangling parents: traversal stops instead of
 * looping, unknown parents terminate the path.
 */
export function pathToRoot(tree: SessionTree, leafId: string | null): TreeEntry[] {
	const byId = new Map(tree.entries.map((entry) => [entry.id, entry]));
	const chain: TreeEntry[] = [];
	const visited = new Set<string>();
	let cursor = leafId ? byId.get(leafId) : undefined;
	while (cursor && !visited.has(cursor.id)) {
		visited.add(cursor.id);
		chain.unshift(cursor);
		cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
	}
	return chain;
}

export function messagesAlongPath(tree: SessionTree, leafId: string | null): AgentMessage[] {
	return pathToRoot(tree, leafId).map((entry) => entry.message);
}

/** Direct children of an entry (branch siblings). */
export function getChildren(tree: SessionTree, parentId: string | null): TreeEntry[] {
	return tree.entries.filter((entry) => entry.parentId === parentId);
}

/**
 * Jump the active leaf to any existing entry. The messages list along the new
 * path is the branch up to that point; sending the next message creates a new
 * branch under it (the abandoned branch stays in the tree).
 */
export function jumpToEntry(tree: SessionTree, entryId: string): SessionTree {
	const entry = tree.entries.find((candidate) => candidate.id === entryId);
	if (!entry) {
		throw new Error(`Unknown session tree entry: ${entryId}`);
	}
	return { entries: tree.entries, activeLeafId: entry.id };
}

/**
 * UI jump points: user-facing boundaries — user, navigation, and compaction
 * messages — annotated with their branch position among siblings.
 */
export interface TreeJumpPoint {
	entry: TreeEntry;
	depth: number;
	branchIndex: number;
	branchCount: number;
}

export function listJumpPoints(tree: SessionTree): TreeJumpPoint[] {
	const byId = new Map(tree.entries.map((entry) => [entry.id, entry]));
	const depthById = new Map<string, number>();
	const points: TreeJumpPoint[] = [];
	for (const entry of tree.entries) {
		const role = entry.message.role;
		if (role !== "user" && role !== "navigation" && role !== "compaction") {
			continue;
		}
		let depth: number;
		if (entry.parentId === null) {
			depth = 0;
		} else {
			const parentDepth = depthById.get(entry.parentId);
			if (parentDepth === undefined) {
				continue; // parent is not a jump point; depth unknown until seen
			}
			depth = parentDepth + 1;
		}
		depthById.set(entry.id, depth);
		const siblings = getChildren(tree, entry.parentId);
		points.push({
			entry,
			depth,
			branchIndex: siblings.findIndex((sibling) => sibling.id === entry.id),
			branchCount: siblings.length,
		});
	}
	return points;
}

// ============================================================================
// SYNC WITH THE LINEAR AGENT STATE
// ============================================================================

/**
 * Reconcile the tree with the agent's flat message list (append-only sync).
 *
 * - Messages that reference-match the active path prefix are already known.
 * - Extra messages at the tail are appended as new entries (plain growth, or
 *   a new branch when the state was previously rewound).
 * - A diverged list (e.g. after hard compaction, which prepends a summary and
 *   keeps a tail) starts a fresh root segment; existing entries are preserved.
 *
 * Reference equality is relied upon: tree entries always store the same
 * message objects that live in agent state, and structured clone preserves
 * intra-record references across IndexedDB round-trips.
 */
export function reconcileTree(tree: SessionTree, messages: AgentMessage[]): SessionTree {
	const path = pathToRoot(tree, tree.activeLeafId);
	let common = 0;
	while (common < path.length && common < messages.length && path[common].message === messages[common]) {
		common++;
	}
	if (common === path.length && common === messages.length) {
		return tree; // already in sync
	}

	let working = tree;
	let parentId = common > 0 ? path[common - 1].id : null;
	for (let i = common; i < messages.length; i++) {
		working = appendEntry(working, messages[i], parentId);
		parentId = working.activeLeafId;
	}
	if (messages.length === 0) {
		return { entries: working.entries, activeLeafId: null };
	}
	return working;
}

/** Build a tree from a legacy flat message list (linear chain). */
export function migrateMessagesToTree(messages: AgentMessage[]): SessionTree {
	let tree = createSessionTree();
	let parentId: string | null = null;
	for (const message of messages) {
		tree = appendEntry(tree, message, parentId);
		parentId = tree.activeLeafId;
	}
	return tree;
}
