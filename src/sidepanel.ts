import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import i18n from "@mariozechner/mini-lit/dist/i18n.js";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
} from "@mariozechner/pi-agent-core";
import { getModel, getModels, type Model } from "@mariozechner/pi-ai";
import {
	ChatPanel,
	createExtractDocumentTool,
	createStreamFn,
	type EditorSuggestion,
	ModelSelector,
	ProvidersModelsTab,
	ProxyTab,
	SettingsDialog,
	// PersistentStorageDialog,
	setAppStorage,
	setShowJsonMode,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { GitFork, History, Plus, Settings } from "lucide";
import {
	type CompactionSettings,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	prepareCompaction,
	shouldCompact,
} from "./agent/compaction/compaction.js";
import { createSummaryRequest } from "./agent/compaction/summarizer.js";
import {
	createSessionTree,
	jumpToPoint,
	messagesAlongPath,
	migrateMessagesToTree,
	reconcileTree,
	type SessionTree,
} from "./agent/tree/session-tree.js";
import { Toast } from "./components/Toast.js";
import { AboutTab } from "./dialogs/AboutTab.js";
import { ApiKeyOrOAuthDialog } from "./dialogs/ApiKeyOrOAuthDialog.js";
import { ApiKeysOAuthTab } from "./dialogs/ApiKeysOAuthTab.js";
import { BrowsingTab } from "./dialogs/BrowsingTab.js";
import { CostsTab } from "./dialogs/CostsTab.js";
import { CustomModelsTab } from "./dialogs/CustomModelsTab.js";
import { McpTab } from "./dialogs/McpTab.js";
import { SessionCostDialog } from "./dialogs/SessionCostDialog.js";
import { SitegeistSessionListDialog } from "./dialogs/SessionListDialog.js";
import { SessionTreeDialog } from "./dialogs/SessionTreeDialog.js";
import { SkillsTab } from "./dialogs/SkillsTab.js";
import { UpdateNotificationDialog } from "./dialogs/UpdateNotificationDialog.js";
import { UserScriptsPermissionDialog } from "./dialogs/UserScriptsPermissionDialog.js";
import { WelcomeSetupDialog } from "./dialogs/WelcomeSetupDialog.js";
import { getMcpBridgeClient } from "./mcp/bridge-client.js";
import { createCompactionMessage, registerCompactionRenderer } from "./messages/CompactionMessage.js";
import { browserMessageTransformer } from "./messages/message-transformer.js";
import {
	createNavigationMessage,
	type NavigationMessage,
	registerNavigationRenderer,
} from "./messages/NavigationMessage.js";
import { registerUserMessageRenderer } from "./messages/UserMessageRenderer.js";
import { createWelcomeMessage, registerWelcomeRenderer } from "./messages/WelcomeMessage.js";
import { isOAuthCredentials, resolveApiKey } from "./oauth/index.js";
import { SYSTEM_PROMPT } from "./prompts/prompts.js";
import { SitegeistAppStorage } from "./storage/app-storage.js";
import { AgentSchedulerTool, registerAgentSchedulerRenderer } from "./tools/agent-scheduler.js";
import {
	countToolCalls,
	type DelegationRecord,
	extractLastAssistantText,
	takePendingDelegation,
	writeDelegation,
} from "./tools/agent-task.js";
import { BookmarksTool, registerBookmarksRenderer } from "./tools/bookmarks.js";
import { BrowserExtensionsTool, registerBrowserExtensionsRenderer } from "./tools/browser-extensions.js";
import { BrowserWorkspaceTool, registerBrowserWorkspaceRenderer } from "./tools/browser-workspace.js";
import { DebuggerTool } from "./tools/debugger.js";
import { ExtractImageTool, registerExtractImageRenderer } from "./tools/extract-image.js";
import { AskUserWhichElementTool, skillTool } from "./tools/index.js";
import { NativeInputEventsRuntimeProvider } from "./tools/NativeInputEventsRuntimeProvider.js";
import { isToolNavigating, NavigateTool } from "./tools/navigate.js";
import { HttpRuntimeProvider } from "./tools/repl/http.js";
import { createReplTool } from "./tools/repl/repl.js";
import { BrowserJsRuntimeProvider, NavigateRuntimeProvider } from "./tools/repl/runtime-providers.js";
import { SetupTool } from "./tools/setup.js";
import { openArtifactInTab } from "./utils/artifact-viewer.js";
import { buildSessionExportHtml } from "./utils/export-html.js";
import { normalizeStoredModel } from "./utils/model-utils.js";
import * as port from "./utils/port.js";
import "./utils/i18n-extension.js";
import "./utils/live-reload.js";
import { tutorials } from "./tutorials.js";

// Register custom message renderers
registerNavigationRenderer();
registerCompactionRenderer();
registerExtractImageRenderer();
registerBookmarksRenderer();
registerBrowserExtensionsRenderer();
registerBrowserWorkspaceRenderer();
registerAgentSchedulerRenderer();

// Listen for abort messages from REPL overlay
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	console.log("[Sidepanel] Received message:", message, "from:", sender);
	if (message.type === "abort-repl") {
		console.log("[Sidepanel] Abort-repl message received, agent streaming:", agent?.state.isStreaming);
		if (agent?.state.isStreaming) {
			console.log("[Sidepanel] Aborting agent...");
			agent.abort();
			sendResponse({ success: true });
		} else {
			console.log("[Sidepanel] Agent not streaming, ignoring");
			sendResponse({ success: false, reason: "not-streaming" });
		}
		return true; // Keep channel open for async response
	}
});

// ============================================================================
// STORAGE SETUP
// ============================================================================
const storage = new SitegeistAppStorage();
setAppStorage(storage);

// ============================================================================
// APP STATE
// ============================================================================
let currentSessionId: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
let currentWindowId: number;

// Track which skills we've shown in full (skillName -> lastUpdated timestamp)
// Reset when a new session/agent is created
const shownSkills = new Map<string, string>();

// Track which messages we've already recorded costs for (avoid duplicates)
// Use Set with message object identity (not cleared on session switch - persists in memory)
const recordedCostMessages = new Set<AgentMessage>();

// Cached auth type label for the current provider
let authLabel = "";

// Context compaction (ported from pi 0.87.1)
const compactionSettings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS };
let compacting = false;

// Branch tree for the current session (kept in sync via reconcileTree)
let currentTree: SessionTree = createSessionTree();

const DEFAULT_MODELS: Record<string, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	anthropic: "claude-sonnet-4-6",
	"azure-openai-responses": "gpt-5.2",
	cerebras: "zai-glm-4.6",
	"github-copilot": "gpt-4o",
	google: "gemini-2.5-flash",
	"google-antigravity": "gemini-3.1-pro-high",
	"google-gemini-cli": "gemini-2.5-pro",
	"google-vertex": "gemini-3-pro-preview",
	groq: "openai/gpt-oss-20b",
	huggingface: "moonshotai/Kimi-K2.5",
	"kimi-coding": "kimi-k2-thinking",
	minimax: "MiniMax-M2.1",
	"minimax-cn": "MiniMax-M2.1",
	mistral: "devstral-medium-latest",
	openai: "gpt-4o-mini",
	"openai-codex": "gpt-5.1-codex-mini",
	opencode: "claude-opus-4-6",
	"opencode-go": "kimi-k2.5",
	openrouter: "openai/gpt-5.1-codex",
	"vercel-ai-gateway": "anthropic/claude-opus-4-6",
	xai: "grok-4-fast-non-reasoning",
	zai: "glm-4.6",
};

async function selectDefaultModelForAvailableProvider() {
	const providers = await getProvidersWithKeys();
	if (providers.length === 0 || !agent) return;

	// Try each provider with keys and find a default model
	for (const provider of providers) {
		const modelId = DEFAULT_MODELS[provider];
		if (modelId) {
			const model = getModel(provider as any, modelId);
			if (model) {
				agent.setModel(model);
				await storage.settings.set("lastUsedModel", model);
				await updateAuthLabel();
				renderApp();
				return;
			}
		}
	}

	// If no default found, try the first model for the first provider with a key
	for (const provider of providers) {
		const models = getModels(provider as any);
		if (models.length > 0) {
			agent.setModel(models[0]);
			await storage.settings.set("lastUsedModel", models[0]);
			await updateAuthLabel();
			renderApp();
			return;
		}
	}
}

async function getProvidersWithKeys(): Promise<string[]> {
	const providers = await storage.providerKeys.list();
	const result: string[] = [];
	for (const provider of providers) {
		const key = await storage.providerKeys.get(provider);
		if (key) result.push(provider);
	}
	return result;
}

async function hasAnyApiKey(): Promise<boolean> {
	const providers = await storage.providerKeys.list();
	return providers.length > 0;
}

function openApiKeysDialog(): Promise<void> {
	return new Promise((resolve) => {
		SettingsDialog.open(
			[
				new ProvidersModelsTab(),
				new ApiKeysOAuthTab(),
				new CustomModelsTab(),
				new CostsTab(),
				new SkillsTab(),
				new BrowsingTab(),
				new McpTab(),
				new ProxyTab(),
				new AboutTab(),
			],
			resolve,
		);
	});
}

async function updateAuthLabel() {
	if (!agent) {
		authLabel = "";
		return;
	}
	const provider = agent.state.model.provider;
	const stored = await storage.providerKeys.get(provider);
	if (!stored) {
		authLabel = "";
	} else if (isOAuthCredentials(stored)) {
		authLabel = "subscription";
	} else {
		authLabel = "api key";
	}
}

// Export getter for message transformer
export function getShownSkills(): Map<string, string> {
	return shownSkills;
}

// ============================================================================
// HELPERS
// ============================================================================
const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user");
	if (!firstUserMsg || firstUserMsg.role !== "user") return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c) => c.type === "text");
		text = textBlocks.map((c) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	const hasUserMsg = messages.some((m: AgentMessage) => m.role === "user");
	const hasAssistantMsg = messages.some((m: AgentMessage) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;

	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;

	try {
		// Calculate cumulative usage from all assistant messages
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		for (const msg of state.messages) {
			if (msg.role === "assistant") {
				usage.input += msg.usage.input;
				usage.output += msg.usage.output;
				usage.cacheRead += msg.usage.cacheRead;
				usage.cacheWrite += msg.usage.cacheWrite;
				usage.totalTokens += msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
				if (msg.usage.cost) {
					usage.cost.input += msg.usage.cost.input;
					usage.cost.output += msg.usage.cost.output;
					usage.cost.cacheRead += msg.usage.cost.cacheRead;
					usage.cost.cacheWrite += msg.usage.cost.cacheWrite;
					usage.cost.total += msg.usage.cost.total;
				}
			}
		}

		// Generate preview text (first 2KB of user + assistant text)
		let preview = "";
		for (const msg of state.messages) {
			if (preview.length >= 2048) break;
			if (msg.role === "user") {
				const text =
					typeof msg.content === "string"
						? msg.content
						: msg.content
								.filter((c) => c.type === "text")
								.map((c) => c.text)
								.join("\n") || "";
				preview += `${text}\n`;
			} else if (msg.role === "assistant") {
				const text = msg.content
					.filter((c) => c.type === "text" || c.type === "thinking")
					.map((c) => (c.type === "text" ? c.text : c.thinking))
					.join("\n");
				preview += `${text}\n`;
			}
		}
		preview = preview.substring(0, 2048);

		// Preserve createdAt if session already exists
		const existingMetadata = await storage.sessions.getMetadata(currentSessionId);
		const createdAt = existingMetadata?.createdAt || new Date().toISOString();

		const metadata = {
			id: currentSessionId,
			title: currentTitle,
			createdAt,
			lastModified: new Date().toISOString(),
			messageCount: state.messages.length,
			usage,
			modelId: state.model.id,
			thinkingLevel: state.thinkingLevel,
			preview,
		};

		await storage.sessions.saveSession(currentSessionId, state, metadata, currentTitle, currentTree);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

// ============================================================================
// CONTEXT COMPACTION
// ============================================================================
const formatTokenCount = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

const getContextUsage = () => {
	if (!agent) return null;
	const contextWindow = agent.state.model.contextWindow;
	if (!contextWindow || contextWindow <= 0) return null;
	const { tokens } = estimateContextTokens(agent.state.messages);
	return { used: tokens, contextWindow, percent: Math.round((tokens / contextWindow) * 100) };
};

const shouldAutoCompact = (): boolean => {
	if (!agent || compacting || agent.state.isStreaming) return false;
	const info = getContextUsage();
	if (!info) return false;
	return shouldCompact(info.used, info.contextWindow, compactionSettings);
};

// Live compaction preview: rendered as a transient block at the end of the
// message list (like pi's compaction status, but with the streaming summary
// text visible). Cleared once the real compaction message replaces it.
const COMPACTION_PREVIEW_MAX_CHARS = 2400;
let compactionPreviewText = "";
let compactionPreviewLastUpdate = 0;

const clearCompactionPreview = () => {
	compactionPreviewText = "";
	if (chatPanel?.agentInterface) {
		chatPanel.agentInterface.transientContent = null;
		chatPanel.agentInterface.requestUpdate();
	}
};

const renderCompactionPreview = () => {
	const agentInterface = chatPanel?.agentInterface;
	if (!agentInterface) return;
	const preview = compactionPreviewText.slice(-COMPACTION_PREVIEW_MAX_CHARS);
	agentInterface.transientContent = html`
		<div class="mx-4 my-2 border border-border rounded-lg bg-card/50 px-3 py-2">
			<div class="flex items-center gap-2 text-xs text-muted-foreground">
				<svg
					class="animate-spin h-3 w-3 shrink-0"
					viewBox="0 0 24 24"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path
						class="opacity-75"
						fill="currentColor"
						d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
					></path>
				</svg>
				${i18n("Compacting context...")}
			</div>
			${
				preview
					? html`<div
							class="mt-2 pt-2 border-t border-border text-xs text-muted-foreground whitespace-pre-wrap break-words max-h-48 overflow-y-auto"
						>
							${preview}
						</div>`
					: ""
			}
		</div>
	`;
	agentInterface.requestUpdate();
};

const runCompaction = async (customInstructions?: string, source: "manual" | "auto" = "auto"): Promise<boolean> => {
	if (!agent) return false;
	if (compacting) {
		if (source === "manual") Toast.error("Compaction already in progress");
		return false;
	}
	if (agent.state.isStreaming) {
		if (source === "manual") Toast.error("Wait for the current response to finish");
		return false;
	}
	const preparation = prepareCompaction(agent.state.messages, compactionSettings);
	if (!preparation) {
		if (source === "manual") Toast.error("Nothing to compact yet - the context is too short");
		return false;
	}

	compacting = true;
	compactionPreviewText = "";
	renderCompactionPreview();
	renderApp();
	try {
		const model = agent.state.model;
		const request = createSummaryRequest(
			{
				getApiKey: async () => {
					const stored = await storage.providerKeys.get(model.provider);
					if (!stored) return undefined;
					const proxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
					const proxyUrl = proxyEnabled
						? (await storage.settings.get<string>("proxy.url")) || undefined
						: undefined;
					return resolveApiKey(stored, model.provider, storage.providerKeys, proxyUrl);
				},
				getProxyUrl: async () => {
					const enabled = await storage.settings.get<boolean>("proxy.enabled");
					return enabled ? (await storage.settings.get<string>("proxy.url")) || undefined : undefined;
				},
			},
			{ model, thinkingLevel: agent.state.thinkingLevel },
		);
		const result = await compact(
			preparation,
			{
				model,
				thinkingLevel: agent.state.thinkingLevel,
				customInstructions,
				convertToLlm: browserMessageTransformer,
				onSummaryDelta: (text: string) => {
					compactionPreviewText = text;
					const now = performance.now();
					if (now - compactionPreviewLastUpdate < 100) return;
					compactionPreviewLastUpdate = now;
					renderCompactionPreview();
				},
			},
			request,
		);

		clearCompactionPreview();
		const compactionMessage = createCompactionMessage(result.summary, result.tokensBefore, result.usage);
		agent.replaceMessages([compactionMessage, ...result.retainedTail]);
		currentTree = reconcileTree(currentTree, agent.state.messages);

		if (currentSessionId) {
			await saveSession();
		}
		chatPanel.agentInterface?.requestUpdate();
		Toast.success(`Context compacted (~${formatTokenCount(result.tokensBefore)} tokens summarized)`);
		return true;
	} catch (err) {
		clearCompactionPreview();
		console.error("Compaction failed:", err);
		Toast.error(`Failed to compact context: ${(err as Error).message}`);
		return false;
	} finally {
		compacting = false;
		renderApp();
	}
};

const maybeAutoCompact = async (): Promise<void> => {
	if (!shouldAutoCompact()) return;
	await runCompaction(undefined, "auto");
};

const exportCurrentSession = async (): Promise<void> => {
	if (!agent) return;
	if (agent.state.messages.length === 0) {
		Toast.error("Nothing to export yet - start a conversation first");
		return;
	}
	try {
		const messages = agent.state.messages;
		const usage = messages.reduce(
			(acc, msg) => {
				if (msg.role === "assistant" && msg.usage) {
					acc.totalTokens += (msg.usage.input ?? 0) + (msg.usage.output ?? 0);
					acc.totalCost += msg.usage.cost?.total ?? 0;
				}
				return acc;
			},
			{ totalTokens: 0, totalCost: 0 },
		);
		const llmMessages = await browserMessageTransformer(messages);
		const html = buildSessionExportHtml({
			header: {
				sessionId: currentSessionId ?? "(not saved)",
				title: currentTitle ?? "Untitled session",
				model: agent.state.model ? `${agent.state.model.provider}/${agent.state.model.id}` : "(none)",
				thinkingLevel: agent.state.thinkingLevel,
				messageCount: messages.length,
				totalTokens: usage.totalTokens,
				totalCost: usage.totalCost,
			},
			systemPrompt: agent.state.systemPrompt,
			tools: agent.state.tools?.map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
			messages,
			llmMessages,
		});
		const blob = new Blob([html], { type: "text/html" });
		const url = URL.createObjectURL(blob);
		chrome.tabs.create({ url });
		Toast.success("Session exported to a new tab");
	} catch (err) {
		console.error("Session export failed:", err);
		Toast.error(`Export failed: ${(err as Error).message}`);
	}
};

const jumpToTreeEntry = (entryId: string): boolean => {
	if (!agent) return false;
	if (agent.state.isStreaming) {
		Toast.error("Wait for the current response to finish");
		return false;
	}
	if (compacting) {
		Toast.error("Compaction in progress");
		return false;
	}
	try {
		currentTree = jumpToPoint(currentTree, entryId);
		agent.replaceMessages(messagesAlongPath(currentTree, currentTree.activeLeafId));
		chatPanel.agentInterface?.requestUpdate();
		if (currentSessionId) {
			void saveSession();
		}
		return true;
	} catch (err) {
		console.error("Failed to jump to tree entry:", err);
		Toast.error(`Failed to jump: ${(err as Error).message}`);
		return false;
	}
};

const resendFromEntry = (entryId: string): boolean => {
	if (!agent) return false;
	if (agent.state.isStreaming) {
		Toast.error("Wait for the current response to finish");
		return false;
	}
	if (compacting) {
		Toast.error("Compaction in progress");
		return false;
	}
	const entry = currentTree.entries.find((candidate) => candidate.id === entryId);
	if (!entry || entry.message.role !== "user") return false;

	// Rewind to before the message, then re-prompt the SAME message object so
	// reconcile records the rerun as a new branch without duplicating it
	currentTree = jumpToPoint(currentTree, entryId);
	agent.replaceMessages(messagesAlongPath(currentTree, currentTree.activeLeafId));
	chatPanel.agentInterface?.requestUpdate();
	if (currentSessionId) {
		void saveSession();
	}
	agent.prompt(entry.message).catch((err: unknown) => {
		console.error("Failed to re-send message:", err);
		Toast.error(`Failed to re-send: ${(err as Error).message}`);
	});
	return true;
};

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

const createAgent = async (initialState?: Partial<AgentState>, shouldSave = true, tree?: SessionTree) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	// Adopt the loaded tree, migrate loaded flat messages, or start fresh
	currentTree = tree ?? (initialState?.messages ? migrateMessagesToTree(initialState.messages) : createSessionTree());

	// Mark all loaded messages as already recorded (by object identity)
	for (const msg of initialState?.messages || []) {
		if (msg.role === "assistant" && msg.usage?.cost?.total > 0) {
			recordedCostMessages.add(msg);
		}
	}

	// Reset skill tracking for new session
	// When loading an old session, we intentionally don't reconstruct shownSkills
	// This ensures that new navigations in the continued session show the LATEST
	// version of skills, even if they were updated since the session was created
	shownSkills.clear();

	// Load debugger mode setting
	const stored = await chrome.storage.local.get("debuggerMode");
	const debuggerModeEnabled = stored.debuggerMode || false;

	// Load CORS proxy settings for extract_document tool
	const corsProxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
	const corsProxyUrl = await storage.settings.get<string>("proxy.url");

	// Resolve the model to use: session state > saved default > provider-key default > fallback.
	// Every source passes through normalizeStoredModel: legacy sessions/settings may hold bare
	// { provider, id } records (older set_default_model), which would fail at stream time with
	// "No API provider registered for api: undefined".
	const resolveCustomBaseUrl = (provider: string) =>
		storage.settings.get<string>("customProvider.baseUrl." + provider);
	let model: Model<any> | undefined;
	if (initialState?.model) {
		model = await normalizeStoredModel(initialState.model, resolveCustomBaseUrl);
	}
	if (!model) {
		const savedModel = await storage.settings.get<Model<any>>("lastUsedModel");
		if (savedModel) {
			model = await normalizeStoredModel(savedModel, resolveCustomBaseUrl);
		}
	}
	if (!model) {
		// Try to find a default model for a provider the user already has a key for
		const providersWithKeys = await getProvidersWithKeys();
		for (const provider of providersWithKeys) {
			const modelId = DEFAULT_MODELS[provider];
			if (modelId) {
				const known = getModel(provider as any, modelId);
				if (known) {
					model = known;
					break;
				}
			}
		}
	}
	// Final fallback
	if (!model) {
		model = getModel("anthropic", "claude-sonnet-4-6");
	}

	if (initialState) {
		// Healed model replaces whatever partial record the session carried
		initialState.model = model;
	} else {
		initialState = {
			systemPrompt: SYSTEM_PROMPT,
			model,
			thinkingLevel: "medium",
			messages: [],
			tools: [],
		};
	}
	// Persist the repaired model so the stored default stops being the legacy bare pair
	if (shouldSave && model) {
		storage.settings.set("lastUsedModel", model).catch((err) => console.error("Failed to save lastUsedModel:", err));
	}

	agent = new Agent({
		initialState,
		convertToLlm: browserMessageTransformer,
		toolExecution: "sequential",
		streamFn: createStreamFn(async () => {
			const enabled = await storage.settings.get<boolean>("proxy.enabled");
			if (!enabled) return undefined;
			return (await storage.settings.get<string>("proxy.url")) || undefined;
		}),
		getApiKey: async (provider: string) => {
			const stored = await storage.providerKeys.get(provider);
			if (!stored) return undefined;
			const proxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
			const proxyUrl = proxyEnabled ? (await storage.settings.get<string>("proxy.url")) || undefined : undefined;
			return resolveApiKey(stored, provider, storage.providerKeys, proxyUrl);
		},
	});

	await updateAuthLabel();
	await loadBrowsingSettings();

	if (shouldSave) {
		agentUnsubscribe = agent.subscribe((event: AgentEvent) => {
			const messages = agent.state.messages;

			storage.settings
				.set("lastUsedModel", agent.state.model)
				.catch((err) => console.error("Failed to save lastUsedModel:", err));

			// Update auth label when model changes
			updateAuthLabel().catch(() => {});

			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.usage?.cost?.total > 0
			) {
				if (!recordedCostMessages.has(event.message)) {
					recordedCostMessages.add(event.message);
					storage.costs
						.recordCost(agent.state.model.provider, agent.state.model.id, event.message.usage.cost.total)
						.catch((err) => console.error("Failed to record cost:", err));
				}
			}

			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
			}

			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = crypto.randomUUID();

				port
					.sendMessage({
						type: "acquireLock",
						sessionId: currentSessionId,
						windowId: currentWindowId,
					})
					.then((lockResponse) => {
						if (!lockResponse.success) {
							console.warn("Failed to acquire lock for newly created session", currentSessionId);
						}
					});
				updateUrl(currentSessionId);
			}

			// Sync the branch tree at stable points only: during streaming the
			// assistant message object is replaced on every delta event
			if (!agent.state.isStreaming) {
				currentTree = reconcileTree(currentTree, messages);
			}

			if (event.type === "agent_end") {
				void maybeAutoCompact();
			}

			if (currentSessionId) {
				saveSession();
			}

			renderApp();
		});
	}

	await chatPanel.setAgent(agent, {
		sandboxUrlProvider: () => {
			return chrome.runtime.getURL("sandbox.html");
		},
		artifactsOpenExternal: (filename, external) => {
			openArtifactInTab(filename, external);
		},
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyOrOAuthDialog.prompt(provider);
		},
		onModelSelect: async () => {
			const providers = await getProvidersWithKeys();
			if (providers.length === 0) {
				openApiKeysDialog();
				return;
			}
			ModelSelector.open(
				agent.state.model,
				(model) => {
					agent.setModel(model);
					chatPanel.agentInterface?.requestUpdate();
					updateAuthLabel().catch(() => {});
					renderApp();
				},
				providers,
			);
		},
		suggestionProvider: async (_query: string): Promise<EditorSuggestion[]> => {
			const items: EditorSuggestion[] = [
				{
					label: "/compact",
					description: "Summarize older context to free up tokens; optionally add focus instructions",
					insertText: "/compact ",
				},
				{
					label: "/export",
					description: "Export the current session to a standalone HTML page (prompts, transcript, LLM view)",
					insertText: "/export",
				},
			];
			try {
				const skills = await storage.skills.list();
				for (const skill of skills) {
					items.push({
						label: skill.name,
						description: skill.shortDescription || "Skill",
						insertText: `Use the "${skill.name}" skill`,
					});
				}
			} catch (err) {
				console.error("Failed to list skills for suggestions:", err);
			}
			return items;
		},
		onBeforeSend: async (input: string) => {
			if (!agent) return false;

			// Any explicit user prompt counts as activity for navigation gating
			lastUserInteraction = Date.now();
			idleNavCount = 0;

			const trimmed = input.trim();
			if (trimmed === "/export") {
				await exportCurrentSession();
				return true; // handled: cancel send, clear editor
			}
			if (trimmed.startsWith("/compact")) {
				const instructions = trimmed.slice("/compact".length).trim();
				await runCompaction(instructions || undefined, "manual");
				return true; // handled: cancel send, clear editor
			}

			// Compact proactively before sending if the context is nearly full
			await maybeAutoCompact();
			if (!agent) return false;

			// Get current tab info
			const [tab] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});
			if (!tab?.url || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("moz-extension://"))
				return false;

			// Find most recent navigation (either nav message or nav tool result)
			let lastUrl: string | undefined;
			for (let i = agent.state.messages.length - 1; i >= 0; i--) {
				const msg = agent.state.messages[i];
				if (msg.role === "navigation") {
					lastUrl = (msg as NavigationMessage).url;
					break;
				}
				if (msg.role === "toolResult" && (msg as any).toolName === "navigate") {
					lastUrl = (msg as any).details?.finalUrl;
					break;
				}
			}

			// Only add if URL changed
			if (!lastUrl || lastUrl !== tab.url) {
				const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
				agent.appendMessage(navMessage);
			}
		},
		onCostClick: () => {
			if (!agent) return;
			SessionCostDialog.open(agent.state.messages);
		},
		toolsFactory: (_agent, _agentInterface, _artifactsPanel, runtimeProvidersFactory) => {
			const navigateTool = new NavigateTool();
			const selectElementTool = new AskUserWhichElementTool();

			// Create extract_document tool with CORS proxy from settings (loaded above)
			const extractDocumentTool = createExtractDocumentTool();
			if (corsProxyEnabled && corsProxyUrl) {
				extractDocumentTool.corsProxyUrl = `${corsProxyUrl}/?url=`;
			}

			const replTool = createReplTool();
			replTool.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");

			// Extend base providers with browser orchestration capabilities
			replTool.runtimeProvidersFactory = () => {
				const httpProvider = new HttpRuntimeProvider();
				// Providers that should be available in page context via browserjs()
				const pageProviders = [
					...runtimeProvidersFactory(), // attachments + artifacts from ChatPanel
					new NativeInputEventsRuntimeProvider(), // trusted browser events
					httpProvider, // http() also available inside browserjs() (routed back here)
				];

				return [
					...pageProviders, // Make them available in REPL context too
					new BrowserJsRuntimeProvider(pageProviders), // Pass to page context
					new NavigateRuntimeProvider(navigateTool),
				];
			};

			const extractImageTool = new ExtractImageTool();
			extractImageTool.windowId = currentWindowId;

			const bookmarksTool = new BookmarksTool();
			const browserExtensionsTool = new BrowserExtensionsTool();
			const browserWorkspaceTool = new BrowserWorkspaceTool();
			const schedulerTool = new AgentSchedulerTool();

			const setupTool = new SetupTool();
			const tools: AgentTool<any, any>[] = [
				navigateTool,
				selectElementTool,
				replTool,
				skillTool,
				extractDocumentTool,
				extractImageTool,
				bookmarksTool,
				browserExtensionsTool,
				browserWorkspaceTool,
				schedulerTool,
				setupTool,
			];

			// Conditionally add debugger tool if enabled
			if (debuggerModeEnabled) {
				const debuggerTool = new DebuggerTool();
				tools.push(debuggerTool);
			}

			return tools;
		},
	});

	// Register custom message renderers after agentInterface is available
	if (chatPanel.agentInterface) {
		registerWelcomeRenderer(agent, chatPanel.agentInterface);

		// Only disable auto-scroll for new sessions with welcome message
		// Check if this is a fresh session (only has welcome message, no user messages)
		const hasUserMessage = agent.state.messages.some((m) => m.role === "user");
		if (!hasUserMessage) {
			chatPanel.agentInterface.setAutoScroll(false);

			// Re-enable auto-scroll on first user message
			let unsubscribe: (() => void) | undefined;
			unsubscribe = agent.subscribe(() => {
				const hasUserMsg = agent.state.messages.some((m) => m.role === "user");
				if (hasUserMsg && unsubscribe) {
					chatPanel.agentInterface?.setAutoScroll(true);
					unsubscribe();
				}
			});
		}
	}
};

const loadSession = (sessionId: string) => {
	// Navigation will disconnect port and auto-release locks
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.location.href = url.toString();
};

const newSession = () => {
	// Navigation will disconnect port and auto-release locks
	const url = new URL(window.location.href);
	url.search = "?new=true";
	window.location.href = url.toString();
};

/**
 * Execute a delegated agent_task in the current fresh session, persist the
 * result for MCP status polling, then navigate back to the previous session.
 */
async function runDelegatedAgentTask(
	hostAgent: NonNullable<typeof agent>,
	delegation: DelegationRecord,
): Promise<void> {
	try {
		const startIndex = hostAgent.state.messages.length;
		await hostAgent.prompt(delegation.prompt);
		delegation.response = extractLastAssistantText(hostAgent.state.messages) || "(no text reply)";
		delegation.steps = countToolCalls(hostAgent.state.messages, startIndex);
		delegation.sessionId = currentSessionId;
		delegation.status = "done";
		delegation.finishedAt = Date.now();
		if (delegation.cancelRequested) {
			delegation.note = "cancellation was requested while running; agent completed the current run";
		}
		await writeDelegation(delegation);
	} catch (err) {
		delegation.status = "error";
		delegation.note = err instanceof Error ? err.message : String(err);
		delegation.finishedAt = Date.now();
		delegation.sessionId = currentSessionId;
		await writeDelegation(delegation);
		renderApp();
		return; // stay in the task session so the user can see the error
	}
	// Switch back to the previous session (page navigation, same as loadSession)
	if (delegation.prevSessionId) {
		loadSession(delegation.prevSessionId);
	} else {
		renderApp();
	}
}

// ============================================================================
// RENDER
// ============================================================================
const renderApp = () => {
	const appHtml = html`
		<div class="w-full h-full flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-3 py-2">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => {
							SitegeistSessionListDialog.open(
								(sessionId: string) => {
									loadSession(sessionId);
								},
								(deletedSessionId: string) => {
									// Only reload if the current session was deleted
									if (deletedSessionId === currentSessionId) {
										newSession();
									}
								},
							);
						},
						title: "Sessions",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(GitFork, "sm"),
						onClick: () => {
							SessionTreeDialog.open(currentTree, currentTree.activeLeafId, jumpToTreeEntry, resendFromEntry);
						},
						title: "Session branches",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Plus, "sm"),
						onClick: newSession,
						title: "New Session",
					})}

					${
						currentTitle
							? isEditingTitle
								? html`<div class="flex items-center gap-2">
									${Input({
										type: "text",
										value: currentTitle,
										className: "text-sm w-48",
										/*
										TODO need to add this in Input in mini-lit
										onBlur: async (e: Event) => {
											const newTitle = (e.target as HTMLInputElement).value.trim();
											if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
												await storage.sessions.updateTitle(currentSessionId, newTitle);
												currentTitle = newTitle;
											}
											isEditingTitle = false;
											renderApp();
										},*/
										onKeyDown: async (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
													await storage.sessions.updateTitle(currentSessionId, newTitle);
													currentTitle = newTitle;
												}
												isEditingTitle = false;
												renderApp();
											} else if (e.key === "Escape") {
												isEditingTitle = false;
												renderApp();
											}
										},
									})}
								</div>`
								: html`<button
									class="px-2 py-1 text-xs text-foreground hover:bg-secondary rounded transition-colors truncate max-w-[150px]"
									@click=${() => {
										isEditingTitle = true;
										renderApp();
										requestAnimationFrame(() => {
											const input = document.body.querySelector('input[type="text"]') as HTMLInputElement;
											if (input) {
												input.focus();
												input.select();
											}
										});
									}}
									title="Click to edit title"
								>
									${currentTitle}
								</button>`
							: html``
					}
				</div>
				<div class="flex items-center gap-1 px-2">
					${(() => {
						const info = getContextUsage();
						if (!info) return html``;
						const cls =
							info.percent >= 80
								? "text-destructive border-destructive/40"
								: info.percent >= 60
									? "text-amber-500 border-amber-500/40"
									: "text-muted-foreground border-border";
						return html`<button
							class="px-2 py-0.5 text-[10px] rounded-full border ${cls} cursor-pointer hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
							?disabled=${compacting}
							@click=${() => void runCompaction(undefined, "manual")}
							title="Context: ${info.used.toLocaleString()} / ${info.contextWindow.toLocaleString()} tokens (${info.percent}%). Click to compact now."
						>
							${compacting ? "compacting…" : `ctx ${info.percent}%`}
						</button>`;
					})()}
					${agent ? html`<span class="text-[10px] text-muted-foreground truncate max-w-[120px]" title="${agent.state.model.provider}/${agent.state.model.id}${authLabel ? ` (${authLabel})` : ""}">${agent.state.model.provider}${authLabel ? html` <span class="text-[9px] opacity-70">${authLabel}</span>` : ""}</span>` : ""}
					<theme-toggle></theme-toggle>
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () =>
							SettingsDialog.open([
								new ProvidersModelsTab(),
								new ApiKeysOAuthTab(),
								new CustomModelsTab(),
								new CostsTab(),
								new SkillsTab(),
								new BrowsingTab(),
								new McpTab(),
								new ProxyTab(),
								new AboutTab(),
							]),
						title: "Settings",
					})}
				</div>
			</div>

			<!-- Chat Panel -->
			${chatPanel}
		</div>
	`;

	render(appHtml, document.body);
};

// ============================================================================
// TAB NAVIGATION TRACKING
// ============================================================================

// Activity gating (bugfix: navigation events must not wake idle sessions).
// - While the agent is streaming, navigations are only steered into the run
//   if the user interacted recently; otherwise they are dropped so a walked-
//   away-from run cannot be extended into an endless nav-chasing loop.
// - While idle, navigations are recorded silently (visible in the transcript
//   and available to the next prompt) but never trigger an LLM run - unless
//   "browse follow" is enabled and the user is still active.
const DEFAULT_ACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_NAV_MAX_PER_SESSION = 50;
let lastUserInteraction = Date.now();
let idleNavCount = 0;
let browsingFollowEnabled = false;
let browsingActivityTimeoutMs = DEFAULT_ACTIVITY_TIMEOUT_MS;

async function loadBrowsingSettings(): Promise<void> {
	try {
		const follow = await storage.settings.get<boolean>("browsing.follow");
		if (follow !== null && follow !== undefined) browsingFollowEnabled = follow;
		const timeout = await storage.settings.get<number>("browsing.activityTimeoutMinutes");
		if (timeout !== null && timeout !== undefined && timeout > 0) {
			browsingActivityTimeoutMs = timeout * 60 * 1000;
		}
	} catch (error) {
		console.error("Failed to load browsing settings:", error);
	}
}

const isUserActive = (): boolean => Date.now() - lastUserInteraction < browsingActivityTimeoutMs;

async function handleNavigationEvent(tab: chrome.tabs.Tab): Promise<void> {
	if (!agent || !tab.url) return;
	const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);

	if (agent.state.isStreaming) {
		// Active agentic run: follow along only while the user is present
		if (isUserActive()) {
			agent.steer(navMessage);
			console.log("Steered navigation message for", tab.url);
		} else {
			console.log("Dropped navigation while streaming (user inactive):", tab.url);
		}
		return;
	}

	// Idle: record silently so the next prompt knows what the user looked at
	if (idleNavCount >= IDLE_NAV_MAX_PER_SESSION) {
		console.log("Idle navigation recording limit reached, dropping:", tab.url);
		return;
	}
	idleNavCount++;

	if (browsingFollowEnabled && isUserActive()) {
		// Browse follow: wake the agent on the navigation (prompt appends the message itself)
		agent.prompt(navMessage).catch((err: unknown) => {
			console.error("Browse-follow prompt failed:", err);
		});
		return;
	}
	agent.appendMessage(navMessage);
	chatPanel.agentInterface?.requestUpdate();
	if (currentSessionId) {
		saveSession().catch((err: unknown) => console.error("Failed to save session after idle nav:", err));
	}
}

// Listen for tab updates and handle navigation events per the gating rules above
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
	if (!changeInfo.url || !tab.active || !tab.url || tab.windowId !== currentWindowId) return;
	// Ignore extension internal pages
	if (tab.url.startsWith("chrome-extension://") || tab.url.startsWith("moz-extension://")) return;
	// Ignore tool-initiated navigations (handled by the navigate tool itself)
	if (isToolNavigating()) return;
	await handleNavigationEvent(tab);
});

// Listen for tab activation (user switches tabs)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
	if (activeInfo.windowId !== currentWindowId) return;
	const tab = await chrome.tabs.get(activeInfo.tabId);
	if (!tab.url) return;
	if (tab.url.startsWith("chrome-extension://") || tab.url.startsWith("moz-extension://")) return;
	if (isToolNavigating()) return;
	await handleNavigationEvent(tab);
});

// ============================================================================
// CONTEXT MENU ACTIONS (from background service worker)
// ============================================================================

chrome.runtime.onMessage.addListener((message: unknown) => {
	if ((message as { type?: string })?.type !== "context-action") return;
	void handleContextAction(message as ContextActionMessage);
});

interface ContextActionMessage {
	type: "context-action";
	verb: string;
	selectionText?: string;
	linkUrl?: string;
	pageUrl?: string;
}

async function handleContextAction(message: ContextActionMessage): Promise<void> {
	if (!agent) return;
	if (agent.state.isStreaming) {
		Toast.error("Wait for the current response to finish");
		return;
	}
	if (compacting) {
		Toast.error("Compaction in progress");
		return;
	}

	let prompt: string;
	switch (message.verb) {
		case "summarize-selection":
			prompt = `请总结以下内容:\n\n${message.selectionText ?? ""}`;
			break;
		case "translate-selection":
			prompt = `翻译以下内容(中文译为英文,其他语言译为中文),直接给出翻译结果:\n\n${message.selectionText ?? ""}`;
			break;
		case "explain-selection":
			prompt = `解释以下内容的含义,用简洁的中文:\n\n${message.selectionText ?? ""}`;
			break;
		case "analyze-link":
			prompt = `打开并分析这个链接的内容,给出摘要: ${message.linkUrl ?? ""}`;
			break;
		case "summarize-page":
			prompt = `总结当前页面 ${message.pageUrl ?? ""} 的主要内容`;
			break;
		default:
			return;
	}

	lastUserInteraction = Date.now();
	agent.prompt(prompt).catch((err: unknown) => {
		console.error("Context-action prompt failed:", err);
		Toast.error(`Failed to run context action: ${(err as Error).message}`);
	});
}

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================
window.addEventListener(
	"keydown",
	(e) => {
		// Escape key to abort streaming - works globally in sidepanel
		// Use capturing phase to intercept before MessageEditor handles it
		if (e.key === "Escape" && agent?.state.isStreaming) {
			e.preventDefault();
			e.stopPropagation();
			agent.abort();
		}

		// Cmd+U (Mac) or Ctrl+U (Windows/Linux) to open debug page
		if ((e.metaKey || e.ctrlKey) && e.key === "u") {
			e.preventDefault();
			window.location.href = "./debug.html";
		}

		// Cmd+Shift+K (Mac) or Ctrl+Shift+K (Windows/Linux) to show session costs
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
			e.preventDefault();
			if (agent?.state.messages && agent.state.messages.length > 0) {
				SessionCostDialog.open(agent.state.messages);
			}
		}
	},
	true,
); // Use capture phase to intercept Escape before it reaches MessageEditor

// ============================================================================
// TEST STEPS FROM DEBUGGER.TS
// ============================================================================
async function testSteps(): Promise<boolean> {
	const urlParams = new URLSearchParams(window.location.search);
	const testStepsParam = urlParams.get("teststeps");
	const testProvider = urlParams.get("provider");
	const testModel = urlParams.get("model");

	if (!testStepsParam) return false;

	// Handle test prompts - create temporary session without saving
	try {
		const testSteps = JSON.parse(decodeURIComponent(testStepsParam)) as string[];

		// Set model if specified
		let initialState: Partial<AgentState> | undefined;
		if (testProvider && testModel) {
			const model = getModel(testProvider as any, testModel);
			if (model) {
				initialState = {
					systemPrompt: SYSTEM_PROMPT,
					model,
				};
			}
		}

		await createAgent(initialState, false);
		renderApp();

		// Wait for UI to render
		await new Promise((resolve) => requestAnimationFrame(resolve));

		// Submit prompts sequentially
		for (let i = 0; i < testSteps.length; i++) {
			const step = testSteps[i];
			if (!chatPanel?.agentInterface) break;

			// Send the prompt
			await chatPanel.agentInterface.sendMessage(step);

			// Wait for agent to finish (not streaming anymore)
			if (i < testSteps.length - 1) {
				// Wait for response to complete before sending next step
				await new Promise<void>((resolve) => {
					const checkComplete = () => {
						if (!chatPanel.agent?.state.isStreaming) {
							resolve();
						} else {
							setTimeout(checkComplete, 100);
						}
					};
					checkComplete();
				});
			}
		}
		return true;
	} catch (err) {
		console.error("Failed to run test steps:", err);
		return false;
	}
}

// ============================================================================
// UPDATE CHECK
// ============================================================================
function isNewerVersion(latest: string, current: string): boolean {
	const latestParts = latest.split(".").map(Number);
	const currentParts = current.split(".").map(Number);

	for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
		const l = latestParts[i] || 0;
		const c = currentParts[i] || 0;
		if (l > c) return true;
		if (l < c) return false;
	}
	return false;
}

async function checkForUpdates() {
	try {
		const currentVersion = chrome.runtime.getManifest().version;

		// Fetch latest version
		const response = await fetch("https://sitegeist.ai/uploads/version.json", {
			cache: "no-cache",
		});
		const data = await response.json();
		const latestVersion = data.version;

		// Show dialog only if server version is newer than current version
		if (isNewerVersion(latestVersion, currentVersion)) {
			// Show update dialog - blocks until extension is updated and restarted
			await UpdateNotificationDialog.show(latestVersion);
		}
	} catch (err) {
		console.warn("[Sidepanel] Failed to check for updates:", err);
		// Silently fail - don't block startup
	}
}

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
	// Show loading
	render(
		html`
			<div class="w-full h-full flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Loading...</div>
			</div>
		`,
		document.body,
	);

	// Load showJsonMode setting
	const stored = await chrome.storage.local.get("showJsonMode");
	const showJsonModeEnabled = (stored.showJsonMode as boolean) || false;
	setShowJsonMode(showJsonModeEnabled);

	// Get current window ID for filtering tab events
	const currentWindow = await chrome.windows.getCurrent();
	if (!currentWindow.id) {
		throw new Error("Failed to get current window ID");
	}
	currentWindowId = currentWindow.id;

	// Initialize port communication system
	port.initialize(currentWindowId);

	// TODO reenable Request persistent storage
	// if (storage.sessions) {
	// 	await PersistentStorageDialog.request();
	// }

	// Request userScripts permission if not available
	if (!chrome.userScripts) {
		await UserScriptsPermissionDialog.request();
	}

	// TODO: re-enable update check when publishing to users
	// await checkForUpdates();

	// Initialize default skills
	const { initializeDefaultSkills } = await import("./tools/skill.js");
	await initializeDefaultSkills();

	// Proxy disabled — CORS is handled locally via declarativeNetRequest rules
	await storage.settings.set("proxy.enabled", false);

	// Create ChatPanel
	chatPanel = new ChatPanel();

	// Handle test steps
	if (await testSteps()) {
		return;
	}

	// Check for session in URL
	const urlParams = new URLSearchParams(window.location.search);
	let sessionIdFromUrl = urlParams.get("session");
	const isNewSession = urlParams.get("new") === "true";

	// If no session in URL and not explicitly creating new, try to load the most recent session
	if (!sessionIdFromUrl && !isNewSession && storage.sessions) {
		const latestSessionId = await storage.sessions.getLatestSessionId();
		if (latestSessionId) {
			// Try to acquire lock for latest session
			const lockResponse = await port.sendMessage({
				type: "acquireLock",
				sessionId: latestSessionId,
				windowId: currentWindowId,
			});

			if (lockResponse.success) {
				sessionIdFromUrl = latestSessionId;
				// Update URL to include the latest session
				updateUrl(latestSessionId);
			}
			// If lock fails, fall through to create new session
		}
	}

	if (sessionIdFromUrl && storage.sessions) {
		const sessionData = await storage.sessions.loadSession(sessionIdFromUrl);
		if (sessionData) {
			// Try to acquire lock if we don't already have it (in case user navigated directly via URL)
			const lockResponse = await port.sendMessage({
				type: "acquireLock",
				sessionId: sessionIdFromUrl,
				windowId: currentWindowId,
			});

			if (!lockResponse.success) {
				// Session is locked in another window - show landing page instead
				await createAgent();
				if (agent) {
					const welcomeMessage = createWelcomeMessage(tutorials);
					agent.appendMessage(welcomeMessage);
				}
				renderApp();
				return;
			}

			currentSessionId = sessionIdFromUrl;
			const metadata = await storage.sessions.getMetadata(sessionIdFromUrl);
			currentTitle = metadata?.title || "";

			await createAgent(
				{
					systemPrompt: SYSTEM_PROMPT,
					model: sessionData.model,
					thinkingLevel: sessionData.thinkingLevel,
					messages: sessionData.messages,
					tools: [],
				},
				true,
				sessionData.sessionTree,
			);

			renderApp();
			return;
		} else {
			// Session doesn't exist, redirect to new session
			newSession();
			return;
		}
	}

	// No session - create new agent
	await createAgent();
	renderApp();

	// Delegated task from MCP agent_task: run it in this fresh session, then
	// navigate back to the previous session. Skips welcome/first-run dialogs.
	const delegation = await takePendingDelegation();
	if (delegation && agent) {
		await runDelegatedAgentTask(agent, delegation);
		return;
	}

	// Add welcome message for new sessions
	if (agent) {
		const welcomeMessage = createWelcomeMessage(tutorials);
		agent.appendMessage(welcomeMessage);
	}

	renderApp();

	// If no API keys configured, show welcome dialog, open settings, then auto-select model
	if (!(await hasAnyApiKey())) {
		await WelcomeSetupDialog.show();
		await openApiKeysDialog();
		await selectDefaultModelForAvailableProvider();
		renderApp();
	}
}

// Register custom user message renderer early, before any session loads
registerUserMessageRenderer();

// Connect to the Sitegeist MCP bridge when it is running; the panel's agent
// tools become available to MCP clients such as pi (see docs/mcp.md)
getMcpBridgeClient().start();

initApp();
