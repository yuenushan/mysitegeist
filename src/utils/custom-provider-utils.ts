import type { Model } from "@mariozechner/pi-ai";

/**
 * Pure helpers for the custom models settings tab. Kept DOM-free so they can
 * be smoke-tested outside the browser.
 */

export type ProviderType = "openai-completions" | "openai-responses" | "anthropic-messages";

/** Structurally compatible with pi-web-ui's CustomProvider (apiKey lives in provider-keys instead). */
export interface ProviderRecord {
	id: string;
	name: string;
	type: ProviderType;
	baseUrl: string;
	models: Model<any>[];
}

export interface ModelRow {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	inputImage: boolean;
}

export interface EditorState {
	id: string | null;
	name: string;
	type: ProviderType;
	baseUrl: string;
	apiKey: string;
	existingKey: boolean;
	models: ModelRow[];
}

export const WANQING_PRESETS: { name: string; type: ProviderType; baseUrl: string }[] = [
	{
		name: "Wanqing (OpenAI endpoints)",
		type: "openai-completions",
		baseUrl: "https://wanqing-api.corp.kuaishou.com/api/gateway/v1/endpoints",
	},
	{
		name: "Wanqing (Anthropic gateway)",
		type: "anthropic-messages",
		baseUrl: "https://wanqing-api.corp.kuaishou.com/api/gateway",
	},
];

export const emptyRow = (): ModelRow => ({
	id: "",
	name: "",
	contextWindow: 128000,
	maxTokens: 8192,
	reasoning: false,
	inputImage: false,
});

export function recordFromEditor(editor: EditorState, generateId: () => string): ProviderRecord {
	const id = editor.id || generateId();
	const models: Model<any>[] = editor.models
		.filter((row) => row.id.trim().length > 0)
		.map((row) => ({
			id: row.id.trim(),
			name: row.name.trim() || row.id.trim(),
			api: editor.type,
			provider: id,
			baseUrl: editor.baseUrl.trim(),
			reasoning: row.reasoning,
			input: row.inputImage ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: row.contextWindow > 0 ? row.contextWindow : 128000,
			maxTokens: row.maxTokens > 0 ? row.maxTokens : 8192,
		}));
	return {
		id,
		name: editor.name.trim(),
		type: editor.type,
		baseUrl: editor.baseUrl.trim(),
		models,
	};
}

/** Build a minimal request for the provider type; returns {url, headers, body}. */
export function buildTestRequest(
	type: ProviderType,
	baseUrl: string,
	apiKey: string,
	modelId: string,
): { url: string; headers: Record<string, string>; body: string } {
	const base = baseUrl.replace(/\/+$/, "");
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	if (type === "anthropic-messages") {
		headers["anthropic-version"] = "2023-06-01";
		return {
			url: `${base}/v1/messages`,
			headers,
			body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
		};
	}
	return {
		url: `${base}/chat/completions`,
		headers,
		body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
	};
}

export async function testConnection(
	type: ProviderType,
	baseUrl: string,
	apiKey: string,
	modelId: string,
): Promise<string> {
	if (!modelId) {
		return "Add a model id first - the test needs a real model name";
	}
	const { url, headers, body } = buildTestRequest(type, baseUrl, apiKey, modelId);
	try {
		const response = await fetch(url, { method: "POST", headers, body });
		const text = await response.text();
		let detail = "";
		try {
			const parsed = JSON.parse(text);
			if (parsed.error?.message) detail = ` - ${parsed.error.message}`;
		} catch {
			if (text) detail = ` - ${text.slice(0, 120)}`;
		}
		if (response.ok) return `OK${detail}`;
		return `HTTP ${response.status}${detail}`;
	} catch (error) {
		return `Network error: ${String(error).slice(0, 120)}`;
	}
}
