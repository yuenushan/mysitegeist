import type { AgentMessage, AgentState } from "@mariozechner/pi-agent-core";
import { type SessionData, type SessionMetadata, SessionsStore } from "@mariozechner/pi-web-ui";
import { migrateMessagesToTree, type SessionTree } from "../../agent/tree/session-tree.js";

// Extend the upstream SessionData shape with the branch tree. The field is
// optional, so all existing readers (session list, metadata) are unaffected.
declare module "@mariozechner/pi-web-ui" {
	interface SessionData {
		/** Full branch tree; `messages` holds the active branch path. */
		sessionTree?: SessionTree;
	}
}

/**
 * Extended SessionsStore that:
 * - migrates old tool result messages from output to content format
 * - persists and loads the branch tree (`sessionTree`), migrating legacy flat
 *   sessions to a linear chain on first load
 */
export class SitegeistSessionsStore extends SessionsStore {
	async saveSession(
		id: string,
		state: AgentState,
		metadata?: SessionMetadata,
		title?: string,
		tree?: SessionTree,
	): Promise<void> {
		const meta: SessionMetadata = metadata || {
			id,
			title: title || "",
			createdAt: new Date().toISOString(),
			lastModified: new Date().toISOString(),
			messageCount: state.messages?.length || 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			thinkingLevel: state.thinkingLevel || "off",
			preview: "",
		};

		const data: SessionData = {
			id,
			title: title || meta.title,
			model: state.model,
			thinkingLevel: state.thinkingLevel,
			messages: state.messages || [],
			createdAt: meta.createdAt,
			lastModified: new Date().toISOString(),
			...(tree ? { sessionTree: tree } : {}),
		};

		await this.save(data, meta);
	}

	async loadSession(id: string): Promise<SessionData | null> {
		const session = await super.loadSession(id);
		if (session) {
			return this.withTree(this.migrateSession(session));
		}
		return session;
	}

	async get(id: string): Promise<SessionData | null> {
		const session = await super.get(id);
		if (session) {
			return this.withTree(this.migrateSession(session));
		}
		return session;
	}

	/** Ensure the loaded session carries a tree, migrating legacy sessions. */
	private withTree(session: SessionData): SessionData {
		if (session.sessionTree) {
			return session;
		}
		return {
			...session,
			sessionTree: migrateMessagesToTree(session.messages),
		};
	}

	private migrateSession(session: SessionData): SessionData {
		return {
			...session,
			messages: this.migrateToolResultMessages(session.messages),
		};
	}

	private migrateToolResultMessages(messages: AgentMessage[]): AgentMessage[] {
		return messages.map((msg) => {
			if (msg.role === "toolResult" && "output" in msg && !msg.content) {
				// Old format detected - migrate it
				const { output, ...rest } = msg as any;
				return {
					...rest,
					content: [{ type: "text", text: output }],
				};
			}
			return msg;
		});
	}
}
