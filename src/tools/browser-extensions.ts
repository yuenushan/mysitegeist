import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { registerToolRenderer, renderHeader, type ToolRenderer, type ToolRenderResult } from "@mariozechner/pi-web-ui";
import { type Static, Type } from "@sinclair/typebox";
import { html } from "lit";
import { Puzzle } from "lucide";

const EXTENSIONS_TOOL_DESCRIPTION = `Inspect and manage installed Chrome extensions via the chrome.management API.

Operations:
- list_installed: List all installed extensions with name, version, enabled state, permissions and icon.
- get_detail: Full info for one extension by id.
- set_enabled: Enable or disable an extension by id.
- uninstall: Uninstall an extension by id. Requires confirm: true (Chrome additionally shows a native confirmation dialog).

Safety rules:
- This extension itself (its own id) can NEVER be disabled or uninstalled - such requests are rejected.
- Disabled extensions keep their settings; re-enable with set_enabled.`;

const extensionsSchema = Type.Object({
	operation: Type.Union(
		[
			Type.Literal("list_installed"),
			Type.Literal("get_detail"),
			Type.Literal("set_enabled"),
			Type.Literal("uninstall"),
		],
		{ description: "Which extension management operation to perform" },
	),
	id: Type.Optional(Type.String({ description: "Extension id (for 'get_detail', 'set_enabled', 'uninstall')" })),
	enabled: Type.Optional(Type.Boolean({ description: "Target state for 'set_enabled'" })),
	confirm: Type.Optional(Type.Boolean({ description: "Must be explicitly true for 'uninstall'" })),
});

type ExtensionsParams = Static<typeof extensionsSchema>;

interface ExtensionSlim {
	id: string;
	name: string;
	version: string;
	enabled: boolean;
	type: string;
	description?: string;
	permissions?: string[];
	homepageUrl?: string;
	iconUrl?: string;
}

interface ExtensionsDetails {
	operation: string;
	count: number;
	summary: string;
}

function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	const message = typeof error === "string" ? error : (error as { message?: string })?.message;
	return new Error(message || "Unknown chrome.management API error");
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw toError(error);
	}
}

function slimExtension(info: chrome.management.ExtensionInfo): ExtensionSlim {
	const slim: ExtensionSlim = {
		id: info.id,
		name: info.name,
		version: info.version,
		enabled: info.enabled,
		type: info.type,
	};
	if (info.description) slim.description = info.description.slice(0, 200);
	if (info.permissions && info.permissions.length > 0) slim.permissions = info.permissions;
	if (info.homepageUrl) slim.homepageUrl = info.homepageUrl;
	const icon = info.icons?.find((i) => i.size === 48) ?? info.icons?.[info.icons.length - 1];
	if (icon) slim.iconUrl = icon.url;
	return slim;
}

// ============================================================================
// TOOL
// ============================================================================

export class BrowserExtensionsTool implements AgentTool<typeof extensionsSchema, ExtensionsDetails> {
	label = "Extensions";
	name = "browser_extensions";
	description = EXTENSIONS_TOOL_DESCRIPTION;
	parameters = extensionsSchema;

	async execute(
		_toolCallId: string,
		args: ExtensionsParams,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<ExtensionsDetails>> {
		switch (args.operation) {
			case "list_installed":
				return this.listInstalled();
			case "get_detail":
				return this.getDetail(args.id);
			case "set_enabled":
				return this.setEnabled(args.id, args.enabled);
			case "uninstall":
				return this.uninstall(args.id, args.confirm === true);
			default:
				throw new Error(`Unknown operation: ${args.operation}`);
		}
	}

	private async listInstalled(): Promise<AgentToolResult<ExtensionsDetails>> {
		const all = await call(() => chrome.management.getAll());
		const extensions = all.filter((info) => info.type !== "theme" || info.enabled).map(slimExtension);
		// Sort: enabled first, then by name
		extensions.sort((a, b) => (a.enabled === b.enabled ? a.name.localeCompare(b.name) : a.enabled ? -1 : 1));

		const details: ExtensionsDetails = {
			operation: "list_installed",
			count: extensions.length,
			summary: `Listed ${extensions.length} installed extension(s)`,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(extensions) }],
			details,
		};
	}

	private async getDetail(id: string | undefined): Promise<AgentToolResult<ExtensionsDetails>> {
		if (id === undefined) throw new Error("'id' is required for get_detail operation");
		const info = await call(() => chrome.management.get(id));
		const details: ExtensionsDetails = {
			operation: "get_detail",
			count: 1,
			summary: `Fetched details for "${info.name}"`,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(slimExtension(info)) }],
			details,
		};
	}

	private async setEnabled(
		id: string | undefined,
		enabled: boolean | undefined,
	): Promise<AgentToolResult<ExtensionsDetails>> {
		if (id === undefined) throw new Error("'id' is required for set_enabled operation");
		if (enabled === undefined) throw new Error("'enabled' (true/false) is required for set_enabled operation");
		if (id === chrome.runtime.id) {
			throw new Error(
				"Refusing to disable this extension itself (self-protection). Sitegeist cannot disable or uninstall its own runtime.",
			);
		}

		const info = await call(() => chrome.management.get(id));
		if (!info.mayDisable) {
			throw new Error(`"${info.name}" cannot be disabled from here (managed by policy or not user-controllable)`);
		}
		await call(() => chrome.management.setEnabled(id, enabled));

		const details: ExtensionsDetails = {
			operation: "set_enabled",
			count: 1,
			summary: `${enabled ? "Enabled" : "Disabled"} "${info.name}"`,
		};
		return {
			content: [{ type: "text", text: `${enabled ? "Enabled" : "Disabled"} "${info.name}" (id ${id})` }],
			details,
		};
	}

	private async uninstall(id: string | undefined, confirm: boolean): Promise<AgentToolResult<ExtensionsDetails>> {
		if (id === undefined) throw new Error("'id' is required for uninstall operation");
		if (!confirm) {
			throw new Error(
				"'uninstall' removes the extension and its data. This is destructive — re-run with confirm: true to proceed. Chrome will additionally show a native confirmation dialog.",
			);
		}
		if (id === chrome.runtime.id) {
			throw new Error(
				"Refusing to uninstall this extension itself (self-protection). Sitegeist cannot disable or uninstall its own runtime.",
			);
		}

		const info = await call(() => chrome.management.get(id));
		if (!info.mayDisable) {
			throw new Error(`"${info.name}" cannot be uninstalled from here (managed by policy or not user-controllable)`);
		}
		// Chrome shows its native confirm dialog; an empty prompt string keeps it default
		await call(() => chrome.management.uninstall(id, { showConfirmDialog: true }));

		const details: ExtensionsDetails = {
			operation: "uninstall",
			count: 1,
			summary: `Uninstalled "${info.name}"`,
		};
		return {
			content: [{ type: "text", text: `Uninstalled "${info.name}" (id ${id})` }],
			details,
		};
	}
}

// ============================================================================
// RENDERER
// ============================================================================

const extensionsRenderer: ToolRenderer<ExtensionsParams, ExtensionsDetails> = {
	render(
		params: ExtensionsParams | undefined,
		result: ToolResultMessage<ExtensionsDetails> | undefined,
	): ToolRenderResult {
		const operation = params?.operation ?? "extensions";
		const label = operation.replace(/_/g, " ");
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";

		return {
			content: html`${renderHeader(state, Puzzle, label)}`,
			isCustom: false,
		};
	},
};

export function registerBrowserExtensionsRenderer() {
	registerToolRenderer("browser_extensions", extensionsRenderer);
}
