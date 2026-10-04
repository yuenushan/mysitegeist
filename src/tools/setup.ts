import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { getSitegeistStorage } from "../storage/app-storage.js";

const DEFAULT_MODELS: Record<string, string> = {
	anthropic: "claude-sonnet-4-6",
	openai: "gpt-4o",
	google: "gemini-2.5-flash",
	openrouter: "openai/gpt-5.1-codex",
	"google-gemini-cli": "gemini-2.5-pro",
	github: "gpt-4o",
};

interface ProviderCatalogEntry {
	id: string;
	name: string;
	defaultModel: string;
	keyUrl: string;
}

const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
	{
		id: "anthropic",
		name: "Anthropic (Claude)",
		defaultModel: "claude-sonnet-4-6",
		keyUrl: "https://console.anthropic.com/settings/keys",
	},
	{ id: "openai", name: "OpenAI (GPT)", defaultModel: "gpt-4o", keyUrl: "https://platform.openai.com/api-keys" },
	{
		id: "google",
		name: "Google Gemini",
		defaultModel: "gemini-2.5-flash",
		keyUrl: "https://aistudio.google.com/apikey",
	},
	{ id: "openrouter", name: "OpenRouter", defaultModel: "openai/gpt-5.1-codex", keyUrl: "https://openrouter.ai/keys" },
	{ id: "custom", name: "Custom / 自建代理", defaultModel: "", keyUrl: "" },
];

const setupSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("status"),
			Type.Literal("list_providers"),
			Type.Literal("set_provider_key"),
			Type.Literal("test_provider"),
			Type.Literal("set_default_model"),
			Type.Literal("get_permissions"),
		],
		{ description: "Setup operation to perform" },
	),
	provider: Type.Optional(
		Type.String({ description: "Provider ID (anthropic, openai, google, openrouter, custom, ...)" }),
	),
	key: Type.Optional(Type.String({ description: "API key value" })),
	baseUrl: Type.Optional(Type.String({ description: "Custom base URL (for custom/proxy providers)" })),
	model: Type.Optional(Type.String({ description: "Model ID to set as default" })),
});

type SetupParams = Static<typeof setupSchema>;

interface SetupDetails {
	action: string;
	providers?: { id: string; name: string; hasKey: boolean; defaultModel: string; keyUrl: string }[];
	configured?: boolean;
	testResult?: string;
	model?: string;
	permissions?: Record<string, boolean>;
	note?: string;
}

async function testProviderKey(
	provider: string,
	key: string,
	baseUrl?: string,
): Promise<{ ok: boolean; message: string }> {
	try {
		let url = "";
		let init: RequestInit = {};
		if (provider === "anthropic") {
			url = "https://api.anthropic.com/v1/messages";
			init = {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
				body: JSON.stringify({
					model: "claude-sonnet-4-6",
					max_tokens: 1,
					messages: [{ role: "user", content: "hi" }],
				}),
			};
		} else if (provider === "google") {
			url = "https://generativelanguage.googleapis.com/v1beta/models?key=" + key;
		} else if (provider === "openrouter") {
			url = "https://openrouter.ai/api/v1/models";
			init = { headers: { Authorization: "Bearer " + key } };
		} else {
			const base = baseUrl || (provider === "openai" ? "https://api.openai.com" : "");
			if (!base)
				return { ok: true, message: "Custom provider — no built-in test; try sending a message in the chat." };
			url = base.replace(/\/$/, "") + "/v1/models";
			init = { headers: { Authorization: "Bearer " + key } };
		}
		const r = await fetch(url, init);
		if (r.ok) return { ok: true, message: "Key verified (HTTP " + r.status + ")" };
		const body = await r.text().catch(() => "");
		return { ok: false, message: "HTTP " + r.status + ": " + body.slice(0, 150) };
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message.slice(0, 150) : "network error" };
	}
}

export class SetupTool implements AgentTool<typeof setupSchema, SetupDetails> {
	label = "Setup";
	name = "setup";
	description = `Read and write Sitegeist configuration: AI provider keys, default model, permissions status.

Use this to onboard a new user conversationally:
1. Call status to see what's configured.
2. If no API key, ask the user which provider they want and collect their key in chat.
3. Call set_provider_key to save it, then test_provider to verify.
4. Call set_default_model to pick the model.
5. Report done.

The user never needs to open Settings — you write the config for them.`;

	parameters = setupSchema;

	async execute(
		_toolCallId: string,
		args: SetupParams,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: SetupDetails }> {
		const storage = getSitegeistStorage();
		const text = (s: string, d?: SetupDetails) => ({
			content: [{ type: "text" as const, text: s }],
			details: d ?? { action: args.action },
		});

		switch (args.action) {
			case "status": {
				const providers = PROVIDER_CATALOG.map((p) => p.id);
				const configured: string[] = [];
				for (const p of providers) {
					const key = await storage.providerKeys.get(p);
					if (key) configured.push(p);
				}
				const model = await storage.settings.get("lastUsedModel");
				const userScripts = typeof chrome.userScripts !== "undefined";
				const networkSkills = (await storage.settings.get<boolean>("browserjs.network")) === true;
				return text(
					`Setup status:\n- Providers with keys: ${configured.length ? configured.join(", ") : "NONE"}\n- Default model: ${model ? JSON.stringify(model) : "not set"}\n- userScripts API: ${userScripts ? "available" : "NOT available"}\n- Skill network access: ${networkSkills ? "enabled" : "disabled (default)"}`,
					{
						action: "status",
						configured: configured.length > 0,
						providers: PROVIDER_CATALOG.map((p) => ({ ...p, hasKey: configured.includes(p.id) })),
						permissions: { userScripts, networkSkills: !!networkSkills },
					},
				);
			}
			case "list_providers": {
				const providers: { id: string; name: string; hasKey: boolean; defaultModel: string; keyUrl: string }[] = [];
				for (const p of PROVIDER_CATALOG) {
					const hasKey = !!(await storage.providerKeys.get(p.id));
					providers.push({ id: p.id, name: p.name, hasKey, defaultModel: p.defaultModel, keyUrl: p.keyUrl });
				}
				return text(
					`Available providers:\n${providers.map((p) => `- ${p.id} (${p.name})${p.hasKey ? " [key configured]" : ""}`).join("\n")}`,
					{ action: "list_providers", providers },
				);
			}
			case "set_provider_key": {
				if (!args.provider || !args.key)
					return text("Error: set_provider_key requires provider and key.", {
						action: "set_provider_key",
						note: "missing params",
					});
				await storage.providerKeys.set(args.provider, args.key);
				const info = PROVIDER_CATALOG.find((p) => p.id === args.provider);
				return text(
					`✓ API key saved for ${info?.name || args.provider}${args.baseUrl ? ` (base URL: ${args.baseUrl})` : ""}.\nUse test_provider to verify, or set_default_model to pick a model.`,
					{ action: "set_provider_key", note: `saved ${args.provider}` },
				);
			}
			case "test_provider": {
				if (!args.provider) return text("Error: test_provider requires provider.", { action: "test_provider" });
				const key = await storage.providerKeys.get(args.provider);
				if (!key)
					return text(`No key configured for ${args.provider}. Call set_provider_key first.`, {
						action: "test_provider",
						note: "no key",
					});
				const result = await testProviderKey(args.provider, key, args.baseUrl);
				return text(
					result.ok
						? `✓ ${args.provider} key verified. The agent can use this provider.`
						: `✗ ${args.provider} key test failed: ${result.message}`,
					{ action: "test_provider", testResult: result.ok ? "ok" : "fail", note: result.message },
				);
			}
			case "set_default_model": {
				if (!args.provider || !args.model)
					return text("Error: set_default_model requires provider and model.", { action: "set_default_model" });
				const key = await storage.providerKeys.get(args.provider);
				if (!key)
					return text(`No key for ${args.provider} — set_provider_key first.`, {
						action: "set_default_model",
						note: "no key",
					});
				await storage.settings.set("lastUsedModel", { provider: args.provider, id: args.model });
				return text(`✓ Default model set to ${args.model} (${args.provider}).`, {
					action: "set_default_model",
					model: args.model,
					note: "saved",
				});
			}
			case "get_permissions": {
				const userScripts = typeof chrome.userScripts !== "undefined";
				const networkSkills = (await storage.settings.get<boolean>("browserjs.network")) === true;
				return text(
					`Permissions:\n- userScripts API: ${userScripts ? "available" : "NOT available (enable Allow user scripts in chrome://extensions)"}\n- Skill network access: ${networkSkills ? "enabled" : "disabled"}\n- (Chrome permission toggles must be set manually in chrome://extensions)`,
					{ action: "get_permissions", permissions: { userScripts, networkSkills } },
				);
			}
			default:
				return text(`Unknown action: ${args.action}`, { action: args.action, note: "unknown" });
		}
	}
}
