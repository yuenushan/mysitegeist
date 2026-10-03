import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";

/**
 * Delegate a task to the sidepanel agent itself. The sidepanel agent is the
 * full-fidelity sitegeist: navigation-gated context, skill auto-injection
 * (domain-pattern matched libraries), screenshots/vision, artifacts and
 * human-in-the-loop confirmations. pi orchestrates; sitegeist executes
 * browser-native work and returns the agent's reply.
 *
 * The tool runs inside the sidepanel (via the MCP bridge), so it can reach
 * the live Agent instance directly - no cross-context messaging needed.
 */

/** Minimal structural view of the pi Agent we need. */
export interface AgentTaskHost {
	state: { messages: any[]; isStreaming: boolean };
	prompt: (msg: string) => Promise<void>;
	abort: () => void;
	subscribe: (listener: (event: { type: string }) => void) => () => void;
}

export interface TaskRecord {
	taskId: string;
	status: "running" | "done";
	response?: string;
	steps?: number;
	startedAt: number;
	finishedAt?: number;
	note?: string;
}

const hub: {
	host: AgentTaskHost | null;
	tasks: Map<string, TaskRecord>;
	active: { taskId: string; unsubscribe: () => void; startIndex: number } | null;
} = { host: null, tasks: new Map(), active: null };

/** Called by sidepanel.ts whenever a new Agent instance is created. */
export function bindAgentTaskHost(host: AgentTaskHost): void {
	hub.host = host;
}

function extractLastAssistantText(messages: any[]): string {
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

function countToolCalls(messages: any[], startIndex: number): number {
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
			"run: send a task prompt to the sidepanel agent and wait for its reply. status: poll a task. cancel: abort a running task.",
	}),
	prompt: Type.Optional(
		Type.String({
			description:
				"(run) The task for the sidepanel agent, in natural language. It can use its injected skills, repl, screenshots and will ask you for confirmations in the side panel when needed.",
		}),
	),
	taskId: Type.Optional(Type.String({ description: "(status/cancel) Task id returned by a previous run" })),
	timeoutSec: Type.Optional(
		Type.Number({
			description:
				"(run) How long to wait synchronously before returning status=running for polling. Default 90, max 110.",
		}),
	),
});

type TaskParams = Static<typeof taskSchema>;

interface TaskDetails {
	status: "done" | "running" | "busy" | "error";
	taskId?: string;
	response?: string;
	steps?: number;
	durationMs?: number;
	note?: string;
}

export class AgentTaskTool implements AgentTool<typeof taskSchema, TaskDetails> {
	label = "Agent Task";
	name = "agent_task";
	description = `Delegate a task to the sitegeist side panel agent and get its reply.

The side panel agent is the browser-native sitegeist assistant: it auto-loads domain skills (e.g. the tianwen monitoring skill), can take screenshots, and can ask the user for confirmations/element picks in the side panel UI. Use it for browser work that benefits from those capabilities; use the granular tools (navigate, repl, ...) when you want step-by-step control instead.

Rules:
- The side panel must be open. The task appears in the panel conversation, so the user can watch and intervene.
- "run" waits synchronously (default 90s). If the task is still running, you get status=running with a taskId - poll with action=status, or cancel with action=cancel.
- If the panel agent is already streaming (user chatting), you get status=busy - retry shortly.
- Keep the prompt self-contained: the agent starts from the panel's current context.`;

	parameters = taskSchema;

	async execute(
		_toolCallId: string,
		args: TaskParams,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: TaskDetails }> {
		const host = hub.host;

		if (args.action === "status") {
			if (!args.taskId) return this.fail("status requires taskId");
			const rec = hub.tasks.get(args.taskId);
			if (!rec) return this.fail(`Unknown taskId: ${args.taskId}`);
			return this.pack(
				rec.status,
				rec,
				`Task ${args.taskId}: ${rec.status}${rec.response ? "" : " (no response yet)"}`,
			);
		}

		if (args.action === "cancel") {
			if (!args.taskId) return this.fail("cancel requires taskId");
			const rec = hub.tasks.get(args.taskId);
			if (!rec) return this.fail(`Unknown taskId: ${args.taskId}`);
			if (rec.status !== "running") return this.pack(rec.status, rec, `Task already ${rec.status}.`);
			if (hub.active?.taskId === args.taskId && host) host.abort();
			return this.pack("running", rec, `Cancel requested for ${args.taskId}; agent aborting, poll status.`);
		}

		// action === "run"
		if (!host) return this.fail("Sidepanel agent not ready (panel still initializing?).");
		if (!args.prompt || !args.prompt.trim()) return this.fail("run requires prompt");
		if (host.state.isStreaming) {
			return {
				content: [
					{
						type: "text",
						text: "Sidepanel agent is busy (streaming). Retry in a moment or use action=status with a previous taskId.",
					},
				],
				details: { status: "busy", note: "panel agent streaming" },
			};
		}

		const taskId = crypto.randomUUID();
		const startIndex = host.state.messages.length;
		const rec: TaskRecord = { taskId, status: "running", startedAt: Date.now() };
		hub.tasks.set(taskId, rec);

		const waitMs = Math.min(Math.max(args.timeoutSec ?? 90, 10), 110) * 1000;
		let resolveWaiter: (() => void) | null = null;
		const waiter = new Promise<void>((resolve) => {
			resolveWaiter = resolve;
		});

		const finish = (note?: string) => {
			rec.status = "done";
			rec.response = extractLastAssistantText(host.state.messages) || "(no text reply)";
			rec.steps = countToolCalls(host.state.messages, startIndex);
			rec.finishedAt = Date.now();
			rec.note = note;
			if (hub.active?.taskId === taskId) {
				hub.active.unsubscribe();
				hub.active = null;
			}
			resolveWaiter?.();
		};

		const unsubscribe = host.subscribe((event: { type: string }) => {
			if (event.type === "agent_end" && hub.active?.taskId === taskId) finish();
		});
		hub.active = { taskId, unsubscribe, startIndex };

		host.prompt(args.prompt).catch((err: unknown) => {
			finish(`prompt failed: ${err instanceof Error ? err.message : String(err)}`);
		});

		// Wait for completion, tool timeout, or pi-side cancellation.
		const raceResult = await Promise.race([
			waiter.then(() => "done" as const),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), waitMs)),
			new Promise<"aborted">((resolve) => {
				if (signal?.aborted) return resolve("aborted");
				signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
			}),
		]);

		if (raceResult === "done") {
			return this.pack(
				"done",
				rec,
				rec.note ? `${rec.response}\n\n(note: ${rec.note})` : rec.response || "(no reply)",
			);
		}

		// Still running: leave it alive in the panel, return polling info.
		if (raceResult === "aborted") {
			return {
				content: [
					{
						type: "text",
						text: `Task ${taskId} is still running in the side panel (you cancelled the wait; the agent keeps working). Poll with action=status.`,
					},
				],
				details: { status: "running", taskId, note: "wait cancelled, agent still running" },
			};
		}
		return {
			content: [
				{
					type: "text",
					text: `Task ${taskId} is still running in the side panel after ${Math.round(waitMs / 1000)}s. Poll with action=status (taskId ${taskId}), or cancel.`,
				},
			],
			details: { status: "running", taskId, note: "sync wait exceeded, poll status" },
		};
	}

	private fail(message: string): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
		return { content: [{ type: "text", text: `Error: ${message}` }], details: { status: "error", note: message } };
	}

	private pack(
		status: TaskDetails["status"],
		rec: TaskRecord,
		text: string,
	): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
		return {
			content: [{ type: "text", text }],
			details: {
				status,
				taskId: rec.taskId,
				response: rec.response,
				steps: rec.steps,
				durationMs: rec.finishedAt ? rec.finishedAt - rec.startedAt : undefined,
				note: rec.note,
			},
		};
	}
}
