// Service-worker side of the agent scheduler. Kept free of DOM / lit
// dependencies: the background bundle must not pull component code, or the
// service worker fails to register (no window/document in MV3 workers).

const ALARM_NOTIFICATION_PREFIX = "sitegeist-alarm-";

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
