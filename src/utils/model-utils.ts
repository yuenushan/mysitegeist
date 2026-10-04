import { getModel, type Model } from "@mariozechner/pi-ai";

// ============================================================================
// Stored-model repair helpers.
//
// Older versions of the setup tool's set_default_model action saved
// lastUsedModel as a bare { provider, id } pair. A pi-ai Model needs api,
// baseUrl, contextWindow, ... to stream; feeding the bare pair to the agent
// fails with "No API provider registered for api: undefined". These helpers
// detect partial models and rebuild complete ones.
// ============================================================================

const CUSTOM_PROVIDER_ID = "custom";

const DEFAULT_CUSTOM_CONTEXT_WINDOW = 128000;
const DEFAULT_CUSTOM_MAX_TOKENS = 8192;

/** A stored model is streamable only if it carries api + baseUrl. */
export function isCompleteModel(model: Model<any> | undefined | null): boolean {
	return (
		!!model &&
		typeof model.api === "string" &&
		typeof model.baseUrl === "string" &&
		model.baseUrl.length > 0 &&
		typeof model.provider === "string" &&
		typeof model.id === "string"
	);
}

/** Build a full Model record for a custom/proxy provider (OpenAI-compatible endpoint). */
export function buildCustomModel(provider: string, id: string, baseUrl: string): Model<any> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CUSTOM_CONTEXT_WINDOW,
		maxTokens: DEFAULT_CUSTOM_MAX_TOKENS,
	};
}

/**
 * Turn a possibly-partial stored model into a complete one.
 * - Complete models pass through untouched.
 * - Known providers are rebuilt from the built-in model registry.
 * - The "custom" provider is rebuilt via resolveCustomBaseUrl (caller-backed,
 *   usually the settings store where set_provider_key saved the base URL).
 * Returns undefined when the model cannot be repaired.
 */
export async function normalizeStoredModel(
	saved: Model<any> | undefined | null,
	resolveCustomBaseUrl?: (provider: string) => Promise<string | null | undefined>,
): Promise<Model<any> | undefined> {
	if (!saved || typeof saved.provider !== "string" || typeof saved.id !== "string") return undefined;
	if (isCompleteModel(saved)) return saved;

	const known = getModel(saved.provider as any, saved.id);
	if (known) return known;

	if (saved.provider === CUSTOM_PROVIDER_ID && resolveCustomBaseUrl) {
		const baseUrl = await resolveCustomBaseUrl(saved.provider);
		if (baseUrl) return buildCustomModel(saved.provider, saved.id, baseUrl);
	}
	return undefined;
}
