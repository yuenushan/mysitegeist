import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	AssistantMessage,
	Message,
	Model,
	ThinkingLevel,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@mariozechner/pi-ai";

/**
 * Context compaction for long sessions.
 *
 * Ported from pi 0.87.1 (`packages/agent/src/harness/compaction/`), adapted for
 * sitegeist's flat message model (no session tree, no file-operation tracking).
 * Pure functions only: LLM access goes through the injected SummaryRequest.
 */

// ============================================================================
// SETTINGS
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	/** Tokens reserved for the next assistant response when auto-compacting. */
	reserveTokens: number;
	/** Token budget of recent messages kept verbatim across a compaction. */
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

// ============================================================================
// TOKEN ACCOUNTING
// ============================================================================

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

const ESTIMATED_IMAGE_CHARS = 4800;

type TextishContent = string | ReadonlyArray<{ type: string; text?: string }>;

function estimateContentChars(content: TextishContent): number {
	if (typeof content === "string") {
		return content.length;
	}
	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
	switch (message.role) {
		case "user": {
			const content = (message as UserMessage).content;
			return Math.ceil(estimateContentChars(content) / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			let chars = 0;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + safeJsonStringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "toolResult": {
			const content = (message as ToolResultMessage).content;
			return Math.ceil(estimateContentChars(content) / 4);
		}
		default: {
			// Custom message roles (navigation, compaction, welcome, ...)
			return Math.ceil(safeJsonStringify(message).length / 4);
		}
	}
}

export interface ContextTokenEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role !== "assistant") return undefined;
	const assistantMsg = msg as AssistantMessage;
	if (
		assistantMsg.stopReason !== "aborted" &&
		assistantMsg.stopReason !== "error" &&
		assistantMsg.usage &&
		calculateContextTokens(assistantMsg.usage) > 0
	) {
		return assistantMsg.usage;
	}
	return undefined;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextTokenEstimate {
	let lastUsageIndex: number | null = null;
	let usage: Usage | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		usage = getAssistantUsage(messages[i]);
		if (usage) {
			lastUsageIndex = i;
			break;
		}
	}

	if (!usage || lastUsageIndex === null) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
	}

	const usageTokens = calculateContextTokens(usage);
	let trailingTokens = 0;
	for (let i = lastUsageIndex + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}
	return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex };
}

/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// CUT POINT SELECTION
// ============================================================================

export interface CutPoint {
	firstKeptIndex: number;
	turnStartIndex: number;
	isSplitTurn: boolean;
}

/**
 * Messages a cut may land on. toolResult is excluded so a cut never orphans a
 * tool result from its assistant tool call.
 */
function isValidCutMessage(message: AgentMessage): boolean {
	return message.role === "user" || message.role === "assistant" || message.role === "navigation";
}

/** Find the user-visible message that starts the turn containing `index`. */
export function findTurnStartIndex(messages: AgentMessage[], index: number): number {
	for (let i = index; i >= 0; i--) {
		const role = messages[i].role;
		if (role === "user" || role === "navigation") {
			return i;
		}
	}
	return -1;
}

/** Find the cut point that keeps approximately `keepRecentTokens` of recent messages. */
export function findCutPoint(messages: AgentMessage[], keepRecentTokens: number): CutPoint {
	const cutPoints: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (isValidCutMessage(messages[i])) {
			cutPoints.push(i);
		}
	}
	if (cutPoints.length === 0) {
		return { firstKeptIndex: 0, turnStartIndex: -1, isSplitTurn: false };
	}

	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0];
	for (let i = messages.length - 1; i >= 0; i--) {
		accumulatedTokens += estimateTokens(messages[i]);
		if (accumulatedTokens >= keepRecentTokens) {
			for (const candidate of cutPoints) {
				if (candidate >= i) {
					cutIndex = candidate;
					break;
				}
			}
			break;
		}
	}

	const isBoundaryMessage = messages[cutIndex].role === "user" || messages[cutIndex].role === "navigation";
	const turnStartIndex = isBoundaryMessage ? -1 : findTurnStartIndex(messages, cutIndex);
	return {
		firstKeptIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isBoundaryMessage && turnStartIndex !== -1,
	};
}

// ============================================================================
// SUMMARIZATION PROMPTS (ported from pi 0.87.1)
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact URLs, page states, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact URLs, page states, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact URLs, page states, function names, and error messages.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

// ============================================================================
// CONVERSATION SERIALIZATION (ported from pi 0.87.1 compaction/utils.js)
// ============================================================================

function contentText(content: TextishContent, defaultValue = ""): string {
	if (typeof content === "string") {
		return content || defaultValue;
	}
	const text = content
		.filter((block) => block.type === "text" && block.text)
		.map((block) => block.text as string)
		.join("\n");
	return text || defaultValue;
}

const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/** Serialize LLM messages to plain text for summarization prompts. */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const content = contentText(msg.content);
			if (content) {
				parts.push(`[User]: ${content}`);
			}
		} else if (msg.role === "assistant") {
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];
			for (const block of msg.content) {
				if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const argsStr = Object.entries(block.arguments)
						.map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}
			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (msg.content.some((block) => block.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = contentText(msg.content as TextishContent);
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}
	return parts.join("\n\n");
}

// ============================================================================
// COMPACTION
// ============================================================================

export interface CompactionPreparation {
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	retainedTail: AgentMessage[];
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary?: string;
	settings: CompactionSettings;
}

/**
 * Split the flat message list into the part to summarize and the retained tail,
 * or return null when there is nothing to compact (empty input, no cut point,
 * or a compaction summary is already the newest message).
 */
export function prepareCompaction(
	messages: AgentMessage[],
	settings: CompactionSettings,
): CompactionPreparation | null {
	if (messages.length === 0) return null;

	// Find the last compaction summary message; only messages after it are compactable.
	let prevCompactionIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}
	if (prevCompactionIndex === messages.length - 1) return null;

	const previousSummary =
		prevCompactionIndex >= 0 ? (messages[prevCompactionIndex] as { summary: string }).summary : undefined;
	const compactable = prevCompactionIndex >= 0 ? messages.slice(prevCompactionIndex + 1) : messages;
	if (compactable.length === 0) return null;

	const tokensBefore = estimateContextTokens(messages).tokens;
	const cutPoint = findCutPoint(compactable, settings.keepRecentTokens);
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptIndex;

	const messagesToSummarize = compactable.slice(0, historyEnd);
	const turnPrefixMessages = cutPoint.isSplitTurn
		? compactable.slice(cutPoint.turnStartIndex, cutPoint.firstKeptIndex)
		: [];
	const retainedTail = compactable.slice(cutPoint.firstKeptIndex);

	// A summarize set containing only UI-only messages (welcome, artifact)
	// converts to an empty LLM conversation - the summary model would receive
	// nothing and produce a hollow template. Treat as nothing to compact.
	const hasLlmVisible = (list: AgentMessage[]): boolean =>
		list.some((message) => {
			const role = message.role;
			return role === "user" || role === "assistant" || role === "toolResult" || role === "navigation";
		});
	if (!hasLlmVisible(messagesToSummarize) && !hasLlmVisible(turnPrefixMessages)) {
		return null;
	}

	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return null;

	return {
		messagesToSummarize,
		turnPrefixMessages,
		retainedTail,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		settings,
	};
}

// ============================================================================
// LLM REQUEST BOUNDARY
// ============================================================================

export interface SummaryRequestInput {
	systemPrompt: string;
	messages: Message[];
	maxTokens: number;
	/** Streaming progress: receives the cumulative summary text so far (reset per retry attempt). */
	onDelta?: (text: string) => void;
}

export interface SummaryRequestResult {
	text: string;
	usage?: Usage;
	stopReason: AssistantMessage["stopReason"];
	errorMessage?: string;
}

/** Caller-owned one-request boundary so the algorithm stays free of provider code. */
export type SummaryRequest = (input: SummaryRequestInput) => Promise<SummaryRequestResult>;

export interface CompactionOptions {
	model: Model<any>;
	/** Agent-state thinking level includes "off". */
	thinkingLevel?: ThinkingLevel | "off";
	customInstructions?: string;
	/** LLM-shaped message conversion (sitegeist's browserMessageTransformer). */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** Live summary preview for the UI; receives cumulative text across all summarization steps. */
	onSummaryDelta?: (text: string) => void;
}

export interface CompactionResult {
	summary: string;
	tokensBefore: number;
	usage?: Usage;
	retainedTail: AgentMessage[];
}

function resolveMaxTokens(reserveTokens: number, model: Model<any>, fraction: number): number {
	const budget = Math.floor(fraction * reserveTokens);
	return model.maxTokens > 0 ? Math.min(budget, model.maxTokens) : budget;
}

async function summarizeMessages(
	messages: AgentMessage[],
	prompt: string,
	previousSummary: string | undefined,
	options: CompactionOptions,
	maxTokens: number,
	request: SummaryRequest,
	onDelta?: (text: string) => void,
): Promise<{ text: string; usage?: Usage }> {
	const llmMessages = await options.convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	if (conversationText.trim().length === 0) {
		throw new Error("Nothing to summarize: the message set has no LLM-visible content");
	}
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary !== undefined) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += prompt;

	const response = await request({
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: promptText }],
				timestamp: Date.now(),
			},
		],
		maxTokens,
		onDelta,
	});

	if (response.stopReason === "aborted") {
		throw new Error(response.errorMessage || "Summarization aborted");
	}
	if (response.stopReason === "error") {
		throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
	}
	return { text: response.text, usage: response.usage };
}

/** Generate the compaction summary and return the data needed to rebuild context. */
export async function compact(
	preparation: CompactionPreparation,
	options: CompactionOptions,
	request: SummaryRequest,
): Promise<CompactionResult> {
	const {
		messagesToSummarize,
		turnPrefixMessages,
		retainedTail,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		settings,
	} = preparation;
	const { model } = options;
	const basePrompt = options.customInstructions
		? `${SUMMARIZATION_PROMPT}\n\nAdditional focus: ${options.customInstructions}`
		: SUMMARIZATION_PROMPT;

	// Stitch streamed previews across summarization steps so the live text
	// matches the final summary shape (history + separator + turn prefix)
	let streamedBase = "";
	const makeOnDelta = () =>
		options.onSummaryDelta
			? (text: string) => {
					options.onSummaryDelta!(`${streamedBase}${text}`);
				}
			: undefined;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		let historyText = "No prior history.";
		let historyUsage: Usage | undefined;
		if (messagesToSummarize.length > 0) {
			const history = await summarizeMessages(
				messagesToSummarize,
				basePrompt,
				previousSummary,
				options,
				resolveMaxTokens(settings.reserveTokens, model, 0.8),
				request,
				makeOnDelta(),
			);
			historyText = history.text;
			historyUsage = history.usage;
		}
		streamedBase = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n`;
		const turnPrefix = await summarizeMessages(
			turnPrefixMessages,
			TURN_PREFIX_SUMMARIZATION_PROMPT,
			undefined,
			options,
			resolveMaxTokens(settings.reserveTokens, model, 0.5),
			request,
			makeOnDelta(),
		);
		const summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefix.text}`;
		return { summary, tokensBefore, usage: turnPrefix.usage ?? historyUsage, retainedTail };
	}

	const result = await summarizeMessages(
		messagesToSummarize,
		basePrompt,
		previousSummary,
		options,
		resolveMaxTokens(settings.reserveTokens, model, 0.8),
		request,
		makeOnDelta(),
	);
	return { summary: result.text, tokensBefore, usage: result.usage, retainedTail };
}
