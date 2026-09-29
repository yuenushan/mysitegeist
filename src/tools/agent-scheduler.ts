import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { registerToolRenderer, renderHeader, type ToolRenderer, type ToolRenderResult } from "@mariozechner/pi-web-ui";
import { type Static, Type } from "@sinclair/typebox";
import { html } from "lit";
import { Clock } from "lucide";

const SCHEDULER_TOOL_DESCRIPTION = `Schedule lightweight reminders and recurring system notifications via Chrome alarms.

Operations:
- set_schedule: Create a named schedule. Either periodInMinutes (recurring) or when (one-shot epoch ms) is required. If both are given the alarm fires at 'when' and then repeats every periodInMinutes.
- list_schedules: List all active schedules (name, scheduled time, period).
- cancel_schedule: Cancel a schedule by name.
- notify: Show a one-off system notification. Clicking it opens the Sitegeist side panel.

Design constraints:
- Schedules fire in the extension service worker and can only perform LIGHTWEIGHT actions (show a notification with the schedule's message). They do NOT run the AI: heavy work waits until the user returns to the side panel conversation.
- Use set_schedule + notify-style payloads for reminders; the notification body is taken from 'message' at schedule time.`;

const schedulerSchema = Type.Object({
	operation: Type.Union(
		[
			Type.Literal("set_schedule"),
			Type.Literal("list_schedules"),
			Type.Literal("cancel_schedule"),
			Type.Literal("notify"),
		],
		{ description: "Which scheduler operation to perform" },
	),
	name: Type.Optional(Type.String({ description: "Schedule name (unique; for 'set_schedule', 'cancel_schedule')" })),
	periodInMinutes: Type.Optional(
		Type.Number({ description: "Repeat interval in minutes for 'set_schedule' (recurring)" }),
	),
	when: Type.Optional(Type.Number({ description: "One-shot fire time as epoch milliseconds for 'set_schedule'" })),
	message: Type.Optional(
		Type.String({ description: "Notification body: for 'notify', or shown when a 'set_schedule' alarm fires" }),
	),
	title: Type.Optional(Type.String({ description: "Notification title for 'notify' (default: Sitegeist)" })),
});

type SchedulerParams = Static<typeof schedulerSchema>;

interface SchedulerDetails {
	operation: string;
	count: number;
	summary: string;
}

const ALARM_NOTIFICATION_PREFIX = "sitegeist-alarm-";

function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	const message = typeof error === "string" ? error : (error as { message?: string })?.message;
	return new Error(message || "Unknown Chrome alarms API error");
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw toError(error);
	}
}

function alarmInfo(alarm: chrome.alarms.Alarm) {
	const out: Record<string, unknown> = {
		name: alarm.name,
		scheduledTime: alarm.scheduledTime,
	};
	if (alarm.periodInMinutes !== undefined) out.periodInMinutes = alarm.periodInMinutes;
	return out;
}

// ============================================================================
// TOOL
// ============================================================================

export class AgentSchedulerTool implements AgentTool<typeof schedulerSchema, SchedulerDetails> {
	label = "Scheduler";
	name = "agent_scheduler";
	description = SCHEDULER_TOOL_DESCRIPTION;
	parameters = schedulerSchema;

	async execute(
		_toolCallId: string,
		args: SchedulerParams,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<SchedulerDetails>> {
		switch (args.operation) {
			case "set_schedule":
				return this.setSchedule(args);
			case "list_schedules":
				return this.listSchedules();
			case "cancel_schedule":
				return this.cancelSchedule(args.name);
			case "notify":
				return this.notify(args);
			default:
				throw new Error(`Unknown operation: ${args.operation}`);
		}
	}

	private async setSchedule(args: SchedulerParams): Promise<AgentToolResult<SchedulerDetails>> {
		const name = args.name;
		if (name === undefined || name.trim().length === 0)
			throw new Error("'name' is required for set_schedule operation");
		if (args.periodInMinutes === undefined && args.when === undefined) {
			throw new Error("Provide 'periodInMinutes' (recurring) or 'when' (epoch ms) for set_schedule operation");
		}
		if (args.periodInMinutes !== undefined && args.periodInMinutes < 0.5) {
			throw new Error("'periodInMinutes' must be >= 0.5 (Chrome clamps sub-minute periods in unpacked extensions)");
		}

		const info: chrome.alarms.AlarmCreateInfo = {};
		if (args.periodInMinutes !== undefined) info.periodInMinutes = args.periodInMinutes;
		if (args.when !== undefined) info.when = args.when;

		await call(() => chrome.alarms.create(name, info));
		const alarm = await call(() => chrome.alarms.get(name));
		if (!alarm) throw new Error(`Failed to create schedule "${name}"`);

		// Persist the notification message so the service worker can show it on fire
		const stored = await chrome.storage.local.get("scheduler_messages");
		const messages = (stored.scheduler_messages as Record<string, string>) || {};
		messages[name] = args.message ?? `Scheduled reminder: ${name}`;
		await chrome.storage.local.set({ scheduler_messages: messages });

		const details: SchedulerDetails = {
			operation: "set_schedule",
			count: 1,
			summary: `Scheduled "${name}"` + (alarm.periodInMinutes ? ` every ${alarm.periodInMinutes} min` : ""),
		};
		return {
			content: [{ type: "text", text: JSON.stringify(alarmInfo(alarm)) }],
			details,
		};
	}

	private async listSchedules(): Promise<AgentToolResult<SchedulerDetails>> {
		const alarms = await call(() => chrome.alarms.getAll());
		const items = alarms.map(alarmInfo);

		const details: SchedulerDetails = {
			operation: "list_schedules",
			count: items.length,
			summary: `Listed ${items.length} schedule(s)`,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(items) }],
			details,
		};
	}

	private async cancelSchedule(name: string | undefined): Promise<AgentToolResult<SchedulerDetails>> {
		if (name === undefined) throw new Error("'name' is required for cancel_schedule operation");
		const alarm = await call(() => chrome.alarms.get(name));
		if (!alarm) throw new Error(`Schedule "${name}" not found`);
		await call(() => chrome.alarms.clear(name));

		const stored = await chrome.storage.local.get("scheduler_messages");
		const messages = (stored.scheduler_messages as Record<string, string>) || {};
		delete messages[name];
		await chrome.storage.local.set({ scheduler_messages: messages });

		const details: SchedulerDetails = {
			operation: "cancel_schedule",
			count: 1,
			summary: `Cancelled schedule "${name}"`,
		};
		return {
			content: [{ type: "text", text: `Cancelled schedule "${name}"` }],
			details,
		};
	}

	private async notify(args: SchedulerParams): Promise<AgentToolResult<SchedulerDetails>> {
		if (args.message === undefined) throw new Error("'message' is required for notify operation");
		const id = `${ALARM_NOTIFICATION_PREFIX}${Date.now()}`;
		await call(() =>
			chrome.notifications.create(id, {
				type: "basic",
				iconUrl: chrome.runtime.getURL("icon-128.png"),
				title: args.title ?? "Sitegeist",
				message: args.message!,
			}),
		);

		const details: SchedulerDetails = {
			operation: "notify",
			count: 1,
			summary: `Sent notification: ${args.message.slice(0, 60)}`,
		};
		return {
			content: [{ type: "text", text: `Notification sent: "${args.message}"` }],
			details,
		};
	}
}

// ============================================================================
// SERVICE WORKER SIDE (wired from background.ts)
// ============================================================================

/** Handle a fired alarm: show its stored message as a system notification. */
export async function handleAlarmFired(alarm: chrome.alarms.Alarm): Promise<void> {
	const stored = await chrome.storage.local.get("scheduler_messages");
	const messages = (stored.scheduler_messages as Record<string, string>) || {};
	const message = messages[alarm.name] ?? `Scheduled reminder: ${alarm.name}`;
	chrome.notifications.create(`${ALARM_NOTIFICATION_PREFIX}${alarm.name}-${Date.now()}`, {
		type: "basic",
		iconUrl: chrome.runtime.getURL("icon-128.png"),
		title: "Sitegeist",
		message,
	});
}

// ============================================================================
// RENDERER
// ============================================================================

const schedulerRenderer: ToolRenderer<SchedulerParams, SchedulerDetails> = {
	render(
		params: SchedulerParams | undefined,
		result: ToolResultMessage<SchedulerDetails> | undefined,
	): ToolRenderResult {
		const operation = params?.operation ?? "scheduler";
		const label = operation.replace(/_/g, " ");
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";

		return {
			content: html`${renderHeader(state, Clock, label)}`,
			isCustom: false,
		};
	},
};

export function registerAgentSchedulerRenderer() {
	registerToolRenderer("agent_scheduler", schedulerRenderer);
}
