import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";

/**
 * Delegate a task to the sidepanel agent as a subagent. Unlike the granular
 * tools (navigate, repl, ...), this hands the whole task to the panel's own
 * agent - which auto-loads domain skills, can take screenshots and can ask
 * the user for confirmations/element picks right in the side panel UI.
 *
 * Session semantics: the task runs in a FRESH side panel session, never in
 * the user's current conversation. Implementation rides the panel's own
 * session-switch mechanism (which is a page navigation):
 *
 *   run    -> record the delegation in chrome.storage.session (survives the
 *             reload), reply "accepted", then navigate the panel to ?new=true
 *   reload -> initApp's fresh-session branch finds the pending delegation,
 *             runs agent.prompt(task), writes the result back to session
 *             storage, then navigates back to the previous session
 *   status -> any later panel page answers from session storage
 *
 * The run reply is sent before the navigation starts (dispatchCall flushes
 * the WebSocket frame synchronously on return; the navigation is deferred).
 */

export interface DelegationRecord {
	taskId: string;
	prompt: string;
	status: "pending" | "running" | "done" | "error";
	prevSessionId: string | null;
	createdAt: number;
	finishedAt?: number;
	sessionId?: string | null;
	response?: string;
	steps?: number;
	cancelRequested?: boolean;
	note?: string;
}

const DELEGATIONS_KEY = "agentDelegations";
/** A "running" delegation older than this is reported as possibly dead. */
const STALE_RUNNING_MS = 15 * 60 * 1000;
/** Delay before the panel navigates to the fresh session; lets the accepted reply flush. */
const NAVIGATE_DELAY_MS = 150;

export async function readDelegations(): Promise<Record<string, DelegationRecord>> {
	const got = await chrome.storage.local.get(DELEGATIONS_KEY);
	return (got[DELEGATIONS_KEY] as Record<string, DelegationRecord>) || {};
}

export async function writeDelegation(rec: DelegationRecord): Promise<void> {
	const all = await readDelegations();
	all[rec.taskId] = rec;
	await chrome.storage.local.set({ [DELEGATIONS_KEY]: all });
}

/** Claim the oldest pending delegation (called by a freshly-started panel session). */
export async function takePendingDelegation(): Promise<DelegationRecord | null> {
	const all = await readDelegations();
	const pending = Object.values(all).find((d) => d.status === "pending");
	if (!pending) return null;
	pending.status = "running";
	await writeDelegation(pending);
	return pending;
}

export function extractLastAssistantText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "assistant" && Array.isArray(m.content)) {
			const text = m.content
				.filter((c: any) => c?.type === "text")
				.map((c: any) => c.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return "";
}

export function countToolCalls(messages: any[], startIndex: number): number {
	let n = 0;
	for (let i = startIndex; i < messages.length; i++) {
		const m = messages[i];
		if (m?.role === "toolResult") n++;
		if (m?.role === "assistant" && Array.isArray(m.content)) {
			n += m.content.filter((c: any) => c?.type === "toolCall").length;
		}
	}
	return n;
}

const taskSchema = Type.Object({
	action: Type.Union([Type.Literal("run"), Type.Literal("status"), Type.Literal("cancel")], {
		description:
			"run: delegate a task to the sidepanel agent (fresh session). status: poll a task. cancel: request cancellation.",
	}),
	prompt: Type.Optional(
		Type.String({
			description:
				"(run) The task for the sidepanel agent, self-contained natural language. It auto-loads domain skills, can take screenshots and will ask the user in the side panel when a confirmation is needed.",
		}),
	),
	taskId: Type.Optional(Type.String({ description: "(status/cancel) Task id returned by run" })),
});

type TaskParams = Static<typeof taskSchema>;

interface TaskDetails {
	status: "accepted" | "pending" | "running" | "done" | "error";
	taskId?: string;
	sessionId?: string | null;
	response?: string;
	steps?: number;
	note?: string;
}

function startNewSessionNavigation(): void {
	setTimeout(() => {
		const url = new URL(window.location.href);
		url.search = "?new=true";
		window.location.href = url.toString();
	}, NAVIGATE_DELAY_MS);
}

export class AgentTaskTool implements AgentTool<typeof taskSchema, TaskDetails> {
	label = "Agent Task";
	name = "agent_task";
	description = `Delegate a task to the sitegeist side panel agent as a subagent.

The panel agent is the browser-native sitegeist assistant: it auto-loads domain skills on matching sites (e.g. the tianwen monitoring skill), can take screenshots, and can ask the user for confirmations/element picks in the side panel UI. Use it for browser work that benefits from those capabilities; use the granular tools (navigate, repl, ...) when you want step-by-step control instead.

Rules:
- The side panel must be open. The task runs in a FRESH panel session (the user's current conversation is untouched and the panel switches back afterwards); the task conversation stays in the session list.
- "run" accepts immediately (status=accepted) and the panel starts working; poll with action=status until status=done, then read the reply. If the panel is mid-conversation the delegation still works; if the panel agent is literally streaming right now, run fails with busy - retry shortly.
- Keep the prompt self-contained.`;

	parameters = taskSchema;

	async execute(
		_toolCallId: string,
		args: TaskParams,
		_signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: TaskDetails }> {
		if (args.action === "status") {
			if (!args.taskId) return this.fail("status requires taskId");
			const all = await readDelegations();
			const rec = all[args.taskId];
			if (!rec) return this.fail(`Unknown taskId: ${args.taskId}`);
			if (rec.status === "running" && Date.now() - rec.createdAt > STALE_RUNNING_MS) {
				return this.pack(
					"running",
					rec,
					`Task ${args.taskId} has been "running" for over 15 minutes - the panel may have been closed mid-task. Check the side panel session list.`,
				);
			}
			const lines =
				rec.status === "done"
					? rec.response || "(agent finished without a text reply)"
					: `Task ${args.taskId}: ${rec.status}${rec.note ? ` (${rec.note})` : ""}`;
			return this.pack(rec.status, rec, lines);
		}

		if (args.action === "cancel") {
			if (!args.taskId) return this.fail("cancel requires taskId");
			const all = await readDelegations();
			const rec = all[args.taskId];
			if (!rec) return this.fail(`Unknown taskId: ${args.taskId}`);
			if (rec.status === "pending") {
				rec.status = "error";
				rec.note = "cancelled before start";
				rec.finishedAt = Date.now();
				await writeDelegation(rec);
				return this.pack("error", rec, `Task ${args.taskId} cancelled before the panel started it.`);
			}
			rec.cancelRequested = true;
			await writeDelegation(rec);
			return this.pack(
				rec.status,
				rec,
				`Cancellation requested for ${args.taskId}. The panel agent finishes its current step and notes the cancellation; you can also stop it directly in the side panel UI.`,
			);
		}

		// action === "run"
		if (!args.prompt || !args.prompt.trim()) return this.fail("run requires prompt");

		const all = await readDelegations();
		const busyDelegation = Object.values(all).find((d) => d.status === "pending" || d.status === "running");
		if (busyDelegation) {
			return this.fail(
				`Another delegation (${busyDelegation.taskId}, ${busyDelegation.status}) is in flight. Poll its status or cancel it first.`,
			);
		}

		const taskId = crypto.randomUUID();
		const prevSessionId = new URL(window.location.href).searchParams.get("session");
		const rec: DelegationRecord = {
			taskId,
			prompt: args.prompt.trim(),
			status: "pending",
			prevSessionId,
			createdAt: Date.now(),
		};
		await writeDelegation(rec);

		startNewSessionNavigation();

		return {
			content: [
				{
					type: "text",
					text: `Delegation accepted, taskId=${taskId}. The side panel is switching to a fresh session to execute the task; poll action=status (taskId ${taskId}) until done. The panel will switch back to the previous session when finished.`,
				},
			],
			details: { status: "accepted", taskId, sessionId: prevSessionId, note: "panel switching to fresh session" },
		};
	}

	private fail(message: string): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
		return { content: [{ type: "text", text: `Error: ${message}` }], details: { status: "error", note: message } };
	}

	private pack(
		status: TaskDetails["status"],
		rec: DelegationRecord,
		text: string,
	): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
		return {
			content: [{ type: "text", text }],
			details: {
				status,
				taskId: rec.taskId,
				sessionId: rec.sessionId,
				response: rec.response,
				steps: rec.steps,
				note: rec.note,
			},
		};
	}
}
