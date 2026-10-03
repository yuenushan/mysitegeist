import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import { Label } from "@mariozechner/mini-lit/dist/Label.js";
import { Switch } from "@mariozechner/mini-lit/dist/Switch.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { DEFAULT_MCP_PORT, getMcpBridgeClient, type McpBridgeStatusInfo } from "../mcp/bridge-client.js";
import { getSitegeistStorage } from "../storage/app-storage.js";

/**
 * MCP Bridge settings: the side panel exposes its agent tools to MCP clients
 * (pi) through scripts/mcp-bridge.mjs over a loopback WebSocket. The bridge
 * is spawned by the MCP client; this tab controls whether the panel connects
 * and on which port.
 */
@customElement("mcp-tab")
export class McpTab extends SettingsTab {
	@state() private enabled = true;
	@state() private port = DEFAULT_MCP_PORT;
	@state() private status: McpBridgeStatusInfo = { status: "disabled" };
	private unsubscribeStatus?: () => void;

	override async connectedCallback() {
		super.connectedCallback();
		try {
			const storage = getSitegeistStorage();
			const enabled = await storage.settings.get<boolean>("mcp.enabled");
			const port = await storage.settings.get<number>("mcp.port");
			if (enabled !== null && enabled !== undefined) this.enabled = enabled;
			if (typeof port === "number" && port > 0) this.port = port;
		} catch (error) {
			console.error("Failed to load MCP settings:", error);
		}
		this.unsubscribeStatus = getMcpBridgeClient().onStatus((info) => {
			this.status = info;
		});
		this.status = getMcpBridgeClient().getStatus();
	}

	override disconnectedCallback() {
		this.unsubscribeStatus?.();
		this.unsubscribeStatus = undefined;
		super.disconnectedCallback();
	}

	private async saveSettings() {
		try {
			const storage = getSitegeistStorage();
			await storage.settings.set("mcp.enabled", this.enabled);
			await storage.settings.set("mcp.port", this.port);
			await getMcpBridgeClient().restart();
		} catch (error) {
			console.error("Failed to save MCP settings:", error);
		}
	}

	getTabName(): string {
		return i18n("MCP Bridge");
	}

	private statusLabel(): string {
		switch (this.status.status) {
			case "connected":
				return i18n("Connected");
			case "connecting":
				return i18n("Connecting...");
			case "reconnecting":
				return i18n("Waiting for bridge...");
			case "disabled":
				return i18n("Disabled");
			case "error":
				return i18n("Error");
		}
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-4">
				<p class="text-sm text-muted-foreground">
					${i18n(
						"Exposes the agent tools to MCP clients such as pi over a local WebSocket relay (scripts/mcp-bridge.mjs). The bridge is started by the MCP client; the side panel connects to it automatically while this is enabled and the panel is open.",
					)}
				</p>

				<div class="flex items-center justify-between">
					<span class="text-sm font-medium text-foreground">${i18n("Enable MCP bridge")}</span>
					${Switch({
						checked: this.enabled,
						onChange: (checked: boolean) => {
							this.enabled = checked;
							this.saveSettings();
						},
					})}
				</div>

				<div class="space-y-2">
					${Label({ children: i18n("Bridge port") })}
					${Input({
						type: "number",
						value: String(this.port),
						onInput: (e) => {
							const value = Number((e.target as HTMLInputElement).value);
							if (Number.isFinite(value) && value > 0) {
								this.port = Math.min(65535, Math.max(1, Math.floor(value)));
							}
						},
						onChange: () => this.saveSettings(),
					})}
					<p class="text-xs text-muted-foreground">
						${i18n(
							"Must match the port the bridge listens on (default 8377, or the --port / SITEGEIST_MCP_PORT value passed to scripts/mcp-bridge.mjs).",
						)}
					</p>
				</div>

				<div class="space-y-1">
					<span class="text-sm font-medium text-foreground">${i18n("Status")}: ${this.statusLabel()}</span>
					${
						this.status.status === "connected" && this.status.port
							? html`<p class="text-xs text-muted-foreground">ws://127.0.0.1:${this.status.port}</p>`
							: ""
					}
					${this.status.error ? html`<p class="text-xs text-destructive">${this.status.error}</p>` : ""}
				</div>

				<p class="text-xs text-muted-foreground">
					${i18n("To register the bridge with pi, run:")}
					<code class="block mt-1 px-2 py-1 rounded bg-muted text-xs">node scripts/mcp-register.mjs</code>
					${i18n("Tools then appear in pi as")} <code>mcp__sitegeist__&lt;tool&gt;</code>.
					${i18n("See docs/mcp.md for details.")}
				</p>
			</div>
		`;
	}
}
