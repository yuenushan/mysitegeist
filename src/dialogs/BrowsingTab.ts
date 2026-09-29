import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import { Label } from "@mariozechner/mini-lit/dist/Label.js";
import { Switch } from "@mariozechner/mini-lit/dist/Switch.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getSitegeistStorage } from "../storage/app-storage.js";

/**
 * Browsing settings: controls how tab navigations interact with the agent.
 * - "Browse follow" (default off): when the agent is idle and the user is
 *   active, a navigation wakes the agent and it reacts to the page.
 * - Activity timeout: navigations from an idle browser session (no prompt
 *   within this window) are only recorded silently, never waking the agent
 *   or extending a running response.
 */
@customElement("browsing-tab")
export class BrowsingTab extends SettingsTab {
	@state() private followEnabled = false;
	@state() private timeoutMinutes = 5;

	override async connectedCallback() {
		super.connectedCallback();
		try {
			const storage = getSitegeistStorage();
			const follow = await storage.settings.get<boolean>("browsing.follow");
			const timeout = await storage.settings.get<number>("browsing.activityTimeoutMinutes");
			if (follow !== null && follow !== undefined) this.followEnabled = follow;
			if (timeout !== null && timeout !== undefined) this.timeoutMinutes = timeout;
		} catch (error) {
			console.error("Failed to load browsing settings:", error);
		}
	}

	private async saveSettings() {
		try {
			const storage = getSitegeistStorage();
			await storage.settings.set("browsing.follow", this.followEnabled);
			await storage.settings.set("browsing.activityTimeoutMinutes", this.timeoutMinutes);
		} catch (error) {
			console.error("Failed to save browsing settings:", error);
		}
	}

	getTabName(): string {
		return i18n("Browsing");
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-4">
				<p class="text-sm text-muted-foreground">
					${i18n(
						"Controls how page navigations interact with the agent. Navigations are always recorded in the session history; whether they may trigger a response is gated below.",
					)}
				</p>

				<div class="flex items-center justify-between">
					<span class="text-sm font-medium text-foreground">${i18n("Browse follow")}</span>
					${Switch({
						checked: this.followEnabled,
						onChange: (checked: boolean) => {
							this.followEnabled = checked;
							this.saveSettings();
						},
					})}
				</div>
				<p class="text-xs text-muted-foreground">
					${i18n(
						"When enabled, navigating to a page while the agent is idle (and you were active recently) wakes the agent to react to the page. Off by default.",
					)}
				</p>

				<div class="space-y-2">
					${Label({ children: i18n("Activity timeout (minutes)") })}
					${Input({
						type: "number",
						value: String(this.timeoutMinutes),
						onInput: (e) => {
							const value = Number((e.target as HTMLInputElement).value);
							if (Number.isFinite(value) && value > 0) {
								this.timeoutMinutes = Math.min(120, Math.max(1, Math.floor(value)));
							}
						},
						onChange: () => this.saveSettings(),
					})}
					<p class="text-xs text-muted-foreground">
						${i18n(
							"Navigations after this many minutes without a prompt are treated as idle browsing: they are recorded silently and never trigger or extend a response.",
						)}
					</p>
				</div>
			</div>
		`;
	}
}
